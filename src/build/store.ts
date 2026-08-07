import { appendFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Task } from "./schemas";
import type { BuildEmit, BuildEvent, BuildTreeNode } from "./events";
import type { IntegrationReport } from "./integration";

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
  integration?: IntegrationReport;
};

const BUILDS_DIR = ".castle/builds";

export function newBuildId(now: number): string {
  return `bld-${now}`;
}

/**
 * Append-only run log for a build. Every {@link BuildEvent} is written as one
 * timestamped JSON line to `.castle/builds/<id>.events.jsonl`, so a whole build —
 * phases, activity, shared edits, ripple, integration — is inspectable on disk
 * after the fact (by a human, or by an agent debugging a run) without a live WS.
 */
export class BuildLog {
  readonly path: string;

  constructor(cwd: string, buildId: string) {
    const dir = join(cwd, BUILDS_DIR);
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, `${buildId}.events.jsonl`);
  }

  // Append (not truncate) + fsync per line: a resume continues the same build's
  // log instead of wiping it, and the file is durable/tailable at any moment.
  write(ev: BuildEvent): void {
    appendFileSync(this.path, JSON.stringify({ ts: Date.now(), ...ev }) + "\n");
  }

  /**
   * Wrap a downstream emit so every event is logged to disk AND forwarded once.
   * Takes `downstream` explicitly (not via a mutable binding) so the wrapper can
   * never accidentally call itself — the tee is a pure fan-out, not a loop.
   */
  tee(downstream: BuildEmit): BuildEmit {
    return (ev) => {
      this.write(ev);
      downstream(ev);
    };
  }

  close(): void {
    /* append mode opens per write — nothing to close */
  }
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
