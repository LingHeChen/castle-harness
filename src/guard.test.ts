import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTools, type WriteAttempt, type WriteGuard } from "./tools";

function tools(guard?: WriteGuard) {
  const cwd = mkdtempSync(join(tmpdir(), "castle-guard-"));
  return { cwd, tools: buildTools({ cwd, guard }) as any };
}

async function run(t: any, name: string, input: object) {
  return t[name].execute(input, { toolCallId: "x", messages: [] });
}

test("no guard → writes proceed normally", async () => {
  const { cwd, tools: t } = tools();
  const out = await run(t, "write_file", { path: "a.ts", content: "hello" });
  expect(out).toContain("Wrote");
  expect(await Bun.file(join(cwd, "a.ts")).text()).toBe("hello");
});

test("guard deny → write is blocked, message returned, file not created", async () => {
  const seen: WriteAttempt[] = [];
  const guard: WriteGuard = async (a) => {
    seen.push(a);
    return { type: "deny", message: "you don't own order.ts" };
  };
  const { cwd, tools: t } = tools(guard);
  const out = await run(t, "write_file", { path: "order.ts", content: "x" });
  expect(out).toBe("you don't own order.ts");
  expect(seen[0]).toEqual({ op: "write", path: "order.ts", content: "x" });
  expect(await Bun.file(join(cwd, "order.ts")).exists()).toBe(false);
});

test("guard handled → tool skips its own write and returns the guard's message", async () => {
  const guard: WriteGuard = async () => ({ type: "handled", message: "coordinated via shared-edit protocol" });
  const { cwd, tools: t } = tools(guard);
  const out = await run(t, "write_file", { path: "shared.ts", content: "x" });
  expect(out).toBe("coordinated via shared-edit protocol");
  expect(await Bun.file(join(cwd, "shared.ts")).exists()).toBe(false); // guard owns the write, tool didn't
});

test("guard allow → the normal write still happens", async () => {
  const guard: WriteGuard = async () => ({ type: "allow" });
  const { cwd, tools: t } = tools(guard);
  await run(t, "write_file", { path: "mine.ts", content: "y" });
  expect(await Bun.file(join(cwd, "mine.ts")).text()).toBe("y");
});

test("edit_file also passes through the guard (with op:edit)", async () => {
  const seen: WriteAttempt[] = [];
  const guard: WriteGuard = async (a) => {
    seen.push(a);
    return { type: "deny", message: "blocked" };
  };
  const { cwd, tools: t } = tools(guard);
  await Bun.write(join(cwd, "f.ts"), "const a = 1;");
  const out = await run(t, "edit_file", { path: "f.ts", old_string: "1", new_string: "2" });
  expect(out).toBe("blocked");
  expect(seen[0]).toEqual({ op: "edit", path: "f.ts", old_string: "1", new_string: "2" });
  expect(await Bun.file(join(cwd, "f.ts")).text()).toBe("const a = 1;"); // unchanged
});

test("edit_file guard runs only after the match checks pass", async () => {
  let called = false;
  const guard: WriteGuard = async () => {
    called = true;
    return { type: "allow" };
  };
  const { cwd, tools: t } = tools(guard);
  await Bun.write(join(cwd, "f.ts"), "x");
  const out = await run(t, "edit_file", { path: "f.ts", old_string: "not-there", new_string: "y" });
  expect(out).toContain("not found");
  expect(called).toBe(false); // guard not consulted for an impossible edit
});
