import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newStoredSession, saveSession, loadSession, listSessions, latestSessionId } from "./core/session";

function tmp() {
  return mkdtempSync(join(tmpdir(), "castle-sess-"));
}

test("session round-trips full message history to disk", async () => {
  const dir = tmp();
  const s = newStoredSession();
  s.messages.push({ role: "user", content: "hello" }, { role: "assistant", content: "hi" });
  await saveSession(dir, s);

  const loaded = await loadSession(dir, s.id);
  expect(loaded).not.toBeNull();
  expect(loaded!.messages).toHaveLength(2);
  expect(loaded!.messages[0]).toEqual({ role: "user", content: "hello" });
});

test("loadSession returns null for unknown id", async () => {
  expect(await loadSession(tmp(), "sess-nope")).toBeNull();
});

test("listSessions summarizes and latest picks the newest", async () => {
  const dir = tmp();
  const a = { ...newStoredSession(), id: "sess-100", createdAt: 100, messages: [{ role: "user" as const, content: "older task" }] };
  const b = { ...newStoredSession(), id: "sess-200", createdAt: 200, messages: [{ role: "user" as const, content: "newer task" }] };
  await saveSession(dir, a);
  await saveSession(dir, b);

  const list = await listSessions(dir);
  expect(list.map((s) => s.id)).toEqual(["sess-200", "sess-100"]); // newest first
  expect(list[0]!.preview).toContain("newer task");
  expect(list[0]!.turns).toBe(1);
  expect(await latestSessionId(dir)).toBe("sess-200");
});
