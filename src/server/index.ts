import type { Server, ServerWebSocket } from "bun";
import index from "../../web/index.html";
import { runAgent } from "../core/agent";
import { build } from "../build/orchestrator";
import type { Task } from "../build/schemas";
import { Tracer } from "../core/trace";
import { newBuildId } from "../build/store";
import { listRuns, getRun } from "./runs";
import { listBuilds, getBuild, getBuildEvents } from "./builds";

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
      "/build/:id": index, // client-side route: hard-loads/refreshes of a build URL serve the app
      "/api/runs": async () => Response.json(await listRuns()),
      "/api/runs/:id": async (req: Bun.BunRequest<"/api/runs/:id">) => {
        const run = await getRun(req.params.id);
        return run ? Response.json(run) : new Response("not found", { status: 404 });
      },
      "/api/balance": async () => Response.json(await deepseekBalance()),
      "/api/builds": () => Response.json(listBuilds(cwd)),
      "/api/builds/:id": (req: Bun.BunRequest<"/api/builds/:id">) => {
        const b = getBuild(cwd, req.params.id);
        return b ? Response.json(b) : new Response("not found", { status: 404 });
      },
      "/api/builds/:id/events": async (req: Bun.BunRequest<"/api/builds/:id/events">) => {
        const e = await getBuildEvents(cwd, req.params.id);
        return e ? Response.json(e) : new Response("not found", { status: 404 });
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
        } else if (msg.type === "build" && (msg.goal || msg.resume)) {
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

/**
 * Proxy the DeepSeek balance endpoint (https://api.deepseek.com/user/balance) so
 * the API key stays server-side and the dashboard can show remaining credit.
 * Returns a normalized shape; `ok:false` (never throws) when unconfigured/failed.
 */
type BalanceResult =
  | { ok: true; isAvailable: boolean; infos: Array<{ currency: string; totalBalance: string; grantedBalance: string; toppedUpBalance: string }> }
  | { ok: false; error: string };

async function deepseekBalance(): Promise<BalanceResult> {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) return { ok: false, error: "DEEPSEEK_API_KEY 未配置" };
  const base = process.env.DEEPSEEK_BASE_URL?.replace(/\/v1\/?$/, "") ?? "https://api.deepseek.com";
  try {
    const res = await fetch(`${base}/user/balance`, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = (await res.json()) as {
      is_available?: boolean;
      balance_infos?: Array<{ currency: string; total_balance: string; granted_balance: string; topped_up_balance: string }>;
    };
    return {
      ok: true,
      isAvailable: Boolean(data.is_available),
      infos: (data.balance_infos ?? []).map((b) => ({
        currency: b.currency,
        totalBalance: b.total_balance,
        grantedBalance: b.granted_balance,
        toppedUpBalance: b.topped_up_balance,
      })),
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
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
  resume?: string; // build id to resume
};

async function streamBuild(ws: ServerWebSocket<WsData>, msg: ClientMsg): Promise<void> {
  // Ask the client for input at a checkpoint and await its response over the WS.
  const request = <T>(type: string, payload: object): Promise<T> =>
    new Promise<T>((resolve) => {
      ws.data.pending = resolve as (v: unknown) => void;
      ws.send(JSON.stringify({ type, ...payload }));
    });

  const buildId = msg.resume ?? newBuildId(Date.now());
  ws.send(JSON.stringify({ type: "build-started", buildId }));
  try {
    await build(msg.goal ?? "", {
      cwd: ws.data.cwd,
      model: msg.model,
      buildId,
      resume: Boolean(msg.resume),
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
