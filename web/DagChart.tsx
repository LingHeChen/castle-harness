import React from "react";
import type { BuildTask, TaskStatus } from "../src/build/events";

/**
 * Hand-drawn SVG of the task dependency graph, laid out by concurrency wave:
 * column = wave (things in the same column run in parallel), edges = deps. Nodes
 * light up live as the build moves each task through its states.
 */
export function DagChart({
  tasks,
  waves,
  status,
  activity,
}: {
  tasks: BuildTask[];
  waves: string[][];
  status: Record<string, TaskStatus>;
  activity: Record<string, string>;
}) {
  if (tasks.length === 0) return <div className="chart-empty">no tasks yet</div>;

  const waveOf = new Map<string, number>();
  const rowOf = new Map<string, number>();
  waves.forEach((w, i) => w.forEach((id, r) => (waveOf.set(id, i), rowOf.set(id, r))));

  const colW = 210;
  const rowH = 92;
  const padX = 16;
  const padY = 16;
  const nodeW = 168;
  const nodeH = 66;
  const maxRows = Math.max(...waves.map((w) => w.length), 1);
  const W = padX * 2 + Math.max(waves.length, 1) * colW;
  const H = padY * 2 + maxRows * rowH;

  const pos = (id: string) => ({
    x: padX + (waveOf.get(id) ?? 0) * colW,
    y: padY + (rowOf.get(id) ?? 0) * rowH,
  });

  return (
    <svg className="dag" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
      {/* dependency edges */}
      {tasks.flatMap((t) =>
        t.dependsOn.map((dep) => {
          const a = pos(dep);
          const b = pos(t.id);
          const x1 = a.x + nodeW;
          const y1 = a.y + nodeH / 2;
          const x2 = b.x;
          const y2 = b.y + nodeH / 2;
          const mx = (x1 + x2) / 2;
          return <path key={`${dep}-${t.id}`} className="dag-edge" d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`} fill="none" />;
        }),
      )}

      {/* task nodes */}
      {tasks.map((t) => {
        const p = pos(t.id);
        const st = status[t.id] ?? "pending";
        const act = activity[t.id];
        return (
          <g key={t.id} transform={`translate(${p.x} ${p.y})`} className={`dag-node status-${st}`}>
            <rect width={nodeW} height={nodeH} rx={8} />
            <text className="dag-id" x={10} y={20}>{t.id}</text>
            <text className="dag-status" x={10} y={38}>{st}</text>
            {act && <text className="dag-act" x={10} y={54}>▸ {act}</text>}
          </g>
        );
      })}
    </svg>
  );
}
