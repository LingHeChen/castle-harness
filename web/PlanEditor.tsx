import React, { useMemo, useState } from "react";
import type { Task } from "../src/build/schemas";
import { toWaves } from "../src/build/graph";
import { DagChart } from "./DagChart";

/**
 * The DAG-approval checkpoint, edited ON the graph. Dependencies and structure are
 * manipulated directly on the canvas — drag a node onto another to add a dependency,
 * click an edge to remove it, click a node to select it — and the selected task's
 * details (title, description, criteria, files, contract flag) are edited in a
 * compact side panel instead of one long form. The DAG re-lays-out by wave on every
 * change and validates for cycles/dangling deps. Nothing is built until approval.
 */
export function PlanEditor({ initial, respond }: { initial: Task[]; respond: (msg: object) => void }) {
  const [tasks, setTasks] = useState<Task[]>(initial);
  const [selected, setSelected] = useState<string | null>(initial[0]?.id ?? null);

  const { waves, error } = useMemo(() => {
    try {
      return { waves: toWaves(tasks).map((w) => w.map((t) => t.id)), error: null as string | null };
    } catch (e) {
      return { waves: [] as string[][], error: (e as Error).message };
    }
  }, [tasks]);

  const patch = (id: string, p: Partial<Task>) => setTasks((ts) => ts.map((t) => (t.id === id ? { ...t, ...p } : t)));
  const remove = (id: string) => {
    setTasks((ts) => ts.filter((t) => t.id !== id).map((t) => ({ ...t, dependsOn: t.dependsOn.filter((d) => d !== id) })));
    setSelected((s) => (s === id ? null : s));
  };
  const add = () => {
    const id = uniqueId(tasks);
    setTasks((ts) => [...ts, { id, title: "新任务", description: "", acceptanceCriteria: ["按预期工作"], dependsOn: [], files: [], kind: "feature" }]);
    setSelected(id);
  };
  // Drag source→target on the DAG: target depends on source (guard against self + dup).
  const connect = (from: string, to: string) =>
    setTasks((ts) => ts.map((t) => (t.id === to && from !== to && !t.dependsOn.includes(from) ? { ...t, dependsOn: [...t.dependsOn, from] } : t)));
  const disconnect = (dep: string, task: string) =>
    setTasks((ts) => ts.map((t) => (t.id === task ? { ...t, dependsOn: t.dependsOn.filter((d) => d !== dep) } : t)));

  const sel = tasks.find((t) => t.id === selected) ?? null;

  return (
    <section className="panel checkpoint">
      <h2>⏸ 在 DAG 上审阅并编辑计划 — {tasks.length} 个任务</h2>

      <div className="plan-editor">
        <div className="plan-dag">
          <DagChart
            tasks={tasks}
            waves={waves}
            status={{}}
            activity={{}}
            editable
            selectedId={selected}
            onSelect={setSelected}
            onConnect={connect}
            onDeleteEdge={disconnect}
          />
          {error && <div className="editor-error">⚠ {error}</div>}
        </div>

        <aside className="plan-detail">
          {sel ? (
            <TaskDetail key={sel.id} task={sel} onPatch={(p) => patch(sel.id, p)} onDelete={() => remove(sel.id)} />
          ) : (
            <p className="hint">点击一个节点来编辑它的细节。拖一个节点到另一个节点＝加依赖，点击连线＝删依赖。</p>
          )}
        </aside>
      </div>

      <div className="editor-actions">
        <button className="task-add" onClick={add}>+ 新增任务</button>
        <button className="checkpoint-go" disabled={!!error || tasks.length === 0} onClick={() => respond({ type: "approval-response", tasks })}>
          批准并构建 →
        </button>
      </div>
    </section>
  );
}

function TaskDetail({ task, onPatch, onDelete }: { task: Task; onPatch: (p: Partial<Task>) => void; onDelete: () => void }) {
  return (
    <div className={`task-card${task.kind === "contract" ? " task-card-contract" : ""}`}>
      <div className="task-card-head">
        <span className="task-id">{task.id}</span>
        {task.kind === "contract" && <span className="contract-badge">契约</span>}
        <button className="task-del" title="删除任务" onClick={onDelete}>✕</button>
      </div>
      <label className="task-field">标题
        <input className="task-title" value={task.title} onChange={(e) => onPatch({ title: e.target.value })} />
      </label>
      <label className="task-field">描述
        <textarea value={task.description} rows={3} onChange={(e) => onPatch({ description: e.target.value })} />
      </label>
      <label className="task-field">验收标准（每行一条）
        <textarea value={task.acceptanceCriteria.join("\n")} rows={3} onChange={(e) => onPatch({ acceptanceCriteria: splitLines(e.target.value) })} />
      </label>
      <label className="task-field">文件（每行一个）
        <textarea value={task.files.join("\n")} rows={2} onChange={(e) => onPatch({ files: splitLines(e.target.value) })} />
      </label>
      <label className="contract-toggle" title="把该任务标记为共享契约">
        <input type="checkbox" checked={task.kind === "contract"} onChange={(e) => onPatch({ kind: e.target.checked ? "contract" : "feature" })} /> 标记为契约
      </label>
    </div>
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
