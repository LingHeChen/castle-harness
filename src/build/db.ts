import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Task } from "./schemas";
import type { BuildRecord } from "./store";

/**
 * Persistence for builds and their tasks, behind an adapter interface.
 *
 * Every build has an id, and every task is stored with its id (namespaced by
 * build) — so a run is queryable after the fact, not just a blob on disk. The
 * {@link BuildStore} interface is deliberately storage-agnostic (no SQLite types
 * leak through it), so a Postgres/other backend can be dropped in later by
 * implementing the same six methods. {@link SqliteBuildStore} is the bun:sqlite
 * implementation used today.
 */
export interface BuildStore {
  /** Upsert the build's top-level record (goal, intent, tree, outcomes, integration). */
  saveBuild(rec: BuildRecord): void;
  /** Replace the build's task rows (each stored with its task id). */
  saveTasks(buildId: string, tasks: Task[]): void;
  getBuild(id: string): BuildRecord | null;
  getTasks(buildId: string): Task[];
  listBuilds(): BuildRecord[];
  close(): void;
}

type BuildRow = {
  id: string;
  created_at: number;
  goal: string;
  intent: string | null;
  tree: string | null;
  integration: string | null;
  outcomes: string | null;
};

type TaskRow = {
  task_id: string;
  title: string;
  description: string;
  kind: string;
  depends_on: string;
  files: string;
  acceptance_criteria: string | null;
};

export class SqliteBuildStore implements BuildStore {
  private readonly db: Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS builds (
        id          TEXT PRIMARY KEY,
        created_at  INTEGER NOT NULL,
        goal        TEXT NOT NULL,
        intent      TEXT,
        tree        TEXT,
        integration TEXT,
        outcomes    TEXT
      )`);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS tasks (
        build_id            TEXT NOT NULL,
        task_id             TEXT NOT NULL,
        title               TEXT NOT NULL,
        description         TEXT,
        kind                TEXT NOT NULL,
        depends_on          TEXT,
        files               TEXT,
        acceptance_criteria TEXT,
        PRIMARY KEY (build_id, task_id)
      )`);
    // Older DBs won't have the column; add it best-effort (resume needs criteria).
    try {
      this.db.run("ALTER TABLE tasks ADD COLUMN acceptance_criteria TEXT");
    } catch {
      /* column already exists */
    }
  }

  saveBuild(rec: BuildRecord): void {
    this.db
      .query(
        `INSERT INTO builds (id, created_at, goal, intent, tree, integration, outcomes)
         VALUES ($id, $created_at, $goal, $intent, $tree, $integration, $outcomes)
         ON CONFLICT(id) DO UPDATE SET
           goal=$goal, intent=$intent, tree=$tree, integration=$integration, outcomes=$outcomes`,
      )
      .run({
        $id: rec.id,
        $created_at: rec.createdAt,
        $goal: rec.goal,
        $intent: rec.intent ?? null,
        $tree: rec.tree ? JSON.stringify(rec.tree) : null,
        $integration: rec.integration ? JSON.stringify(rec.integration) : null,
        $outcomes: rec.outcomes ? JSON.stringify(rec.outcomes) : null,
      });
    if (rec.tasks) this.saveTasks(rec.id, rec.tasks);
  }

  saveTasks(buildId: string, tasks: Task[]): void {
    const insert = this.db.query(
      `INSERT INTO tasks (build_id, task_id, title, description, kind, depends_on, files, acceptance_criteria)
       VALUES ($build_id, $task_id, $title, $description, $kind, $depends_on, $files, $acceptance_criteria)
       ON CONFLICT(build_id, task_id) DO UPDATE SET
         title=$title, description=$description, kind=$kind, depends_on=$depends_on, files=$files, acceptance_criteria=$acceptance_criteria`,
    );
    const tx = this.db.transaction((rows: Task[]) => {
      for (const t of rows) {
        insert.run({
          $build_id: buildId,
          $task_id: t.id,
          $title: t.title,
          $description: t.description,
          $kind: t.kind,
          $depends_on: JSON.stringify(t.dependsOn),
          $files: JSON.stringify(t.files),
          $acceptance_criteria: JSON.stringify(t.acceptanceCriteria),
        });
      }
    });
    tx(tasks);
  }

  getBuild(id: string): BuildRecord | null {
    const row = this.db.query("SELECT * FROM builds WHERE id = $id").get({ $id: id }) as BuildRow | null;
    if (!row) return null;
    return { ...rowToRecord(row), tasks: this.getTasks(id) };
  }

  getTasks(buildId: string): Task[] {
    const rows = this.db.query("SELECT * FROM tasks WHERE build_id = $b ORDER BY task_id").all({ $b: buildId }) as TaskRow[];
    return rows.map((r) => {
      const criteria = safeArray(r.acceptance_criteria);
      return {
        id: r.task_id,
        title: r.title,
        description: r.description ?? "",
        acceptanceCriteria: criteria.length > 0 ? criteria : ["按描述实现。"],
        kind: (r.kind === "contract" ? "contract" : "feature") as Task["kind"],
        dependsOn: safeArray(r.depends_on),
        files: safeArray(r.files),
      };
    });
  }

  listBuilds(): BuildRecord[] {
    const rows = this.db.query("SELECT * FROM builds ORDER BY created_at DESC").all() as BuildRow[];
    return rows.map((r) => ({ ...rowToRecord(r), tasks: this.getTasks(r.id) }));
  }

  close(): void {
    this.db.close();
  }
}

/** Open the on-disk build store for a project (`.castle/castle.db`). */
export function openBuildStore(cwd: string): BuildStore {
  return new SqliteBuildStore(join(cwd, ".castle", "castle.db"));
}

function rowToRecord(r: BuildRow): BuildRecord {
  return {
    id: r.id,
    createdAt: r.created_at,
    goal: r.goal,
    intent: r.intent ?? undefined,
    tree: r.tree ? JSON.parse(r.tree) : undefined,
    integration: r.integration ? JSON.parse(r.integration) : undefined,
    outcomes: r.outcomes ? JSON.parse(r.outcomes) : undefined,
  };
}

function safeArray(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
