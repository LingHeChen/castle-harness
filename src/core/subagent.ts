import { generateText } from "ai";
import { z } from "zod";
import { createModel, resolveModelConfig } from "./model";
import { runAgent, type AgentOptions } from "./agent";
import { emptyUsage, type AgentEvent, type Usage } from "./events";

/**
 * Subagents are the unit of context isolation. Each call below spins up a fresh
 * model conversation with no history from the caller — which is exactly what the
 * build pipeline needs: the test auditor must judge tests without having seen
 * (and rationalized) the reasoning that produced them.
 *
 * Two flavours:
 *  - `think`: one structured, tool-free call → a validated object.
 *  - `work`: a full agentic sub-run (tools, loop) → its final text.
 */

/**
 * A context-isolated structured call. Rather than depend on a provider-specific
 * structured-output mode, we instruct the model with the JSON Schema, then parse
 * and validate against the zod schema ourselves, retrying on failure. This keeps
 * it model-agnostic and puts the harness in control of the contract.
 */
export async function think<T>(opts: {
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  model?: string;
  maxRetries?: number;
}): Promise<T> {
  const model = createModel(resolveModelConfig(opts.model));
  const jsonSchema = JSON.stringify(z.toJSONSchema(opts.schema));
  const system = `${opts.system}

Respond with ONLY a single JSON object that validates against this JSON Schema.
Do not wrap it in markdown fences or add any prose.
JSON Schema: ${jsonSchema}`;

  let prompt = opts.prompt;
  const maxRetries = opts.maxRetries ?? 2;
  let lastError = "";

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const { text } = await generateText({ model, system, prompt });
    const parsed = extractJson(text);
    const result = opts.schema.safeParse(parsed);
    if (result.success) return result.data;
    lastError = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    prompt = `${opts.prompt}\n\nYour previous response was invalid (${lastError}). Return valid JSON only.`;
  }
  throw new Error(`think(): could not get valid output after ${maxRetries + 1} attempts. Last error: ${lastError}`);
}

/** Run a full agentic subagent to completion; returns its final text + usage. */
export async function work(
  task: string,
  opts: AgentOptions & { onEvent?: (ev: AgentEvent) => void },
): Promise<{ text: string; usage: Usage }> {
  let text = "";
  let usage: Usage = emptyUsage();
  for await (const ev of runAgent(task, opts)) {
    opts.onEvent?.(ev);
    if (ev.type === "done") {
      text = ev.text;
      usage = ev.usage;
    }
  }
  return { text, usage };
}

/** Pull the first balanced JSON object out of a model response. */
function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1]! : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}
