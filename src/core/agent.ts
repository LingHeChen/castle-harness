import { streamText, stepCountIs } from "ai";
import { createModel, resolveModelConfig } from "./model";
import { buildTools } from "../tools";
import { SYSTEM_PROMPT } from "./prompt";
import { toUsage, type AgentEvent } from "./events";
import { ContextManager } from "./context";
import { createSummarizer } from "./summarize";
import type { Tracer } from "./trace";

export type AgentOptions = {
  cwd: string;
  maxSteps: number;
  tracer: Tracer;
  model?: string;
  /** Override the system prompt (subagents use a role-specific one). */
  system?: string;
  /** Enable context compaction (default true). */
  compact?: boolean;
  /** Token budget that triggers compaction (default 20_000). */
  contextBudget?: number;
};

/**
 * The agent loop, exposed as an async generator of {@link AgentEvent}.
 *
 * We let the SDK drive the think→act→observe iteration (it re-invokes the model
 * after each round of tool calls, up to `stopWhen`), but we consume the raw
 * `fullStream` ourselves and re-express every part as a harness event. That
 * keeps a clean seam: this function is the *only* place coupled to the model
 * SDK — the TUI, server and eval runner all speak {@link AgentEvent}.
 */
export async function* runAgent(task: string, opts: AgentOptions): AsyncGenerator<AgentEvent> {
  const model = createModel(resolveModelConfig(opts.model));
  const tools = buildTools({ cwd: opts.cwd, tracer: opts.tracer });

  // Context engineering: compact the message window when it grows past budget.
  const context =
    opts.compact === false
      ? null
      : new ContextManager({
          budgetTokens: opts.contextBudget ?? 20_000,
          keepRecentSegments: 4,
          summarize: createSummarizer(model),
        });

  // Track when each tool call started so we can report execution latency.
  const started = new Map<string, number>();

  const result = streamText({
    model,
    system: opts.system ?? SYSTEM_PROMPT,
    prompt: task,
    tools,
    stopWhen: stepCountIs(opts.maxSteps),
    prepareStep: context
      ? async ({ messages }) => {
          const compacted = await context.prepare(messages);
          return compacted === messages ? {} : { messages: compacted };
        }
      : undefined,
  });

  const emit = (ev: AgentEvent): AgentEvent => {
    opts.tracer.event(ev);
    return ev;
  };

  // Compaction happens inside prepareStep (before a step); surface any pending
  // context events into our stream at the step boundary that follows.
  function* flushContext(): Generator<AgentEvent> {
    if (!context) return;
    for (const ev of context.drain()) yield emit(ev);
  }

  let step = 0;

  for await (const part of result.fullStream) {
    switch (part.type) {
      case "start-step":
        yield* flushContext();
        step += 1;
        yield emit({ type: "step-start", step });
        break;
      case "text-delta":
        yield emit({ type: "text-delta", text: part.text });
        break;
      case "reasoning-delta":
        yield emit({ type: "reasoning-delta", text: part.text });
        break;
      case "tool-call":
        started.set(part.toolCallId, performance.now());
        yield emit({ type: "tool-call", id: part.toolCallId, name: part.toolName, input: part.input });
        break;
      case "tool-result": {
        const begun = started.get(part.toolCallId) ?? performance.now();
        const ms = Math.round(performance.now() - begun);
        yield emit({
          type: "tool-result",
          id: part.toolCallId,
          name: part.toolName,
          output: stringifyOutput(part.output),
          ok: true,
          ms,
        });
        break;
      }
      case "finish-step":
        yield emit({ type: "step-finish", step, usage: toUsage(part.usage) });
        break;
      case "error":
        yield emit({ type: "error", message: errorMessage(part.error) });
        break;
    }
  }

  yield* flushContext();
  const [text, usage] = await Promise.all([result.text, result.totalUsage]);
  const done = toUsage(usage);
  opts.tracer.final(done);
  yield emit({ type: "done", text, usage: done });
}

function stringifyOutput(output: unknown): string {
  return typeof output === "string" ? output : JSON.stringify(output);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : JSON.stringify(error);
}
