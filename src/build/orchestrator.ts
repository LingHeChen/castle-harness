import { $ } from "bun";
import { think, work } from "../core/subagent";
import { OUTPUT_ZH } from "../core/prompt";
import { pool } from "../core/util";
import { Tracer } from "../core/trace";
import type { AgentEvent } from "../core/events";
import { IntentSchema, AuditVerdictSchema, type Intent, type Task } from "./schemas";
import { recursiveDecompose, type DecomposeResult } from "./decompose";
import { type TaskNode } from "./tree";
import { toWaves } from "./graph";
import { ensureRepo, ensureCommitted, addWorktree, mergeWorktree, removeWorktree } from "./worktree";
import { newBuildId, BuildLog, type BuildRecord } from "./store";
import { openBuildStore, type BuildStore } from "./db";
import type { BuildEmit, BuildTreeNode } from "./events";
import { buildOwnership } from "./shared-edit";
import { SharedEditCoordinator } from "./coordinator";
import { runIntegration } from "./integration";

export type BuildOptions = {
  cwd: string;
  model?: string;
  maxFixAttempts: number;
  maxAuditAttempts: number; // times an auditor can send weak tests back to be rewritten
  maxDepth: number; // recursion depth cap for decomposition
  confidenceThreshold: number;
  /** Run the integration gate (phase 6) after unit acceptance. Default true;
   *  auto-skips for a self-contained library with no runnable app. */
  integration?: boolean;
  /** Max independent subagents in flight at once (test-writing and same-wave dev).
   *  Default 4 — true parallelism, bounded so we don't hammer the model API. */
  concurrency?: number;
  /** Use this build id instead of generating one (so the caller can show/route to
   *  the build in a UI before it finishes). */
  buildId?: string;
  /** Resume a previous build (identified by buildId): reload its persisted plan and
   *  continue, skipping tasks that already have tests / already pass acceptance. */
  resume?: boolean;
  emit: BuildEmit;
  /** HIL checkpoint 1: ask the user clarifying questions (each with pickable
   *  options, Claude-Code style); returns one answer per question. Omitted → skip
   *  clarification (autonomous). */
  clarify?: (questions: Array<{ question: string; why: string; options: string[] }>) => Promise<string[]>;
  /** HIL checkpoint 2: let the user review/edit the plan before any code is written.
   *  Returns the (possibly edited) task set to execute. Omitted → autonomous. */
  reviewPlan?: (tasks: Task[], tree: BuildTreeNode) => Promise<Task[]>;
};

export type TaskOutcome = { task: Task; passed: boolean; attempts: number; detail: string };

const TEST_DIR = "acceptance";

/** The full plan→test→build→verify pipeline. Emits {@link BuildEvent}s throughout. */
export async function build(goal: string, opts: BuildOptions, now = Date.now()): Promise<TaskOutcome[]> {
  const buildId = opts.buildId ?? newBuildId(now);
  // Persist the whole event stream to disk so a build is inspectable after the
  // fact (.castle/builds/<id>.events.jsonl). Every opts.emit — including from
  // develop/accept/integration — flows through this wrapper.
  const log = new BuildLog(opts.cwd, buildId);
  const store = openBuildStore(opts.cwd);
  // Tee events to disk + forward to the caller. `tee` takes the downstream emit
  // explicitly, so it can't recurse into itself when we rebind opts below.
  opts = { ...opts, emit: log.tee(opts.emit) };

  try {
    return await runPipeline(goal, opts, buildId, now, store);
  } finally {
    log.close();
    store.close();
  }
}

