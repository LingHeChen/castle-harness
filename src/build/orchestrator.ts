import { $ } from "bun";
import { think, work } from "../core/subagent";
import { Tracer } from "../core/trace";
import type { AgentEvent } from "../core/events";
import { IntentSchema, TaskGraphSchema, AuditVerdictSchema, type Intent, type Task } from "./schemas";
import { toWaves } from "./graph";
import { isGitRepo, ensureCommitted, addWorktree, mergeWorktree, removeWorktree } from "./worktree";
import type { BuildEmit } from "./events";

export type BuildOptions = {
  cwd: string;
  model?: string;
  autonomous: boolean; // skip interactive clarification, proceed on assumptions
  maxFixAttempts: number;
  maxAuditAttempts: number; // times an auditor can send weak tests back to be rewritten
  confidenceThreshold: number;
  emit: BuildEmit;
  /** Interactive clarification callback (CLI). Omitted → treated as autonomous. */
  ask?: (question: string, why: string) => string | null;
};

export type TaskOutcome = { task: Task; passed: boolean; attempts: number; detail: string };

const TEST_DIR = "acceptance";

/** The full plan→test→build→verify pipeline. Emits {@link BuildEvent}s throughout. */
export async function build(goal: string, opts: BuildOptions): Promise<TaskOutcome[]> {
  const { emit } = opts;
  if (!(await isGitRepo(opts.cwd))) {
    throw new Error("castle build needs a git repository (worktrees are used for parallel dev). Run `git init` first.");
  }

  const intent = await understand(goal, opts);
  const tasks = await decompose(intent, opts);
  const waves = toWaves(tasks);
  emit({
    type: "graph",
    tasks: tasks.map((t) => ({ id: t.id, title: t.title, dependsOn: t.dependsOn, files: t.files })),
    waves: waves.map((w) => w.map((t) => t.id)),
  });
  emit({ type: "log", message: `Decomposed into ${tasks.length} tasks across ${waves.length} waves.` });

  await writeAndAuditTests(tasks, opts);
  await ensureCommitted(opts.cwd, "castle: acceptance tests");

  await develop(waves, opts);

  const outcomes = await accept(tasks, opts);
  emit({
    type: "report",
    outcomes: outcomes.map((o) => ({ id: o.task.id, passed: o.passed, attempts: o.attempts, detail: o.detail })),
  });
  emit({ type: "done" });
  return outcomes;
}

// ── Phase 1: Understand ──────────────────────────────────────────────
async function understand(goal: string, opts: BuildOptions): Promise<Intent> {
  opts.emit({ type: "phase", n: 1, title: "understand" });
  const intent = await think({
    model: opts.model,
    schema: IntentSchema,
    system:
      "You are a meticulous requirements analyst. Expand the user's possibly-vague goal " +
      "into a precise intent. Be pessimistic: whenever anything material is ambiguous, add " +
      "a clarifying question instead of guessing. Only claim high confidence when the goal is unambiguous.",
    prompt: `User goal:\n${goal}`,
  });

  const needsClarification = intent.confidence < opts.confidenceThreshold || intent.clarifications.length > 0;
  opts.emit({
    type: "intent",
    expandedIntent: intent.expandedIntent,
    assumptions: intent.assumptions,
    confidence: intent.confidence,
    needsClarification,
  });

  if (!needsClarification || opts.autonomous || !opts.ask) return intent;

  // Interactive: ask the user, fold answers into the intent.
  const answers: string[] = [];
  for (const c of intent.clarifications) {
    const ans = opts.ask(c.question, c.why);
    if (ans && ans.trim()) answers.push(`Q: ${c.question}\nA: ${ans.trim()}`);
  }
  if (answers.length === 0) return intent;
  return { ...intent, expandedIntent: `${intent.expandedIntent}\n\nClarifications:\n${answers.join("\n")}`, clarifications: [] };
}

// ── Phase 2: Decompose ───────────────────────────────────────────────
async function decompose(intent: Intent, opts: BuildOptions): Promise<Task[]> {
  opts.emit({ type: "phase", n: 2, title: "decompose" });
  const { tasks } = await think({
    model: opts.model,
    schema: TaskGraphSchema,
    system:
      "You are a tech lead. Break the intent into the smallest set of atomic, independently " +
      "testable tasks. Each task needs concrete acceptance criteria. Use `dependsOn` to encode " +
      "ordering and `files` to declare what each task touches — tasks that can run in parallel " +
      "MUST NOT share files. Prefer more small tasks over few large ones.",
    prompt: `Intent:\n${intent.expandedIntent}\n\nAssumptions:\n${intent.assumptions.join("\n")}`,
  });
  return tasks;
}

