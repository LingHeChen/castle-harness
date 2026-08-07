import type { ToolSet } from "ai";
import type { Skill } from "../core/skills";
import { bashTool } from "./bash";
import { fsTools } from "./fs";
import { rememberTool, loadSkillTool } from "./context";

/**
 * A write the agent is attempting, handed to a {@link WriteGuard} before it lands.
 * This is the seam the permission system and the shared-edit protocol both hook:
 * every mutating file op passes through it, so a caller can allow it, block it, or
 * take over and perform it through a coordinated protocol instead of a raw write.
 */
export type WriteAttempt =
  | { op: "write"; path: string; content: string }
  | { op: "edit"; path: string; old_string: string; new_string: string };

export type WriteDecision =
  | { type: "allow" } // proceed with the normal write
  | { type: "deny"; message: string } // skip the write; return this message to the model
  | { type: "handled"; message: string }; // the guard already performed the write; return this message

export type WriteGuard = (attempt: WriteAttempt) => Promise<WriteDecision>;

/** Shared context threaded into every tool: where it runs and its output cap. */
export type ToolContext = {
  cwd: string;
  maxOutput: number;
  /** Optional interceptor for mutating file ops (permissions / shared-edit protocol). */
  guard?: WriteGuard;
  /** Max time a single bash command may run before it's killed (default 120s). */
  bashTimeoutMs?: number;
};

export function buildTools(opts: { cwd: string; skills?: Skill[]; guard?: WriteGuard }): ToolSet {
  const ctx: ToolContext = { cwd: opts.cwd, maxOutput: 16_000, guard: opts.guard };
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
