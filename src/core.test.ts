import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { truncate } from "./core/util";
import { toUsage } from "./core/events";
import { buildTools } from "./tools";
import type { ToolSet } from "ai";

function tempCtx() {
  const dir = mkdtempSync(join(tmpdir(), "castle-test-"));
  const tools = buildTools({ cwd: dir });
  return { dir, tools };
}

// The ai `tool()` wrapper stores our implementation on `.execute`; call it directly.
async function run(tools: ToolSet, name: string, input: unknown): Promise<string> {
  const exec = (tools[name] as { execute?: (i: unknown, o: unknown) => Promise<unknown> }).execute!;
  return (await exec(input, {})) as string;
}

test("truncate caps long output and annotates the drop", () => {
  expect(truncate("hello", 100)).toBe("hello");
  const out = truncate("x".repeat(50), 10);
  expect(out.startsWith("x".repeat(10))).toBe(true);
  expect(out).toContain("truncated 40 chars");
});

test("toUsage maps nested v7 token details flat", () => {
  const u = toUsage({
    inputTokens: 1000,
    outputTokens: 200,
    totalTokens: 1200,
    inputTokenDetails: { cacheReadTokens: 800, noCacheTokens: 200, cacheWriteTokens: 0 },
    outputTokenDetails: { textTokens: 150, reasoningTokens: 50 },
  } as never);
  expect(u.cachedInputTokens).toBe(800);
  expect(u.reasoningTokens).toBe(50);
  expect(u.totalTokens).toBe(1200);
});

test("toUsage tolerates missing usage", () => {
  const u = toUsage(undefined);
  expect(u).toEqual({ inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0, totalTokens: 0 });
});

test("write_file → read_file round-trips", async () => {
  const { tools } = tempCtx();
  await run(tools, "write_file", { path: "a.txt", content: "hi there" });
  expect(await run(tools, "read_file", { path: "a.txt" })).toBe("hi there");
});

test("read_file reports missing files", async () => {
  const { tools } = tempCtx();
  expect(await run(tools, "read_file", { path: "nope.txt" })).toContain("no such file");
});

test("edit_file replaces a unique match and rejects ambiguity", async () => {
  const { tools } = tempCtx();
  await run(tools, "write_file", { path: "b.txt", content: "one two two" });
  const dup = await run(tools, "edit_file", { path: "b.txt", old_string: "two", new_string: "X" });
  expect(dup).toContain("matches 2 times");

  await run(tools, "write_file", { path: "c.txt", content: "alpha beta" });
  await run(tools, "edit_file", { path: "c.txt", old_string: "beta", new_string: "gamma" });
  expect(await run(tools, "read_file", { path: "c.txt" })).toBe("alpha gamma");
});

test("list_dir shows entries with dir markers", async () => {
  const { tools } = tempCtx();
  await run(tools, "write_file", { path: "sub/inner.txt", content: "x" });
  await run(tools, "write_file", { path: "top.txt", content: "y" });
  const listing = await run(tools, "list_dir", { path: "." });
  expect(listing).toContain("sub/");
  expect(listing).toContain("top.txt");
});

test("bash runs a command and returns exit code + output", async () => {
  const { tools } = tempCtx();
  const out = await run(tools, "bash", { command: "echo hello" });
  expect(out).toContain("exit=0");
  expect(out).toContain("hello");
});
