import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTools } from "./tools";

function bash(bashTimeoutMs?: number) {
  const cwd = mkdtempSync(join(tmpdir(), "castle-bash-"));
  const tools = buildTools({ cwd }) as any;
  // rebuild with timeout override by poking the context isn't exposed, so use a
  // dedicated tool via buildTools default and pass timeout through ToolContext:
  return { cwd, run: (command: string) => tools.bash.execute({ command }, { toolCallId: "x", messages: [] }) };
}

test("a normal command returns its exit code and output", async () => {
  const { run } = bash();
  const out = await run("echo hello && echo err 1>&2");
  expect(out).toContain("exit=0");
  expect(out).toContain("hello");
  expect(out).toContain("err");
});

test("a non-zero exit is reported, not thrown", async () => {
  const { run } = bash();
  const out = await run("exit 3");
  expect(out).toContain("exit=3");
});

test("a command reading stdin gets EOF instead of hanging", async () => {
  const { run } = bash();
  const out = await run("cat"); // no stdin → EOF → exits immediately
  expect(out).toContain("exit=0");
});

test("a hanging foreground command is killed by the timeout and reported", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "castle-bash-"));
  const { bashTool } = await import("./tools/bash");
  const tool = bashTool({ cwd, maxOutput: 16_000, bashTimeoutMs: 400 }) as any;
  const start = Date.now();
  const out = await tool.execute({ command: "sleep 30" }, { toolCallId: "x", messages: [] });
  const elapsed = Date.now() - start;
  expect(out).toContain("已被杀掉"); // timed-out message
  expect(elapsed).toBeLessThan(3000); // returned promptly, did not wait 30s
}, 10_000);

test("a backgrounded server with redirected output does not hang the tool", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "castle-bash-"));
  const { bashTool } = await import("./tools/bash");
  const tool = bashTool({ cwd, maxOutput: 16_000, bashTimeoutMs: 5000 }) as any;
  const start = Date.now();
  const out = await tool.execute(
    { command: "sleep 30 > /tmp/castle-bgtest.log 2>&1 &\necho started" },
    { toolCallId: "x", messages: [] },
  );
  const elapsed = Date.now() - start;
  expect(out).toContain("started");
  expect(elapsed).toBeLessThan(3000); // returns even though the bg child lives on
}, 10_000);
