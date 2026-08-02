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
};

export type TaskStatus =
  | "pending"
  | "testing"
  | "audited"
  | "developing"
  | "merged"
  | "merge-conflict"
  | "fixing"
  | "passing"
  | "failing";

export type BuildEvent =
  | { type: "phase"; n: number; title: string }
  | { type: "intent"; expandedIntent: string; assumptions: string[]; confidence: number; needsClarification: boolean }
  | { type: "graph"; tasks: BuildTask[]; waves: string[][] }
  | { type: "audit"; taskId: string; sound: boolean; canFalsePass: boolean; issues: string[] }
  | { type: "wave"; index: number; taskIds: string[] }
  | { type: "task-status"; taskId: string; status: TaskStatus; detail?: string }
  | { type: "activity"; taskId: string; kind: string; action: string }
  | { type: "log"; message: string }
  | { type: "report"; outcomes: Array<{ id: string; passed: boolean; attempts: number; detail: string }> }
  | { type: "done" }
  | { type: "error"; message: string };

export type BuildEmit = (ev: BuildEvent) => void;
