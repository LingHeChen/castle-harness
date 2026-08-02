import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseTrace, type RunSummary } from "../core/analysis";

const TRACES_DIR = ".castle/traces";

export type RunListEntry = {
  id: string;
  steps: number;
  compactions: number;
  totalTokens: number;
  hitRate: number;
};

/** List all recorded runs, newest first, with headline metrics. */
export async function listRuns(): Promise<RunListEntry[]> {
  let files: string[];
  try {
    files = (await readdir(TRACES_DIR)).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }

  const entries = await Promise.all(
    files.map(async (f) => {
      const id = f.replace(/\.jsonl$/, "");
      try {
        const summary = parseTrace(await Bun.file(join(TRACES_DIR, f)).text());
        return {
          id,
          steps: summary.steps.length,
          compactions: summary.compactions.length,
          totalTokens: summary.total?.inputTokens ?? 0,
          hitRate: summary.total?.hitRate ?? 0,
        } satisfies RunListEntry;
      } catch {
        return null;
      }
    }),
  );

  return entries
    .filter((e): e is RunListEntry => e !== null)
    // run ids embed a millisecond timestamp, so lexical desc == newest first
    .sort((a, b) => b.id.localeCompare(a.id));
}

/** Full structured summary for one run, or null if missing/unreadable. */
export async function getRun(id: string): Promise<RunSummary | null> {
  if (!/^[\w.-]+$/.test(id)) return null; // guard against path traversal
  const file = Bun.file(join(TRACES_DIR, `${id}.jsonl`));
  if (!(await file.exists())) return null;
  try {
    return parseTrace(await file.text());
  } catch {
    return null;
  }
}
