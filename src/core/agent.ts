import { streamText, stepCountIs, type ModelMessage, type LanguageModel, type ToolSet } from "ai";
import { createModel, resolveModelConfig } from "./model";
import { buildTools } from "../tools";
import { SYSTEM_PROMPT } from "./prompt";
import { toUsage, type AgentEvent } from "./events";
import { ContextManager } from "./context";
import { createSummarizer } from "./summarize";
import { loadMemory } from "./memory";
import { listSkills, type Skill } from "./skills";
import { connectConfiguredMcp } from "./mcp";
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
 * Per-run (or per-session) setup: the model, the augmented system prompt, the
 * tool registry, and any MCP connections. Built once and reused across turns of
 * an interactive session, so memory/skills/MCP load a single time and the system
 * prompt stays a stable prefix across the whole conversation.
 */
export type AgentDeps = { model: LanguageModel; system: string; tools: ToolSet; closeMcp: () => void };

export async function prepareAgent(opts: { cwd: string; model?: string; system?: string }): Promise<AgentDeps> {
  const model = createModel(resolveModelConfig(opts.model));
  // Loaded once: memory + skills become a stable part of the prompt prefix.
  const [memory, skills] = await Promise.all([loadMemory(opts.cwd), listSkills(opts.cwd)]);
  const system = augmentSystem(opts.system ?? SYSTEM_PROMPT, memory, skills);
  // MCP tools join the registry namespaced mcp__<server>__<tool>.
  const mcp = await connectConfiguredMcp(opts.cwd);
  const tools = { ...buildTools({ cwd: opts.cwd, skills }), ...mcp.tools };
  return { model, system, tools, closeMcp: mcp.close };
}

export type TurnConfig = { tracer: Tracer; maxSteps: number; compact?: boolean; contextBudget?: number };

/**
 * Stream one turn over the given message history, re-expressing the SDK's raw
 * stream as {@link AgentEvent}s. Returns the messages the model generated this
 * turn (assistant + tool), so a session can append them and persist.
 *
 * This is the single seam coupled to the model SDK; the TUI, server, eval runner,
 * and interactive session all speak {@link AgentEvent}.
 */
export async function* streamMessages(
  messages: ModelMessage[],
  deps: AgentDeps,
  cfg: TurnConfig,
): AsyncGenerator<AgentEvent, ModelMessage[]> {
  const context =
    cfg.compact === false
      ? null
      : new ContextManager({ budgetTokens: cfg.contextBudget ?? 20_000, keepRecentSegments: 4, summarize: createSummarizer(deps.model) });

  const started = new Map<string, number>();

  const result = streamText({
    model: deps.model,
    system: deps.system,
    messages,
    tools: deps.tools,
    stopWhen: stepCountIs(cfg.maxSteps),
    prepareStep: context
      ? async ({ messages: msgs }) => {
          const compacted = await context.prepare(msgs);
          return compacted === msgs ? {} : { messages: compacted };
        }
      : undefined,
  });

  const emit = (ev: AgentEvent): AgentEvent => {
    cfg.tracer.event(ev);
    return ev;
  };

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
        yield emit({ type: "tool-result", id: part.toolCallId, name: part.toolName, output: stringifyOutput(part.output), ok: true, ms });
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
  const [response, text, usage] = await Promise.all([result.response, result.text, result.totalUsage]);
  const done = toUsage(usage);
  cfg.tracer.final(done);
  yield emit({ type: "done", text, usage: done });
  return response.messages;
}

/** One-shot: run a single task to completion and stream its events. */
export async function* runAgent(task: string, opts: AgentOptions): AsyncGenerator<AgentEvent> {
  const deps = await prepareAgent({ cwd: opts.cwd, model: opts.model, system: opts.system });
  try {
    const messages: ModelMessage[] = [{ role: "user", content: task }];
    yield* streamMessages(messages, deps, { tracer: opts.tracer, maxSteps: opts.maxSteps, compact: opts.compact, contextBudget: opts.contextBudget });
  } finally {
    deps.closeMcp();
  }
}

/** Fold persistent memory and the skill catalogue into the system prompt. */
function augmentSystem(base: string, memory: string, skills: Skill[]): string {
  let out = base;
  if (memory) out += `\n\n## Project memory\n${memory}`;
  if (skills.length > 0) {
    const list = skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
    out += `\n\n## Available skills\nUse the load_skill tool to read a skill's full instructions when relevant.\n${list}`;
  }
  return out;
}

function stringifyOutput(output: unknown): string {
  return typeof output === "string" ? output : JSON.stringify(output);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : JSON.stringify(error);
}
