import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Persistent, per-project agent memory. A plain markdown file the agent can read
 * (it's loaded into the system prompt at run start) and append to (via the
 * `remember` tool). It lives under `.castle/` so it survives across runs but
 * stays out of version control — this is the agent's working memory, not source.
 *
 * Loading happens once at run start, so within a run the memory block is a stable
 * part of the prompt prefix (consistent with the KV-cache-stable-prefix design);
 * anything the agent remembers takes effect on the next run.
 */

const MEM_PATH = ".castle/memory.md";

export async function loadMemory(cwd: string): Promise<string> {
  const f = Bun.file(join(cwd, MEM_PATH));
  return (await f.exists()) ? (await f.text()).trim() : "";
}

export async function appendMemory(cwd: string, note: string): Promise<void> {
  mkdirSync(join(cwd, ".castle"), { recursive: true });
  const path = join(cwd, MEM_PATH);
  const f = Bun.file(path);
  const prev = (await f.exists()) ? (await f.text()).trimEnd() : "# Project memory";
  await Bun.write(path, `${prev}\n- ${note.trim()}\n`);
}
