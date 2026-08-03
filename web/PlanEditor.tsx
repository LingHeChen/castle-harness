import React, { useMemo, useState } from "react";
import type { Task } from "../src/build/schemas";
import { toWaves } from "../src/build/graph";
import { DagChart } from "./DagChart";

/**
 * The DAG-approval checkpoint, made editable. The user can retitle tasks, rewrite
 * descriptions and acceptance criteria, add or delete tasks, and rewire
 * dependencies — the live DAG re-lays-out on every change and validates for
 * cycles/dangling deps. Nothing is built until "approve & build". The edited
 * Task[] is what the orchestrator then executes (via reviewPlan).
 */
export function PlanEditor({ initial, respond }: { initial: Task[]; respond: (msg: object) => void }) {
  const [tasks, setTasks] = useState<Task[]>(initial);

  // Recompute waves for the preview; a cycle/dangling dep surfaces as an error.
  const { waves, error } = useMemo(() => {
    try {
      return { waves: toWaves(tasks).map((w) => w.map((t) => t.id)), error: null as string | null };
    } catch (e) {
      return { waves: [] as string[][], error: (e as Error).message };
    }
  }, [tasks]);

  const patch = (id: string, p: Partial<Task>) => setTasks(tasks.map((t) => (t.id === id ? { ...t, ...p } : t)));
  const remove = (id: string) => setTasks(tasks.filter((t) => t.id !== id).map((t) => ({ ...t, dependsOn: t.dependsOn.filter((d) => d !== id) })));
  const add = () => {
    const id = uniqueId(tasks);
    setTasks([...tasks, { id, title: "new task", description: "", acceptanceCriteria: ["does what it should"], dependsOn: [], files: [] }]);
  };
  const toggleDep = (id: string, dep: string) =>
    patch(id, { dependsOn: tasks.find((t) => t.id === id)!.dependsOn.includes(dep) ? tasks.find((t) => t.id === id)!.dependsOn.filter((d) => d !== dep) : [...tasks.find((t) => t.id === id)!.dependsOn, dep] });

  return (
    <section className="panel checkpoint">
      <h2>⏸ review &amp; edit the plan — {tasks.length} tasks — approve to start building</h2>
      <p className="hint">Edit tasks, rewire dependencies, add/remove. Nothing is built until you approve.</p>

      <div className="editor-dag">
        {error ? <div className="editor-error">⚠ {error}</div> : <DagChart tasks={tasks} waves={waves} status={{}} activity={{}} />}
      </div>

      <div className="task-editor">
        {tasks.map((t) => (
          <div key={t.id} className="task-card">
            <div className="task-card-head">
              <span className="task-id">{t.id}</span>
              <input className="task-title" value={t.title} onChange={(e) => patch(t.id, { title: e.target.value })} />
              <button className="task-del" title="delete task" onClick={() => remove(t.id)}>✕</button>
            </div>
            <label className="task-field">description
              <textarea value={t.description} rows={2} onChange={(e) => patch(t.id, { description: e.target.value })} />
            </label>
            <label className="task-field">acceptance criteria (one per line)
              <textarea value={t.acceptanceCriteria.join("\n")} rows={2} onChange={(e) => patch(t.id, { acceptanceCriteria: splitLines(e.target.value) })} />
            </label>
            <label className="task-field">files (one per line)
              <textarea value={t.files.join("\n")} rows={1} onChange={(e) => patch(t.id, { files: splitLines(e.target.value) })} />
            </label>
            <div className="task-deps">
              <span className="task-deps-label">depends on:</span>
              {tasks.filter((o) => o.id !== t.id).map((o) => (
                <label key={o.id} className="dep-chip">
                  <input type="checkbox" checked={t.dependsOn.includes(o.id)} onChange={() => toggleDep(t.id, o.id)} /> {o.id}
                </label>
              ))}
              {tasks.length === 1 && <span className="task-deps-label">(no other tasks)</span>}
            </div>
          </div>
        ))}
      </div>

      <div className="editor-actions">
        <button className="task-add" onClick={add}>+ add task</button>
        <button className="checkpoint-go" disabled={!!error || tasks.length === 0} onClick={() => respond({ type: "approval-response", tasks })}>
          approve &amp; build →
        </button>
      </div>
    </section>
  );
}

function splitLines(v: string): string[] {
  return v.split("\n").map((s) => s.trim()).filter(Boolean);
}

function uniqueId(tasks: Task[]): string {
  const ids = new Set(tasks.map((t) => t.id));
  let n = tasks.length + 1;
  while (ids.has(`task-${n}`)) n++;
  return `task-${n}`;
}
