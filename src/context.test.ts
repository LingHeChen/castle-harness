import { test, expect } from "bun:test";
import type { ModelMessage } from "ai";
import { ContextManager, estimateTokens, flattenTranscript } from "./core/context";

const fakeSummarize = async () => "SUMMARY";

function convo(turns: number): ModelMessage[] {
  // task + `turns` × (assistant tool-call + tool result)
  const msgs: ModelMessage[] = [{ role: "user", content: "do the big task" }];
  for (let i = 0; i < turns; i++) {
    msgs.push({
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: `c${i}`, toolName: "bash", input: { command: `step ${i}` } }],
    });
    msgs.push({
      role: "tool",
      content: [{ type: "tool-result", toolCallId: `c${i}`, toolName: "bash", output: { type: "text", value: "x".repeat(2000) } }],
    });
  }
  return msgs;
}

test("estimateTokens grows with content", () => {
  const small = estimateTokens([{ role: "user", content: "hi" }]);
  const big = estimateTokens([{ role: "user", content: "x".repeat(4000) }]);
  expect(big).toBeGreaterThan(small);
  expect(big).toBeGreaterThan(900); // ~4000 chars / 4
});

test("under budget → messages returned untouched (cache-stable, no compaction)", async () => {
  const cm = new ContextManager({ budgetTokens: 1_000_000, keepRecentSegments: 4, summarize: fakeSummarize });
  const msgs = convo(3);
  const out = await cm.prepare(msgs);
  expect(out).toBe(msgs); // same reference — nothing rewritten
  expect(cm.drain()).toHaveLength(0);
});

test("over budget → compacts, pinning task + recent turns and summarizing the middle", async () => {
  const cm = new ContextManager({ budgetTokens: 2_000, keepRecentSegments: 4, summarize: fakeSummarize });
  const msgs = convo(10); // ~10 turns of 2k-char tool outputs → well over budget
  const out = await cm.prepare(msgs);

  expect(out.length).toBeLessThan(msgs.length);
  // task pinned at head
  expect(out[0]).toEqual({ role: "user", content: "do the big task" });
  // summary injected right after the pinned task
  expect(out[1]).toMatchObject({ role: "assistant" });
  expect(out[1]!.content).toContain("SUMMARY");
  // window shrank
  expect(estimateTokens(out)).toBeLessThan(estimateTokens(msgs));

  const events = cm.drain();
  expect(events).toHaveLength(1);
  expect(events[0]!.type).toBe("compaction");
  expect(events[0]!.afterTokens).toBeLessThan(events[0]!.beforeTokens);
});

test("compaction never splits an assistant tool-call from its tool result", async () => {
  const cm = new ContextManager({ budgetTokens: 2_000, keepRecentSegments: 4, summarize: fakeSummarize });
  const out = await cm.prepare(convo(10));
  // every 'tool' message must be immediately preceded by an 'assistant' message
  for (let i = 0; i < out.length; i++) {
    if (out[i]!.role === "tool") {
      expect(out[i - 1]?.role).toBe("assistant");
    }
  }
});

test("too few turns to compact → returned untouched even if over budget", async () => {
  const cm = new ContextManager({ budgetTokens: 1, keepRecentSegments: 4, summarize: fakeSummarize });
  const msgs = convo(1); // 1 task + 1 turn = 3 messages → not enough to carve a middle
  const out = await cm.prepare(msgs);
  expect(out).toBe(msgs);
});

test("flattenTranscript renders tool calls and results as text", () => {
  const t = flattenTranscript(convo(1));
  expect(t).toContain("called bash");
  expect(t).toContain("user: do the big task");
});