// ── Phase 3: Acceptance tests + isolated audit (with revise loop) ────
async function writeAndAuditTests(tasks: Task[], opts: BuildOptions): Promise<void> {
  opts.emit({ type: "phase", n: 3, title: "acceptance tests + audit" });
  for (const t of tasks) await writeAndAuditOne(t, opts);
}

async function writeAndAuditOne(t: Task, opts: BuildOptions): Promise<void> {
  const testPath = `${TEST_DIR}/${t.id}.test.ts`;
  const criteria = t.acceptanceCriteria.map((c) => `- ${c}`).join("\n");
  const testerSystem =
    "You are a test engineer practising TDD. You write acceptance tests that pin down behaviour. " +
    "You never write implementation code — only tests. Encode every acceptance criterion as a concrete assertion.";

  opts.emit({ type: "task-status", taskId: t.id, status: "testing" });
  await work(
    `Write acceptance tests ONLY (do not implement the feature) for this task, at ${testPath}.\n\n` +
      `Task: ${t.title}\n${t.description}\n\nAcceptance criteria:\n${criteria}\n\n` +
      `Files the implementation will live in: ${t.files.join(", ")}. Import from there. ` +
      `Use bun:test. Each criterion must be a real assertion. The tests should FAIL now (no implementation yet).`,
    { cwd: opts.cwd, model: opts.model, maxSteps: 12, tracer: new Tracer(".castle/traces", `build-test-${t.id}`), system: testerSystem, onEvent: (ev) => emitActivity(opts, t.id, "test", ev) },
  );

  let verdict = await auditTests(t, testPath, opts);
  opts.emit({ type: "audit", taskId: t.id, sound: verdict.sound, canFalsePass: verdict.canFalsePass, issues: verdict.issues });

  // Revise loop: the auditor's a gate, not a comment. Weak tests get sent back.
  let attempt = 0;
  while ((!verdict.sound || verdict.canFalsePass) && attempt < opts.maxAuditAttempts) {
    attempt++;
    opts.emit({ type: "task-status", taskId: t.id, status: "revising", detail: `audit attempt ${attempt}` });
    await work(
      `An independent auditor flagged your acceptance tests at ${testPath} as weak. Strengthen them so they ` +
        `genuinely verify the criteria and cannot false-pass. Keep them tests only (no implementation).\n\n` +
        `Acceptance criteria:\n${criteria}\n\nAuditor issues:\n${verdict.issues.map((i) => `- ${i}`).join("\n")}\n` +
        `Auditor suggestions:\n${verdict.suggestions.map((s) => `- ${s}`).join("\n")}`,
      { cwd: opts.cwd, model: opts.model, maxSteps: 12, tracer: new Tracer(".castle/traces", `build-test-${t.id}-rev${attempt}`), system: testerSystem, onEvent: (ev) => emitActivity(opts, t.id, "revise", ev) },
    );
    verdict = await auditTests(t, testPath, opts);
    opts.emit({ type: "audit", taskId: t.id, sound: verdict.sound, canFalsePass: verdict.canFalsePass, issues: verdict.issues });
  }
  opts.emit({ type: "task-status", taskId: t.id, status: "audited" });
}

/** Context-isolated auditor: sees only the task + the test file, never the writer's reasoning. */
async function auditTests(t: Task, testPath: string, opts: BuildOptions) {
  const testCode = await Bun.file(`${opts.cwd}/${testPath}`).text().catch(() => "");
  if (!testCode) return { sound: false, canFalsePass: true, issues: [`no test file at ${testPath}`], suggestions: [] };
  return await think({
    model: opts.model,
    schema: AuditVerdictSchema,
    system:
      "You are an adversarial test auditor with NO prior context. Given a task's acceptance criteria " +
      "and its test code, judge whether the tests genuinely verify the criteria and whether they could " +
      "FALSE-PASS without a correct implementation (tautological assertions, mocked-away logic, happy-path only).",
    prompt: `Acceptance criteria:\n${t.acceptanceCriteria.join("\n")}\n\nTest code (${testPath}):\n${testCode}`,
  });
}