async function runPipeline(goal: string, opts: BuildOptions, buildId: string, now: number, store: BuildStore): Promise<TaskOutcome[]> {
  const { emit } = opts;
  // From nothing: an empty or non-git target is bootstrapped (git init + minimal
  // Bun/TS scaffold + initial commit) so worktree-based parallel dev just works.
  const boot = await ensureRepo(opts.cwd);
  if (boot.bootstrapped) emit({ type: "log", message: `已在空目录初始化项目（git init + 脚手架）：${opts.cwd}` });

  // Every build + every task is persisted (with its id) through the store adapter
  // (SQLite today; swappable for Postgres later behind the same interface).
  const resuming = opts.resume === true;
  const record: BuildRecord = resuming ? loadForResume(store, buildId) : { id: buildId, createdAt: now, goal };
  const persist = () => store.saveBuild(record);

  let plan: Task[];
  if (resuming) {
    // Skip understand/decompose/review — reuse the persisted plan, continue from
    // whatever already landed on disk (idempotent phases skip finished work).
    plan = record.tasks!;
    if (record.tree) emit({ type: "tree", tree: record.tree });
    emitGraph(emit, plan);
    emit({ type: "log", message: `续跑构建 ${buildId}：复用已保存的 ${plan.length} 个任务，跳过已完成的部分。` });
  } else {
    const intent = await understand(goal, opts);
    record.intent = intent.expandedIntent;
    await persist();

    const { tree, tasks } = await decompose(intent, opts);
    const buildTree = toBuildTree(tree);
    emit({ type: "tree", tree: buildTree });
    emitGraph(emit, tasks);
    emit({ type: "log", message: `分解出 ${tasks.length} 个叶子任务，审阅计划后继续。` });
    record.tree = buildTree;

    // HIL checkpoint: let the user review/edit the DAG before any code is written.
    plan = tasks;
    if (opts.reviewPlan) {
      plan = await opts.reviewPlan(tasks, buildTree);
      emitGraph(emit, plan); // re-emit the approved (possibly edited) plan
    }
    record.tasks = plan;
    await persist();
  }
  const waves = toWaves(plan);

  await writeAndAuditTests(plan, opts, resuming);
  await ensureCommitted(opts.cwd, "castle: acceptance tests");

  // Single ownership map for the whole build: contract files have one owner, and
  // any write to a file a task doesn't own is routed through the shared-edit
  // protocol instead of landing as a raw edit.
  const coord = new SharedEditCoordinator(buildOwnership(plan), emit);
  const contracts = plan.filter((t) => t.kind === "contract").length;
  if (contracts > 0) emit({ type: "log", message: `${contracts} contract task(s) frozen first; shared edits go through the coordinated protocol.` });

  await develop(waves, opts, coord, resuming);

  const outcomes = await accept(plan, opts);
  record.outcomes = outcomes.map((o) => ({ id: o.task.id, passed: o.passed, attempts: o.attempts, detail: o.detail }));
  await persist();
  emit({ type: "report", outcomes: record.outcomes });

  // Phase 6: the integration gate, above the per-task unit gate. Bring the app up,
  // exercise its seams end-to-end, tear it down. Auto-skips for a plain library.
  if (opts.integration !== false) {
    // On resume we don't re-run understand, so build the intent from the record.
    const intentForGate: Intent = { expandedIntent: record.intent ?? goal, assumptions: [], confidence: 1, clarifications: [] };
    const integration = await runIntegration(intentForGate, plan, {
      cwd: opts.cwd,
      model: opts.model,
      emit,
      maxFixAttempts: opts.maxFixAttempts,
    });
    record.integration = integration;
    await persist();
  }

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
      "a clarifying question instead of guessing. For EACH clarifying question, provide 2–4 concrete, " +
      "mutually-exclusive options the user can pick from (they can also answer freely). Only claim high " +
      "confidence when the goal is unambiguous." +
      OUTPUT_ZH,
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

  if (!needsClarification || !opts.clarify) return intent;

  // Interactive: ask the user, fold answers into the intent.
  const answers = await opts.clarify(intent.clarifications);
  const folded = intent.clarifications
    .map((c, i) => (answers[i]?.trim() ? `Q: ${c.question}\nA: ${answers[i]!.trim()}` : ""))
    .filter(Boolean);
  if (folded.length === 0) return intent;
  return { ...intent, expandedIntent: `${intent.expandedIntent}\n\nClarifications:\n${folded.join("\n")}`, clarifications: [] };
}

// ── Phase 2: Recursive decompose ─────────────────────────────────────
async function decompose(intent: Intent, opts: BuildOptions): Promise<DecomposeResult> {
  opts.emit({ type: "phase", n: 2, title: "decompose (recursive)" });
  return recursiveDecompose(intent, {
    model: opts.model,
    maxDepth: opts.maxDepth,
    onNode: (n) => opts.emit({ type: "node", id: n.id, title: n.title, depth: n.depth, leaf: n.leaf }),
  });
}

/** Serialize the decomposition tree for the UI (drops leaf-only detail). */
function toBuildTree(node: TaskNode): BuildTreeNode {
  return { id: node.id, title: node.title, leaf: node.children.length === 0, children: node.children.map(toBuildTree) };
}

/** Emit a graph event with waves computed from the given task set. */
function emitGraph(emit: BuildOptions["emit"], tasks: Task[]): void {
  const waves = toWaves(tasks);
  emit({
    type: "graph",
    tasks: tasks.map((t) => ({ id: t.id, title: t.title, dependsOn: t.dependsOn, files: t.files, kind: t.kind })),
    waves: waves.map((w) => w.map((t) => t.id)),
  });
}

/** Load a previous build's record for resume, or fail loudly if it can't continue. */
function loadForResume(store: BuildStore, buildId: string): BuildRecord {
  const prev = store.getBuild(buildId);
  if (!prev) throw new Error(`无法续跑：找不到构建 ${buildId}`);
  if (!prev.tasks || prev.tasks.length === 0) throw new Error(`无法续跑：构建 ${buildId} 没有已保存的任务计划`);
  return prev;
}

