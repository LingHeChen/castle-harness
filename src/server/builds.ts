import { join } from "node:path";
import { openBuildStore } from "../build/db";
import type { BuildRecord } from "../build/store";
import type { BuildEvent } from "../build/events";

/**
 * Read-side access to persisted builds for the dashboard. Builds are first-class
 * objects (id, goal, tasks, outcomes) in SQLite, and their full event stream is on
 * disk as JSONL — so the UI can list them, open one by id, and replay it read-only
 * even after the live WebSocket is long gone.
 */

export type BuildListEntry = {
  id: string;
  createdAt: number;
  goal: string;
  taskCount: number;
  passed: number;
  total: number;
  done: boolean;
};

const safeId = (id: string) => /^[\w.-]+$/.test(id);

export function listBuilds(cwd: string): BuildListEntry[] {
  const store = openBuildStore(cwd);
  try {
    return store.listBuilds().map((b) => ({
      id: b.id,
      createdAt: b.createdAt,
      goal: b.goal,
      taskCount: b.tasks?.length ?? 0,
      passed: b.outcomes?.filter((o) => o.passed).length ?? 0,
      total: b.outcomes?.length ?? 0,
      done: b.outcomes !== undefined,
    }));
  } finally {
    store.close();
  }
}

export function getBuild(cwd: string, id: string): BuildRecord | null {
  if (!safeId(id)) return null;
  const store = openBuildStore(cwd);
  try {
    return store.getBuild(id);
  } finally {
    store.close();
  }
}

/** The persisted BuildEvent stream for a build (replay source for the UI). */
export async function getBuildEvents(cwd: string, id: string): Promise<BuildEvent[] | null> {
  if (!safeId(id)) return null;
  const file = Bun.file(join(cwd, ".castle", "builds", `${id}.events.jsonl`));
  if (!(await file.exists())) return null;
  const events: BuildEvent[] = [];
  for (const line of (await file.text()).split("\n")) {
    if (!line.trim()) continue;
    try {
      const { ts: _ts, ...ev } = JSON.parse(line) as BuildEvent & { ts?: number };
      events.push(ev as BuildEvent);
    } catch {
      /* skip a torn last line */
    }
  }
  return events;
}
