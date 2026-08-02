import type { ToolSet } from "ai";
import type { Tracer } from "../core/trace";
import { bashTool } from "./bash";
import { fsTools } from "./fs";

/** Shared context threaded into every tool: where it runs and its output cap. */
export type ToolContext = {
  cwd: string;
  tracer: Tracer;
  maxOutput: number;
};

export function buildTools(opts: { cwd: string; tracer: Tracer }): ToolSet {
  const ctx: ToolContext = { cwd: opts.cwd, tracer: opts.tracer, maxOutput: 16_000 };
  return {
    bash: bashTool(ctx),
    ...fsTools(ctx),
  };
}
