/**
 * The build pipeline's own event stream — the same "emit events, let consumers
 * render" discipline the agent loop uses. The CLI renders these to the terminal;
 * the dashboard forwards them over a WebSocket and lights up a live DAG.
 */

export type BuildTask = {
  id: string;
  title: string;
  dependsOn: string[];
  files: string[];
  kind?: "contract" | "feature";
};

export type TaskStatus =
  | "pending"
  | "testing"
  | "revising"
  | "audited"
  | "developing"
  | "merged"
  | "merge-conflict"
  | "rippling"
  | "fixing"
  | "passing"
  | "failing";

/** A node in the decomposition tree, as sent to the UI (children empty = leaf). */
export type BuildTreeNode = { id: string; title: string; leaf: boolean; children: BuildTreeNode[] };

/**
 * Where a shared change lands on the coordination spectrum:
 *  small  → auto-merge onto the integration tree
 *  medium → merge + re-run dependents' acceptance
 *  break  → merge + spawn fix-agents for dependents that now fail
 *  large  → replan the affected subtree
 */
export type SharedEditSize = "small" | "medium" | "break" | "large";

export type BuildEvent =
  | { type: "phase"; n: number; title: string }
  | { type: "intent"; expandedIntent: string; assumptions: string[]; confidence: number; needsClarification: boolean }
  | { type: "node"; id: string; title: string; depth: number; leaf: boolean }
  | { type: "tree"; tree: BuildTreeNode }
  | { type: "graph"; tasks: BuildTask[]; waves: string[][] }
  | { type: "audit"; taskId: string; sound: boolean; canFalsePass: boolean; issues: string[] }
  // A dev agent tried to write a file it doesn't own; the shared-edit protocol
  // coordinated the change instead of a raw write. `size` places it on the
  // spectrum (small→auto-merge … large→replan); `dependents` are the tasks the
  // semantic ripple will re-verify.
  | { type: "shared-edit"; taskId: string; file: string; owner: string; size: SharedEditSize; dependents: string[] }
  // After a shared change landed, these dependents are being re-verified/fixed.
  | { type: "ripple"; file: string; dependents: string[] }
  | { type: "wave"; index: number; taskIds: string[] }
  | { type: "task-status"; taskId: string; status: TaskStatus; detail?: string }
  | { type: "activity"; taskId: string; kind: string; action: string }
  | { type: "log"; message: string }
  // The build-wide integration gate (above the per-task unit gate): stand the app
  // up, exercise its seams, tear it down.
  | { type: "integration"; step: "plan" | "generate" | "up" | "run" | "fix"; detail?: string }
  | { type: "integration-report"; applicable: boolean; passed: boolean; attempts: number; scenarios: string[]; detail: string }
  | { type: "report"; outcomes: Array<{ id: string; passed: boolean; attempts: number; detail: string }> }
  | { type: "done" }
  | { type: "error"; message: string };

export type BuildEmit = (ev: BuildEvent) => void;
