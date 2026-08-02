import type { ModelMessage } from "ai";

/**
 * Context engineering lives here. The agent's message window grows every step;
 * left alone it eventually overflows the model's context and makes every call
 * more expensive (input tokens grow linearly → cost grows quadratically).
 *
 * The strategy is deliberately KV-cache-aware:
 *
 *  - **Under budget → do nothing.** Returning the messages untouched keeps the
 *    prompt prefix byte-stable across steps, so DeepSeek's prefix cache hits on
 *    the growing prefix. This is the common case and the cache-optimal one.
 *
 *  - **Over budget → compact once.** Pin the task and the most recent turns,
 *    replace the middle with an LLM summary. This breaks the prefix cache a
 *    single time in exchange for a bounded window — a net win on long runs.
 *
 * Compaction works at *turn* granularity so an `assistant` message and the
 * `tool` results it triggered always move together; splitting them would send
 * a dangling tool result and the API would reject the request.
 */

export type ContextEvent = {
  type: "compaction";
  beforeTokens: number;
  afterTokens: number;
  summarizedSegments: number;
};

/** Produces a dense summary of a slice of earlier conversation. */
export type Summarizer = (messages: ModelMessage[]) => Promise<string>;

export type ContextManagerOptions = {
  /** Compact when the estimated window exceeds this many tokens. */
  budgetTokens: number;
  /** Number of most-recent turns to keep verbatim. */
  keepRecentSegments: number;
  summarize: Summarizer;
};

/**
 * A turn: one `user`/`assistant` message plus any `tool` results that follow it.
 * Compaction only ever cuts on turn boundaries.
 */
type Segment = { messages: ModelMessage[] };

/** Rough token estimate (~4 chars/token). A real tokenizer would be exact; this
 *  is only used to decide *when* to compact, where an approximation is fine. */
export function estimateTokens(messages: ModelMessage[]): number {
  let chars = 0;
  for (const m of messages) chars += m.role.length + contentChars(m.content);
  return Math.ceil(chars / 4);
}

function contentChars(content: unknown): number {
  if (typeof content === "string") return content.length;
  return JSON.stringify(content ?? "").length;
}

function segment(messages: ModelMessage[]): Segment[] {
  const segments: Segment[] = [];
  for (const m of messages) {
    if (m.role === "tool" && segments.length > 0) {
      segments[segments.length - 1]!.messages.push(m);
    } else {
      segments.push({ messages: [m] });
    }
  }
  return segments;
}

/** Flatten messages to a plain-text transcript for the summarizer, so the
 *  summarization call never has to satisfy tool-call/result pairing rules. */
export function flattenTranscript(messages: ModelMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (typeof m.content === "string") {
      lines.push(`${m.role}: ${m.content}`);
      continue;
    }
    for (const part of m.content as Array<Record<string, unknown>>) {
      switch (part.type) {
        case "text":
          lines.push(`${m.role}: ${part.text as string}`);
          break;
        case "tool-call":
          lines.push(`${m.role}: called ${part.toolName}(${JSON.stringify(part.input)})`);
          break;
        case "tool-result":
          lines.push(`${m.role}: → ${flattenToolOutput(part.output)}`);
          break;
        default:
          lines.push(`${m.role}: ${JSON.stringify(part)}`);
      }
    }
  }
  return lines.join("\n");
}

function flattenToolOutput(output: unknown): string {
  if (output && typeof output === "object" && "value" in (output as object)) {
    return String((output as { value: unknown }).value);
  }
  return typeof output === "string" ? output : JSON.stringify(output);
}

export class ContextManager {
  private pending: ContextEvent[] = [];

  constructor(private readonly opts: ContextManagerOptions) {}

  /** Drain context events accumulated since the last call (for the event stream). */
  drain(): ContextEvent[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }

  /**
   * Called before each model step with the messages that would be sent. Returns
   * the messages to actually send — unchanged when under budget.
   */
  async prepare(messages: ModelMessage[]): Promise<ModelMessage[]> {
    const before = estimateTokens(messages);
    if (before <= this.opts.budgetTokens) return messages;

    const segments = segment(messages);
    // Need at least: head (task) + summarized middle + kept tail.
    if (segments.length <= this.opts.keepRecentSegments + 1) return messages;

    const head = segments[0]!;
    const tail = segments.slice(segments.length - this.opts.keepRecentSegments);
    const middle = segments.slice(1, segments.length - this.opts.keepRecentSegments);
    const middleMessages = middle.flatMap((s) => s.messages);

    const summary = await this.opts.summarize(middleMessages);
    const summaryMessage: ModelMessage = {
      role: "assistant",
      content: `[Earlier steps summarized to save context]\n${summary}`,
    };

    const compacted: ModelMessage[] = [
      ...head.messages,
      summaryMessage,
      ...tail.flatMap((s) => s.messages),
    ];

    this.pending.push({
      type: "compaction",
      beforeTokens: before,
      afterTokens: estimateTokens(compacted),
      summarizedSegments: middle.length,
    });
    return compacted;
  }
}