// ── Phase 3: Acceptance tests + isolated audit (with revise loop) ────
async function writeAndAuditTests(tasks: Task[], opts: BuildOptions, resuming = false): Promise<void> {
  opts.emit({ type: "phase", n: 3, title: "acceptance tests + audit" });
  // On resume, skip tasks whose acceptance test file already exists on disk.
  const todo = resuming ? await filterAsync(tasks, async (t) => !(await testExists(opts.cwd, t.id))) : tasks;
  for (const t of tasks) if (resuming && !todo.includes(t)) opts.emit({ type: "task-status", taskId: t.id, status: "audited" });
  // Each task writes its OWN test file (disjoint) → safe to run truly in parallel.
  await pool(todo, concurrencyOf(opts), (t) => writeAndAuditOne(t, opts));
}

function testExists(cwd: string, id: string): Promise<boolean> {
  return Bun.file(`${cwd}/${TEST_DIR}/${id}.test.ts`).exists();
}

async function filterAsync<T>(items: T[], pred: (t: T) => Promise<boolean>): Promise<T[]> {
  const keep = await Promise.all(items.map(pred));
  return items.filter((_, i) => keep[i]);
}

/** Resolve the bounded-concurrency limit (default 4). */
function concurrencyOf(opts: BuildOptions): number {
  return Math.max(1, opts.concurrency ?? 4);
}

async function writeAndAuditOne(t: Task, opts: BuildOptions): Promise<void> {
  const testPath = `${TEST_DIR}/${t.id}.test.ts`;
  const criteria = t.acceptanceCriteria.map((c) => `- ${c}`).join("\n");
  const testerSystem =
    "You are a test engineer practising TDD. You write acceptance tests that pin down behaviour. " +
    "You never write implementation code — only tests. Encode every acceptance criterion as a concrete assertion." +
    OUTPUT_ZH;

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
      "FALSE-PASS without a correct implementation (tautological assertions, mocked-away logic, happy-path only)." +
      OUTPUT_ZH,
    prompt: `Acceptance criteria:\n${t.acceptanceCriteria.join("\n")}\n\nTest code (${testPath}):\n${testCode}`,
  });
}

// ── Phase 4: Parallel development in worktrees ───────────────────────
async function develop(waves: Task[][], opts: BuildOptions, coord: SharedEditCoordinator, resuming = false): Promise<void> {
  opts.emit({ type: "phase", n: 4, title: "develop (parallel, worktree-isolated)" });
  const byId = new Map(waves.flat().map((t) => [t.id, t]));
  const completed = new Set<string>();

  for (let w = 0; w < waves.length; w++) {
    let wave = waves[w]!;
    opts.emit({ type: "wave", index: w + 1, taskIds: wave.map((t) => t.id) });

    // On resume, a task whose acceptance ALREADY passes is done — skip building it.
    if (resuming) {
      const stillOpen: Task[] = [];
      for (const t of wave) {
        if ((await runAcceptance(opts.cwd, t.id)).pass) {
          completed.add(t.id);
          opts.emit({ type: "task-status", taskId: t.id, status: "passing", detail: "续跑：已通过，跳过" });
        } else {
          stillOpen.push(t);
        }
      }
      wave = stillOpen;
    }

    // 1) Create worktrees SEQUENTIALLY: `git worktree add` takes the repo index
    //    lock, so doing this concurrently races on .git/index.lock. Cheap setup.
    const built: Array<{ task: Task; wt: Awaited<ReturnType<typeof addWorktree>> }> = [];
    for (const t of wave) {
      opts.emit({ type: "task-status", taskId: t.id, status: "developing" });
      built.push({ task: t, wt: await addWorktree(opts.cwd, t.id) });
    }

    // 2) Run the dev agents TRULY in parallel (bounded): each works in its own
    //    worktree, so there's no shared mutable state between them.
    await pool(built, concurrencyOf(opts), async ({ task: t, wt }) => {
      const ownFiles = t.files.length > 0 ? t.files.join(", ") : "(none declared — create what the task needs)";
      await work(
        `Implement this task so its acceptance tests pass. Run \`bun test ${TEST_DIR}/${t.id}.test.ts\` to check.\n\n` +
          `Task: ${t.title}\n${t.description}\n\nAcceptance criteria:\n${t.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}\n\n` +
          `You own these files: ${ownFiles}. Do NOT edit the test file. If you must change a file you don't own ` +
          `(a shared/contract file), just write it — the harness intercepts that write and coordinates it safely.`,
        {
          cwd: wt.dir,
          model: opts.model,
          maxSteps: 30,
          tracer: new Tracer(".castle/traces", `build-dev-${t.id}`),
          onEvent: (ev) => emitActivity(opts, t.id, "dev", ev),
          guard: coord.guardFor(t.id, wt.dir), // route non-owned writes through the protocol
        },
      );
    });

    // Merge sequentially (single index on the main tree); disjoint files → clean.
    for (const { task, wt } of built) {
      const res = await mergeWorktree(opts.cwd, wt);
      opts.emit({
        type: "task-status",
        taskId: task.id,
        status: res.merged ? "merged" : "merge-conflict",
        detail: res.reason,
      });
      if (res.merged) completed.add(task.id);
      await removeWorktree(opts.cwd, wt);
    }

    // Semantic ripple: shared files changed during this wave may have invalidated
    // the code of dependents that already merged. Re-verify those, fix what broke.
    await rippleAfterWave(coord, byId, completed, opts);
  }
}

