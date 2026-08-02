import { tool } from "ai";
import { z } from "zod";
import { $ } from "bun";
import { truncate } from "../core/util";
import type { ToolContext } from "./index";

export function bashTool(ctx: ToolContext) {
  return tool({
    description:
      "Run a shell command in the working directory. Returns the exit code and " +
      "combined stdout/stderr. Use for tests, git, grep, builds — anything the " +
      "dedicated file tools don't cover.",
    inputSchema: z.object({
      command: z.string().describe("The shell command to execute, e.g. 'bun test'."),
    }),
    execute: async ({ command }) => {
      // Bun.$ escapes interpolation, so `command` is passed as a single argv to
      // `sh -c` rather than being re-parsed — no shell-injection surprises.
      const res = await $`sh -c ${command}`.cwd(ctx.cwd).nothrow().quiet();
      const stdout = res.stdout.toString();
      const stderr = res.stderr.toString();
      let out = stdout;
      if (stderr) out += (out ? "\n" : "") + stderr;
      out = out.trim() || "(no output)";
      return truncate(`exit=${res.exitCode}\n${out}`, ctx.maxOutput);
    },
  });
}
