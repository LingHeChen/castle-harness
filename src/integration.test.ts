import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIntegrationOnce } from "./build/integration";
import type { IntegrationPlan } from "./build/schemas";
import type { BuildEvent } from "./build/events";

// A minimal app: a server + a real integration test that hits it via CASTLE_BASE_URL.
const SERVER = `const port = Number(process.env.PORT);
Bun.serve({ port, fetch(req) {
  const u = new URL(req.url);
  if (u.pathname === "/health") return new Response("ok");
  if (u.pathname === "/add") return Response.json({ sum: Number(u.searchParams.get("a")) + Number(u.searchParams.get("b")) });
  return new Response("nope", { status: 404 });
}});
`;

async function project(testBody: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "castle-int-"));
  await Bun.write(join(dir, "server.ts"), SERVER);
  await Bun.write(join(dir, "integration", "api.test.ts"), testBody);
  return dir;
}

const plan = (): IntegrationPlan => ({
  applicable: true,
  reason: "web api",
  setupCommand: [],
  startCommand: ["bun", "run", "server.ts"],
  readyPath: "/health",
  scenarios: [],
});

const opts = (dir: string, events: BuildEvent[] = []) => ({ cwd: dir, emit: (e: BuildEvent) => events.push(e), maxFixAttempts: 0 });

test("the gate PASSES when the live app behaves correctly across the seam", async () => {
  const dir = await project(`import { test, expect } from "bun:test";
const base = process.env.CASTLE_BASE_URL;
test("adds via the API", async () => {
  const r = await fetch(base + "/add?a=2&b=3");
  expect((await r.json()).sum).toBe(5);
});
`);
  const events: BuildEvent[] = [];
  const res = await runIntegrationOnce(plan(), opts(dir, events));
  expect(res.pass).toBe(true);
  // it drove the environment lifecycle
  expect(events.some((e) => e.type === "integration" && e.step === "up")).toBe(true);
  expect(events.some((e) => e.type === "integration" && e.step === "run")).toBe(true);
}, 30_000);

test("the gate FAILS when the app is wrong end-to-end (catches what units miss)", async () => {
  const dir = await project(`import { test, expect } from "bun:test";
const base = process.env.CASTLE_BASE_URL;
test("expects a different answer", async () => {
  const r = await fetch(base + "/add?a=2&b=3");
  expect((await r.json()).sum).toBe(999); // wrong on purpose
});
`);
  const res = await runIntegrationOnce(plan(), opts(dir));
  expect(res.pass).toBe(false);
  expect(res.output).toContain("999"); // the failure surfaces in the report
}, 30_000);

test("a crash-on-boot server is reported as an integration failure, not a hang", async () => {
  const dir = await project(`import { test } from "bun:test"; test("noop", () => {});`);
  await Bun.write(join(dir, "server.ts"), `console.error("boom"); process.exit(1);`);
  const res = await runIntegrationOnce({ ...plan(), readyPath: "/health" }, { ...opts(dir), timeoutMs: 4000 });
  expect(res.pass).toBe(false);
  expect(res.output).toContain("boom");
}, 30_000);

test("a failing setup command short-circuits before the server starts", async () => {
  const dir = await project(`import { test } from "bun:test"; test("noop", () => {});`);
  const res = await runIntegrationOnce({ ...plan(), setupCommand: ["bash", "-c", "echo seed-fail >&2; exit 1"] }, opts(dir));
  expect(res.pass).toBe(false);
  expect(res.output).toContain("setup command failed");
}, 30_000);
