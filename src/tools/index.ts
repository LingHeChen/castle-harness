import type { ToolSet } from "ai";
import type { Skill } from "../core/skills";
import { bashTool } from "./bash";
import { fsTools } from "./fs";
import { rememberTool, loadSkillTool } from "./context";

/** Shared context threaded into every tool: where it runs and its output cap. */
export type ToolContext = {
  cwd: string;
  maxOutput: number;
};

export function buildTools(opts: { cwd: string; skills?: Skill[] }): ToolSet {
  const ctx: ToolContext = { cwd: opts.cwd, maxOutput: 16_000 };
  const tools: ToolSet = {
    bash: bashTool(ctx),
    ...fsTools(ctx),
    remember: rememberTool(ctx),
  };
  // Skills are progressive-disclosure: only expose `load_skill` when some exist.
  if (opts.skills && opts.skills.length > 0) {
    tools.load_skill = loadSkillTool(ctx, opts.skills);
  }
  return tools;
}
