import { $ } from "bun";
import { think, work } from "../core/subagent";
import { OUTPUT_ZH } from "../core/prompt";
import { Tracer } from "../core/trace";
import type { AgentEvent } from "../core/events";
import { IntegrationPlanSchema, type IntegrationPlan, type Intent, type Task } from "./schemas";
import { startServer, freePort, ServerStartError } from "./testenv";
import type { BuildEmit } from "./events";

/**
 * Phase 6 — the integration gate.
 *
 * Per-task unit acceptance proves each piece in isolation; this proves they work
 * *together*. It plans how to run the finished app, generates end-to-end tests that
 * hit a live server across the DB↔API↔client seams, brings the environment up
 * (testenv.ts), runs the tests against it, and — on failure — fixes the
 * implementation in a bounded loop. It's a gate above the unit gate: a build that
 * passes every unit test but fails integration is not done.
 *
 * The seam that makes this tractable: the harness owns the server lifecycle, and
 * the generated tests reach the app only through `process.env.CASTLE_BASE_URL`.
 * Tests never start or stop the server themselves — so "bring up / seed / hit /
 * tear down" is one reliable place, not duplicated (and leaked) across test files.
 */

const INT_DIR = "integration";
const BASE_URL_ENV = "CASTLE_BASE_URL";

export type IntegrationReport = {
  applicable: boolean;
  passed: boolean;
  attempts: number;
  scenarios: string[];
  detail: string;
};

export type IntegrationOptions = {
  cwd: string;
  model?: string;
  emit: BuildEmit;
  maxFixAttempts: number;
  timeoutMs?: number;
};

export async function runIntegration(intent: Intent, plan: Task[], opts: IntegrationOptions): Promise<IntegrationReport> {
  opts.emit({ type: "phase", n: 6, title: "integration (live app, end-to-end)" });

  opts.emit({ type: "integration", step: "plan" });
  const iplan = await planIntegration(intent, plan, opts.model);

  if (!iplan.applicable || iplan.startCommand.length === 0) {
    const detail = iplan.reason || "no runnable app surface — unit acceptance is the gate";
    opts.emit({ type: "integration-report", applicable: false, passed: true, attempts: 0, scenarios: [], detail });
    opts.emit({ type: "log", message: `Integration skipped: ${detail}` });
    return { applicable: false, passed: true, attempts: 0, scenarios: [], detail };
  }

  const scenarios = iplan.scenarios.map((s) => s.title);
  opts.emit({ type: "integration", step: "generate", detail: `${scenarios.length} scenario(s)` });
  await generateIntegrationTests(iplan, opts);
  await ensureCommitted(opts.cwd, "castle: integration tests");

  // Run → fix → run, bounded. Each run gets a fresh environment.
  let attempt = 0;
  let result = await runIntegrationOnce(iplan, opts);
  while (!result.pass && attempt < opts.maxFixAttempts) {
    attempt++;
    opts.emit({ type: "integration", step: "fix", detail: `attempt ${attempt}/${opts.maxFixAttempts}` });
    await work(
      `The INTEGRATION tests (a live server exercised end-to-end) are failing. Fix the IMPLEMENTATION — never the ` +
        `tests — so the app behaves correctly across its seams. The tests reach the app via ${BASE_URL_ENV}; the ` +
        `harness starts/stops the server, so don't touch server bootstrap for ports.\n\n` +
        `Scenarios:\n${iplan.scenarios.map((s) => `- ${s.title}: ${s.description}`).join("\n")}\n\n` +
        `Failure output:\n${result.output}`,
      {
        cwd: opts.cwd,
        model: opts.model,
        maxSteps: 30,
        tracer: new Tracer(".castle/traces", `build-integration-fix-${attempt}`),
        onEvent: (ev) => emitActivity(opts.emit, "integration", "fix", ev),
      },
    );
    result = await runIntegrationOnce(iplan, opts);
  }

  const detail = result.pass ? "integration passed" : lastLines(result.output, 10);
  opts.emit({ type: "integration-report", applicable: true, passed: result.pass, attempts: attempt, scenarios, detail });
  return { applicable: true, passed: result.pass, attempts: attempt, scenarios, detail };
}

// ── Plan ─────────────────────────────────────────────────────────────
const PLAN_SYSTEM =
  "You are a release engineer planning integration tests for a just-built app. Decide whether it is a runnable " +
  "app/server with cross-component seams worth end-to-end testing (a web API, a full-stack app) or a self-contained " +
  "library (no server → not applicable). If applicable, give the exact argv to seed (if any) and to START the server " +
  "— the server MUST read its port from the PORT env var — and list the end-to-end scenarios that exercise the real " +
  "seams (API↔DB, full user flows, concurrency). Infer the stack from the files; assume Bun (`bun run <entry>`).";

