import type { LanguageModelUsage } from "ai";

/**
 * Token accounting for one model call or a whole run.
 *
 * `cachedInputTokens` is surfaced deliberately: prompt-prefix (KV) cache hits
 * are the single biggest cost lever in an agent harness, so every layer above
 * — TUI, trace panel, eval report — is built to read it.
 */
export type Usage = {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
};

/**
 * The harness's own event stream. Everything the agent does is expressed as one
 * of these, decoupled from the underlying model SDK so that the TUI, the HTTP
 * server, the JSONL tracer and the eval runner can all consume the same shape.
 */
export type AgentEvent =
  | { type: "step-start"; step: number }
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "tool-call"; id: string; name: string; input: unknown }
  | { type: "tool-result"; id: string; name: string; output: string; ok: boolean; ms: number }
  | { type: "compaction"; beforeTokens: number; afterTokens: number; summarizedSegments: number }
  | { type: "step-finish"; step: number; usage: Usage }
  | { type: "done"; text: string; usage: Usage }
  | { type: "error"; message: string };

export function toUsage(u?: LanguageModelUsage): Usage {
  const inputTokens = u?.inputTokens ?? 0;
  const outputTokens = u?.outputTokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    reasoningTokens: u?.outputTokenDetails?.reasoningTokens ?? 0,
    cachedInputTokens: u?.inputTokenDetails?.cacheReadTokens ?? 0,
    totalTokens: u?.totalTokens ?? inputTokens + outputTokens,
  };
}

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0, totalTokens: 0 };
}
