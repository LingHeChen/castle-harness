import type { Server, ServerWebSocket } from "bun";
import index from "../../web/index.html";
import { runAgent } from "../core/agent";
import { Tracer } from "../core/trace";
import { listRuns, getRun } from "./runs";

type WsData = { running: boolean };

/**
 * The dashboard server. Two jobs:
 *  - serve the React app + a JSON API over recorded traces, and
 *  - live-stream a running agent's {@link AgentEvent}s over a WebSocket.
 *
 * The second job is the point: the browser consumes the *same* event stream the
 * terminal renderer does. One event contract, many frontends.
 */
export function startServer(port: number): Server<WsData> {
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
      if (url.pathname === "/ws/run") {
        return server.upgrade(req, { data: { running: false } })
          ? undefined
          : new Response("expected websocket", { status: 426 });
      }
      return new Response("not found", { status: 404 });
    },

    websocket: {
      message(ws: ServerWebSocket<WsData>, raw) {
        let msg: { type?: string; task?: string; maxSteps?: number; compact?: boolean; contextBudget?: number };
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (msg.type !== "start" || !msg.task) return;
        if (ws.data.running) return;
        ws.data.running = true;
        void streamRun(ws, msg);
      },
    },
  });
}

async function streamRun(
  ws: ServerWebSocket<WsData>,
  msg: { task?: string; maxSteps?: number; compact?: boolean; contextBudget?: number },
): Promise<void> {
  const tracer = new Tracer();
  ws.send(JSON.stringify({ type: "run-started", runId: tracer.runId }));
  try {
    for await (const ev of runAgent(msg.task!, {
      cwd: process.cwd(),
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