/**
 * The semantic half of the shared-edit protocol. After a wave merges, any shared
 * file changed during it can break dependents built against the old version. We
 * re-run the acceptance of every *already-merged* dependent and, for the ones that
 * now fail, spawn a fix-agent (the same loop the acceptance phase uses). Dependents
 * that haven't been built yet need no action — they'll build against the new
 * version. This is "edit the shared file, then fix everything it touched."
 */
async function rippleAfterWave(
  coord: SharedEditCoordinator,
  byId: Map<string, Task>,
  completed: Set<string>,
  opts: BuildOptions,
): Promise<void> {
  // Compute dependents BEFORE draining (drainTouched resets the per-wave record).
  const dependents = coord.dependentsToVerify();
  const touched = coord.drainTouched();
  if (touched.size === 0) return;

  const affected = [...dependents].filter((id) => completed.has(id) && byId.has(id));
  for (const file of touched.keys()) {
    opts.emit({ type: "ripple", file, dependents: affected });
  }
  // Re-verify (and fix) each affected dependent once, against the merged tree.
  for (const id of affected) {
    const task = byId.get(id)!;
    opts.emit({ type: "task-status", taskId: id, status: "rippling", detail: "re-verifying against changed shared code" });
    await verifyAndFix(task, opts, "ripple");
  }
}

/**
 * Re-run a task's acceptance and, on failure, fix the implementation in a bounded
 * loop. Shared by the acceptance phase and the shared-edit ripple, so both use the
 * identical "tests are the judge, model never edits the tests" fix protocol.
 */
async function verifyAndFix(task: Task, opts: BuildOptions, kind: "fix" | "ripple"): Promise<TaskOutcome> {
  let attempt = 0;
  let result = await runAcceptance(opts.cwd, task.id);
  while (!result.pass && attempt < opts.maxFixAttempts) {
    attempt++;
    opts.emit({ type: "task-status", taskId: task.id, status: "fixing", detail: `${kind} attempt ${attempt}/${opts.maxFixAttempts}` });
    const why =
      kind === "ripple"
        ? "A shared/contract file this task depends on changed, and its acceptance tests now fail."
        : "The acceptance tests for this task are failing.";
    await work(
      `${why} Fix the IMPLEMENTATION (never the tests) so \`bun test ${TEST_DIR}/${task.id}.test.ts\` passes.\n\n` +
        `Task: ${task.title}\n\nTest output:\n${result.output}`,
      {
        cwd: opts.cwd,
        model: opts.model,
        maxSteps: 25,
        tracer: new Tracer(".castle/traces", `build-${kind}-${task.id}-${attempt}`),
        onEvent: (ev) => emitActivity(opts, task.id, kind, ev),
      },
    );
    result = await runAcceptance(opts.cwd, task.id);
  }
  if (kind === "ripple") {
    await ensureCommitted(opts.cwd, `castle: ripple-fix ${task.id}`);
    opts.emit({ type: "task-status", taskId: task.id, status: result.pass ? "merged" : "failing", detail: result.pass ? "ripple re-verified" : lastLines(result.output, 4) });
  }
  return { task, passed: result.pass, attempts: attempt, detail: result.pass ? "acceptance passed" : lastLines(result.output, 8) };
}

// ── Phase 5: Acceptance + honest reporting ───────────────────────────
async function accept(tasks: Task[], opts: BuildOptions): Promise<TaskOutcome[]> {
  opts.emit({ type: "phase", n: 5, title: "acceptance" });
  const outcomes: TaskOutcome[] = [];

  for (const t of tasks) {
    const outcome = await verifyAndFix(t, opts, "fix");
    outcomes.push(outcome);
    opts.emit({ type: "task-status", taskId: t.id, status: outcome.passed ? "passing" : "failing", detail: outcome.passed ? undefined : lastLines(outcome.detail, 4) });
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
