import { tool } from "ai";
import { z } from "zod";
import { appendMemory } from "../core/memory";
import { loadSkill, type Skill } from "../core/skills";
import { truncate } from "../core/util";
import type { ToolContext } from "./index";

/** Tool: append a durable note to project memory (survives across runs). */
export function rememberTool(ctx: ToolContext) {
  return tool({
    description:
      "Save a durable note to project memory. Use for facts worth remembering across runs " +
      "(conventions, decisions, gotchas). It is loaded into context at the start of future runs.",
    inputSchema: z.object({ note: z.string().describe("A single concise fact to remember.") }),
    execute: async ({ note }) => {
      await appendMemory(ctx.cwd, note);
      return "Saved to memory.";
    },
  });
}

/** Tool: load a skill's full instructions on demand (progressive disclosure). */
export function loadSkillTool(ctx: ToolContext, skills: Skill[]) {
  const names = skills.map((s) => s.name);
  return tool({
    description: `Load the full instructions for a named skill. Available: ${names.join(", ")}.`,
    inputSchema: z.object({ name: z.enum(names as [string, ...string[]]).describe("The skill to load.") }),
    execute: async ({ name }) => {
      const body = await loadSkill(ctx.cwd, name);
      return body ? truncate(body, ctx.maxOutput) : `No skill named "${name}".`;
    },
  });
}