export async function planIntegration(intent: Intent, plan: Task[], model?: string): Promise<IntegrationPlan> {
  const files = [...new Set(plan.flatMap((t) => t.files))];
  return think({
    model,
    schema: IntegrationPlanSchema,
    system: PLAN_SYSTEM + OUTPUT_ZH,
    prompt:
      `Goal / intent:\n${intent.expandedIntent}\n\n` +
      `Tasks:\n${plan.map((t) => `- ${t.id} [${t.kind}]: ${t.title}`).join("\n")}\n\n` +
      `Files in the build:\n${files.map((f) => `- ${f}`).join("\n")}\n\n` +
      `Plan the integration gate.`,
  });
}

// ── Generate ─────────────────────────────────────────────────────────
async function generateIntegrationTests(iplan: IntegrationPlan, opts: IntegrationOptions): Promise<void> {
  const scenarios = iplan.scenarios.map((s) => `- ${s.title}: ${s.description}`).join("\n");
  await work(
    `Write INTEGRATION tests (only tests — no implementation) under ${INT_DIR}/ using bun:test. They run against a ` +
      `LIVE server the harness has already started; read its base URL from \`process.env.${BASE_URL_ENV}\` and make ` +
      `real HTTP requests to it. Do NOT start or stop a server yourself and do NOT hardcode a port.\n\n` +
      `Cover these end-to-end scenarios, asserting behaviour across the seams (persistence, status codes, error paths, ` +
      `and any concurrency/races):\n${scenarios}\n\n` +
      `Each scenario should be at least one concrete test with real assertions.`,
    {
      cwd: opts.cwd,
      model: opts.model,
      maxSteps: 20,
      tracer: new Tracer(".castle/traces", "build-integration-gen"),
      system:
        "You are a QA engineer writing end-to-end integration tests against a running service. You never write " +
        "implementation code — only tests. You reach the app exclusively over HTTP via the provided base URL." +
        OUTPUT_ZH,
      onEvent: (ev) => emitActivity(opts.emit, "integration", "gen", ev),
    },
  );
}

// ── Run once (env up → test → env down) ──────────────────────────────
/**
 * One integration run: optional seed, bring the server up on a free port, run
 * `bun test integration/` against it (base URL injected via env), tear it down.
 * Exported so the gate mechanics can be tested against a real server without a model.
 */
export async function runIntegrationOnce(iplan: IntegrationPlan, opts: IntegrationOptions): Promise<{ pass: boolean; output: string }> {
  // Optional seed/migrate step before the server boots.
  if (iplan.setupCommand.length > 0) {
    const setup = await $`${iplan.setupCommand}`.cwd(opts.cwd).nothrow().quiet();
    if (setup.exitCode !== 0) {
      return { pass: false, output: `setup command failed:\n${setup.stdout.toString()}${setup.stderr.toString()}` };
    }
  }

  const port = await freePort();
  opts.emit({ type: "integration", step: "up", detail: `${iplan.startCommand.join(" ")} on :${port}` });

  let server;
  try {
    server = await startServer({
      cwd: opts.cwd,
      command: iplan.startCommand,
      port,
      ready: { type: "http", path: iplan.readyPath || "/" },
      timeoutMs: opts.timeoutMs ?? 20_000,
    });
  } catch (err) {
    // A crash-on-boot is an integration failure, with the server output as evidence.
    const detail = err instanceof ServerStartError ? err.message : (err as Error).message;
    return { pass: false, output: detail };
  }

  try {
    opts.emit({ type: "integration", step: "run" });
    const res = await $`bun test ${INT_DIR}`.cwd(opts.cwd).env({ ...process.env, [BASE_URL_ENV]: server.baseUrl }).nothrow().quiet();
    const output = res.stdout.toString() + res.stderr.toString();
    const serverLogs = server.logs().trim();
    return { pass: res.exitCode === 0, output: serverLogs ? `${output}\n--- server logs ---\n${lastLines(serverLogs, 15)}` : output };
  } finally {
    await server.stop();
  }
}

// ── shared small helpers (kept local to avoid cross-phase coupling) ───
async function ensureCommitted(cwd: string, message: string): Promise<void> {
  await $`git add -A`.cwd(cwd).nothrow().quiet();
  const status = await $`git status --porcelain`.cwd(cwd).nothrow().quiet();
  if (status.stdout.toString().trim()) await $`git commit -m ${message}`.cwd(cwd).nothrow().quiet();
}

function emitActivity(emit: BuildEmit, taskId: string, kind: string, ev: AgentEvent): void {
  if (ev.type === "tool-call") emit({ type: "activity", taskId, kind, action: ev.name });
  else if (ev.type === "error") emit({ type: "activity", taskId, kind, action: `error: ${ev.message}` });
}

function lastLines(text: string, n: number): string {
  return text.trim().split("\n").slice(-n).join("\n");
}
