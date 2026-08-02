import type { Server, ServerWebSocket } from "bun";
import index from "../../web/index.html";
import { runAgent } from "../core/agent";
import { build } from "../build/orchestrator";
import type { Task } from "../build/schemas";
import { Tracer } from "../core/trace";
import { listRuns, getRun } from "./runs";

type WsData = { running: boolean; cwd: string; pending?: (v: unknown) => void };

/**
 * The dashboard server. Two jobs:
 *  - serve the React app + a JSON API over recorded traces, and
 *  - live-stream a running agent's {@link AgentEvent}s over a WebSocket.
 *
 * The second job is the point: the browser consumes the *same* event stream the
 * terminal renderer does. One event contract, many frontends.
 */
export function startServer(port: number, cwd: string = process.cwd()): Server<WsData> {
  return Bun.serve<WsData>({
    port,
    hostname: "127.0.0.1", // local dev only — the agent can run shell commands
    development: true,

    routes: {
      "/": index,
      "/api/runs": async () => Response.json(await listRuns()),
      "/api/runs/:id": async (req: Bun.BunRequest<"/api/runs/:id">) => {
        const run = await getRun(req.params.id);
        return run ? Response.json(run) : new Response("not found", { status: 404 });
      },
    },

    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/ws/run" || url.pathname === "/ws/build") {
        return server.upgrade(req, { data: { running: false, cwd } })
          ? undefined
          : new Response("expected websocket", { status: 426 });
      }
      return new Response("not found", { status: 404 });
    },

    websocket: {
      message(ws: ServerWebSocket<WsData>, raw) {
        let msg: ClientMsg;
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }
        // Responses to a checkpoint resolve the paused build — handle these even
        // while a build is running (that's the whole point).
        if (msg.type === "clarify-response") {
          ws.data.pending?.(msg.answers ?? []);
          ws.data.pending = undefined;
          return;
        }
        if (msg.type === "approval-response") {
          ws.data.pending?.(msg.tasks);
          ws.data.pending = undefined;
          return;
        }
        if (ws.data.running) return;
        if (msg.type === "start" && msg.task) {
          ws.data.running = true;
          void streamRun(ws, msg);
        } else if (msg.type === "build" && msg.goal) {
          ws.data.running = true;
          void streamBuild(ws, msg);
        }
      },
      close(ws: ServerWebSocket<WsData>) {
        // Don't leave a paused build hanging if the browser goes away.
        ws.data.pending?.(undefined);
        ws.data.pending = undefined;
      },
    },
  });
}

type ClientMsg = {
  type?: string;
  task?: string;
  maxSteps?: number;
  compact?: boolean;
  contextBudget?: number;
  goal?: string;
  model?: string;
  fixAttempts?: number;
  answers?: string[];
  tasks?: Task[];
};

async function streamBuild(ws: ServerWebSocket<WsData>, msg: ClientMsg): Promise<void> {
  // Ask the client for input at a checkpoint and await its response over the WS.
  const request = <T>(type: string, payload: object): Promise<T> =>
    new Promise<T>((resolve) => {
      ws.data.pending = resolve as (v: unknown) => void;
      ws.send(JSON.stringify({ type, ...payload }));
    });

  ws.send(JSON.stringify({ type: "build-started" }));
  try {
    await build(msg.goal!, {
      cwd: ws.data.cwd,
      model: msg.model,
      maxFixAttempts: msg.fixAttempts ?? 2,
      maxAuditAttempts: 1,
      maxDepth: 3,
      confidenceThreshold: 0.75,
      emit: (ev) => ws.send(JSON.stringify(ev)),
      clarify: async (questions) => {
        const ans = await request<string[] | undefined>("clarify-request", { questions });
        return Array.isArray(ans) ? ans : [];
      },
      reviewPlan: async (tasks, tree) => {
        const edited = await request<Task[] | undefined>("approval-request", { tasks, tree });
        return Array.isArray(edited) && edited.length > 0 ? edited : tasks;
      },
    });
  } catch (err) {
    ws.send(JSON.stringify({ type: "error", message: (err as Error).message }));
  } finally {
    ws.data.running = false;
    ws.data.pending = undefined;
    ws.send(JSON.stringify({ type: "build-ended" }));
  }
}

async function streamRun(
  ws: ServerWebSocket<WsData>,
  msg: { task?: string; maxSteps?: number; compact?: boolean; contextBudget?: number },
): Promise<void> {
  const tracer = new Tracer();
  ws.send(JSON.stringify({ type: "run-started", runId: tracer.runId }));
  try {
    for await (const ev of runAgent(msg.task!, {
      cwd: ws.data.cwd,
      maxSteps: msg.maxSteps ?? 20,
      tracer,
      compact: msg.compact !== false,
      contextBudget: msg.contextBudget,
    })) {
      ws.send(JSON.stringify(ev));
    }
  } catch (err) {
    ws.send(JSON.stringify({ type: "error", message: (err as Error).message }));
  } finally {
    tracer.close();
    ws.data.running = false;
    ws.send(JSON.stringify({ type: "run-ended", runId: tracer.runId }));
  }
}
