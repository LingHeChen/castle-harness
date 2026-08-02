import type { Task } from "./schemas";

/**
 * Turn a task DAG into concurrency waves: wave N contains every task whose
 * dependencies all live in waves < N. Tasks within a wave have no ordering
 * constraint between them, so they can develop in parallel.
 *
 * Throws on unknown dependencies or cycles — a bad decomposition should fail
 * loudly here, before any code is written.
 */
export function toWaves(tasks: Task[]): Task[][] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  for (const t of tasks) {
    for (const dep of t.dependsOn) {
      if (!byId.has(dep)) throw new Error(`task "${t.id}" depends on unknown task "${dep}"`);
    }
  }

  const done = new Set<string>();
  const waves: Task[][] = [];
  let remaining = [...tasks];

  while (remaining.length > 0) {
    const ready = remaining.filter((t) => t.dependsOn.every((d) => done.has(d)));
    if (ready.length === 0) {
      throw new Error(`dependency cycle among: ${remaining.map((t) => t.id).join(", ")}`);
    }
    waves.push(ready);
    for (const t of ready) done.add(t.id);
    remaining = remaining.filter((t) => !done.has(t.id));
  }
  return waves;
}
