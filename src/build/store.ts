import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Task } from "./schemas";
import type { BuildTreeNode } from "./events";

/**
 * A build persisted to disk. Like a chat session, a build is a durable record:
 * its goal, the expanded intent, the decomposition tree, the approved task set,
 * and the final outcomes are written to `.castle/builds/<id>.json` as the pipeline
 * progresses — so a build survives the process and can be inspected or resumed.
 */
export type BuildRecord = {
  id: string;
  createdAt: number;
  goal: string;
  intent?: string;
  tree?: BuildTreeNode;
  tasks?: Task[];
  outcomes?: Array<{ id: string; passed: boolean; attempts: number; detail: string }>;
};

const BUILDS_DIR = ".castle/builds";

export function newBuildId(now: number): string {
  return `bld-${now}`;
}

export async function saveBuild(cwd: string, record: BuildRecord): Promise<void> {
  mkdirSync(join(cwd, BUILDS_DIR), { recursive: true });
  await Bun.write(join(cwd, BUILDS_DIR, `${record.id}.json`), JSON.stringify(record, null, 2));
}

export async function loadBuild(cwd: string, id: string): Promise<BuildRecord | null> {
  const f = Bun.file(join(cwd, BUILDS_DIR, `${id}.json`));
  if (!(await f.exists())) return null;
  try {
    return (await f.json()) as BuildRecord;
  } catch {
    return null;
  }
}

export async function listBuilds(cwd: string): Promise<BuildRecord[]> {
  let files: string[];
  try {
    files = readdirSync(join(cwd, BUILDS_DIR)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: BuildRecord[] = [];
  for (const f of files) {
    const r = await loadBuild(cwd, f.replace(/\.json$/, ""));
    if (r) out.push(r);
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}
