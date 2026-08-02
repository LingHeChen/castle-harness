import type { Server, ServerWebSocket } from "bun";
import index from "../../web/index.html";
import { runAgent } from "../core/agent";
import { build } from "../build/orchestrator";
import { Tracer } from "../core/trace";
import { listRuns, getRun } from "./runs";

type WsData = { running: boolean; cwd: string };

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
        let msg: BuildMsg & RunMsg;
        try {
          msg = JSON.parse(String(raw));
        } catch {
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
    },
  });
}

type RunMsg = { type?: string; task?: string; maxSteps?: number; compact?: boolean; contextBudget?: number };
type BuildMsg = { type?: string; goal?: string; model?: string; fixAttempts?: number };

async function streamBuild(ws: ServerWebSocket<WsData>, msg: BuildMsg): Promise<void> {
  ws.send(JSON.stringify({ type: "build-started" }));
  try {
    await build(msg.goal!, {
      cwd: ws.data.cwd,
      model: msg.model,
      autonomous: true, // the browser can't answer clarification prompts
      maxFixAttempts: msg.fixAttempts ?? 2,
      maxAuditAttempts: 1,
      maxDepth: 3,
      confidenceThreshold: 0.75,
      emit: (ev) => ws.send(JSON.stringify(ev)),
    });
  } catch (err) {
    ws.send(JSON.stringify({ type: "error", message: (err as Error).message }));
  } finally {
    ws.data.running = false;
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
