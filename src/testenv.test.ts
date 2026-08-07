import { test, expect } from "bun:test";
import { join } from "node:path";
import { startServer, freePort, ServerStartError } from "./build/testenv";

const SERVER = join(import.meta.dir, "fixtures", "integration-server.ts");
const cwd = import.meta.dir;

// A raw TCP check — Bun's `fetch` keep-alive pool can falsely "resolve" against a
// just-killed server, so teardown must be asserted at the socket level.
async function portOpen(port: number): Promise<boolean> {
  try {
    const s = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {}, open(x) { x.end(); }, error() {} } });
    s.end();
    return true;
  } catch {
    return false;
  }
}

test("brings a server up, serves requests, then tears it down", async () => {
  const port = await freePort();
  const h = await startServer({ cwd, command: ["bun", "run", SERVER], port, ready: { type: "http", path: "/health" } });

  expect(h.port).toBe(port);
  expect(h.baseUrl).toBe(`http://127.0.0.1:${port}`);

  // it's actually serving
  const res = await fetch(`${h.baseUrl}/echo`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, port });

  expect(await portOpen(port)).toBe(true); // up before teardown
  await h.stop();
  expect(await portOpen(port)).toBe(false); // stop() only returns once the port is free
}, 20_000);

test("waits out a slow boot via readiness polling", async () => {
  const port = await freePort();
  const h = await startServer({
    cwd,
    command: ["bun", "run", SERVER],
    port,
    env: { START_DELAY_MS: "700" },
    ready: { type: "http", path: "/health" },
    pollMs: 100,
  });
  expect((await fetch(`${h.baseUrl}/health`)).status).toBe(200);
  await h.stop();
}, 20_000);

test("tcp probe works for a listening server", async () => {
  const port = await freePort();
  const h = await startServer({ cwd, command: ["bun", "run", SERVER], port, ready: { type: "tcp" } });
  expect((await fetch(`${h.baseUrl}/health`)).status).toBe(200);
  await h.stop();
}, 20_000);

test("throws (with captured logs) when the process crashes on boot", async () => {
  const port = await freePort();
  const boom = ["bun", "-e", "console.error('kaboom on boot'); process.exit(1)"];
  const err = await startServer({ cwd, command: boom, port, timeoutMs: 5000 }).catch((e) => e);
  expect(err).toBeInstanceOf(ServerStartError);
  expect((err as ServerStartError).logs).toContain("kaboom on boot");
}, 20_000);

test("throws on timeout when the server never listens", async () => {
  const port = await freePort();
  const hang = ["bun", "-e", "await new Promise(() => {})"]; // runs forever, never binds
  const err = await startServer({ cwd, command: hang, port, timeoutMs: 1200, pollMs: 150 }).catch((e) => e);
  expect(err).toBeInstanceOf(ServerStartError);
  expect((err as Error).message).toContain("did not become ready");
}, 20_000);