// ── Phase 4: Parallel development in worktrees ───────────────────────
async function develop(waves: Task[][], opts: BuildOptions): Promise<void> {
  opts.emit({ type: "phase", n: 4, title: "develop (parallel, worktree-isolated)" });
  for (let w = 0; w < waves.length; w++) {
    const wave = waves[w]!;
    opts.emit({ type: "wave", index: w + 1, taskIds: wave.map((t) => t.id) });

    const built = await Promise.all(
      wave.map(async (t) => {
        opts.emit({ type: "task-status", taskId: t.id, status: "developing" });
        const wt = await addWorktree(opts.cwd, t.id);
        await work(
          `Implement this task so its acceptance tests pass. Run \`bun test ${TEST_DIR}/${t.id}.test.ts\` to check.\n\n` +
            `Task: ${t.title}\n${t.description}\n\nAcceptance criteria:\n${t.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}\n\n` +
            `Work only in files: ${t.files.join(", ")}. Do NOT edit the test file.`,
          {
            cwd: wt.dir,
            model: opts.model,
            maxSteps: 30,
            tracer: new Tracer(".castle/traces", `build-dev-${t.id}`),
            onEvent: (ev) => emitActivity(opts, t.id, "dev", ev),
          },
        );
        return { task: t, wt };
      }),
    );

    // Merge sequentially (single index on the main tree); disjoint files → clean.
    for (const { task, wt } of built) {
      const res = await mergeWorktree(opts.cwd, wt);
      opts.emit({
        type: "task-status",
        taskId: task.id,
        status: res.merged ? "merged" : "merge-conflict",
        detail: res.reason,
      });
      await removeWorktree(opts.cwd, wt);
    }
  }
}

// ── Phase 5: Acceptance + honest reporting ───────────────────────────
async function accept(tasks: Task[], opts: BuildOptions): Promise<TaskOutcome[]> {
  opts.emit({ type: "phase", n: 5, title: "acceptance" });
  const outcomes: TaskOutcome[] = [];

  for (const t of tasks) {
    let attempt = 0;
    let result = await runAcceptance(opts.cwd, t.id);

    while (!result.pass && attempt < opts.maxFixAttempts) {
      attempt++;
      opts.emit({ type: "task-status", taskId: t.id, status: "fixing", detail: `attempt ${attempt}/${opts.maxFixAttempts}` });
      await work(
        `The acceptance tests for this task are failing. Fix the IMPLEMENTATION (never the tests) so ` +
          `\`bun test ${TEST_DIR}/${t.id}.test.ts\` passes.\n\nTask: ${t.title}\n\nTest output:\n${result.output}`,
        {
          cwd: opts.cwd,
          model: opts.model,
          maxSteps: 25,
          tracer: new Tracer(".castle/traces", `build-fix-${t.id}-${attempt}`),
          onEvent: (ev) => emitActivity(opts, t.id, "fix", ev),
        },
      );
      result = await runAcceptance(opts.cwd, t.id);
    }

    outcomes.push({ task: t, passed: result.pass, attempts: attempt, detail: result.pass ? "acceptance passed" : lastLines(result.output, 8) });
    opts.emit({ type: "task-status", taskId: t.id, status: result.pass ? "passing" : "failing", detail: result.pass ? undefined : lastLines(result.output, 4) });
  }
  return outcomes;
}

async function runAcceptance(cwd: string, id: string): Promise<{ pass: boolean; output: string }> {
  const res = await $`bun test ${TEST_DIR}/${id}.test.ts`.cwd(cwd).nothrow().quiet();
  const output = res.stdout.toString() + res.stderr.toString();
  return { pass: res.exitCode === 0, output };
}

function emitActivity(opts: BuildOptions, taskId: string, kind: string, ev: AgentEvent): void {
  if (ev.type === "tool-call") opts.emit({ type: "activity", taskId, kind, action: ev.name });
  else if (ev.type === "error") opts.emit({ type: "activity", taskId, kind, action: `error: ${ev.message}` });
}

function lastLines(text: string, n: number): string {
  return text.trim().split("\n").slice(-n).join("\n");
}
