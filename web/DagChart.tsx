import React, { useMemo } from "react";
import { ReactFlow, Background, BackgroundVariant, Controls, Handle, Position, type Edge, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { BuildTask, TaskStatus } from "../src/build/events";

/**
 * The task dependency graph, on React Flow: column = concurrency wave (things in a
 * column run in parallel), edges = deps. Read-only in the live build view (nodes
 * light up by status); editable in the plan checkpoint (drag a node's right handle
 * onto another to add a dependency, click an edge to remove it, click a node to
 * edit it in the side panel). Pan/zoom is trackpad-native: two-finger scroll pans,
 * pinch zooms.
 */

type TaskNodeData = { task: BuildTask; status: TaskStatus; activity?: string; editable: boolean };

function TaskNodeView({ data, selected }: NodeProps) {
  const { task, status, activity, editable } = data as unknown as TaskNodeData;
  const isContract = task.kind === "contract";
  return (
    <div className={`rf-node status-${status}${isContract ? " contract" : ""}${selected ? " selected" : ""}`}>
      <Handle type="target" position={Position.Left} isConnectable={editable} />
      <div className="rf-node-head">
        <span className="rf-node-id">{task.id}</span>
        {isContract && <span className="rf-node-badge">◆ 契约</span>}
      </div>
      <div className="rf-node-title">{task.title}</div>
      {!editable && <div className="rf-node-status">{status}{activity ? ` · ▸ ${activity}` : ""}</div>}
      <Handle type="source" position={Position.Right} isConnectable={editable} />
    </div>
  );
}

const nodeTypes = { task: TaskNodeView };
const noop = () => {};

export function DagChart({
  tasks,
  waves,
  status,
  activity,
  editable = false,
  selectedId = null,
  onSelect,
  onConnect,
  onDeleteEdge,
}: {
  tasks: BuildTask[];
  waves: string[][];
  status: Record<string, TaskStatus>;
  activity: Record<string, string>;
  editable?: boolean;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  onConnect?: (from: string, to: string) => void; // to depends on from
  onDeleteEdge?: (dep: string, task: string) => void;
}) {
  const nodes: Node[] = useMemo(() => {
    const waveOf = new Map<string, number>();
    const rowOf = new Map<string, number>();
    waves.forEach((w, i) => w.forEach((id, r) => (waveOf.set(id, i), rowOf.set(id, r))));
    return tasks.map((t) => ({
      id: t.id,
      type: "task",
      position: { x: (waveOf.get(t.id) ?? 0) * 260, y: (rowOf.get(t.id) ?? 0) * 120 },
      data: { task: t, status: status[t.id] ?? "pending", activity: activity[t.id], editable } satisfies TaskNodeData,
      selected: t.id === selectedId,
      draggable: false,
    }));
  }, [tasks, waves, status, activity, editable, selectedId]);

  const edges: Edge[] = useMemo(
    () => tasks.flatMap((t) => t.dependsOn.map((dep) => ({ id: `${dep}->${t.id}`, source: dep, target: t.id }))),
    [tasks],
  );

  if (tasks.length === 0) return <div className="chart-empty">暂无任务</div>;

  return (
    <div className={`dag-canvas${editable ? " editable" : ""}`}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={noop}
        onEdgesChange={noop}
        fitView
        minZoom={0.15}
        nodesDraggable={false}
        nodesConnectable={editable}
        elementsSelectable={editable}
        panOnScroll
        zoomOnScroll={false}
        zoomOnPinch
        onNodeClick={(_, n) => onSelect?.(n.id)}
        onConnect={(c) => c.source && c.target && onConnect?.(c.source, c.target)}
        onEdgeClick={(_, e) => onDeleteEdge?.(e.source, e.target)}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
      {editable && <div className="dag-hint">拖节点右侧手柄到另一个节点＝加依赖 · 点连线＝删依赖 · 点节点＝编辑 · 双指平移 · 捏合缩放</div>}
    </div>
  );
}
