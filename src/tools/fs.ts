import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { resolve } from "node:path";
import { readdir } from "node:fs/promises";
import { truncate } from "../core/util";
import type { ToolContext } from "./index";

export function fsTools(ctx: ToolContext): ToolSet {
  const abs = (p: string) => resolve(ctx.cwd, p);

  const read_file = tool({
    description: "Read a UTF-8 text file and return its contents.",
    inputSchema: z.object({
      path: z.string().describe("File path, relative to the working directory."),
    }),
    execute: async ({ path }) => {
      const file = Bun.file(abs(path));
      if (!(await file.exists())) return `Error: no such file: ${path}`;
      return truncate(await file.text(), ctx.maxOutput);
    },
  });

  const write_file = tool({
    description:
      "Write (creating or overwriting) a text file with the given contents. " +
      "Parent directories are created as needed.",
    inputSchema: z.object({
      path: z.string().describe("File path, relative to the working directory."),
      content: z.string().describe("The full contents to write."),
    }),
    execute: async ({ path, content }) => {
      if (ctx.guard) {
        const d = await ctx.guard({ op: "write", path, content });
        if (d.type !== "allow") return d.message;
      }
      await Bun.write(abs(path), content);
      return `Wrote ${content.length} chars to ${path}`;
    },
  });

  const edit_file = tool({
    description:
      "Replace an exact substring in a file with new text. `old_string` must " +
      "appear exactly once; include enough surrounding context to make it unique.",
    inputSchema: z.object({
      path: z.string().describe("File path, relative to the working directory."),
      old_string: z.string().describe("Exact text to find. Must match uniquely."),
      new_string: z.string().describe("Text to replace it with."),
    }),
    execute: async ({ path, old_string, new_string }) => {
      const file = Bun.file(abs(path));
      if (!(await file.exists())) return `Error: no such file: ${path}`;
      const original = await file.text();
      const count = original.split(old_string).length - 1;
      if (count === 0) return `Error: old_string not found in ${path}`;
      if (count > 1) return `Error: old_string matches ${count} times in ${path}; add more context to make it unique`;
      if (ctx.guard) {
        const d = await ctx.guard({ op: "edit", path, old_string, new_string });
        if (d.type !== "allow") return d.message;
      }
      await Bun.write(abs(path), original.replace(old_string, new_string));
      return `Edited ${path}`;
    },
  });

  const list_dir = tool({
    description: "List the entries of a directory, marking sub-directories with a trailing slash.",
    inputSchema: z.object({
      path: z.string().default(".").describe("Directory path, relative to the working directory."),
    }),
    execute: async ({ path }) => {
      try {
        const entries = await readdir(abs(path), { withFileTypes: true });
        if (entries.length === 0) return "(empty directory)";
        const lines = entries
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .sort();
        return truncate(lines.join("\n"), ctx.maxOutput);
      } catch (err) {
        return `Error: cannot list ${path}: ${(err as Error).message}`;
      }
    },
  });

  return { read_file, write_file, edit_file, list_dir };
}
