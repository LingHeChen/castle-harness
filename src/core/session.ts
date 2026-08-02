import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { prepareAgent, streamMessages, type AgentDeps } from "./agent";
import type { AgentEvent } from "./events";
import type { Tracer } from "./trace";

/**
 * A conversation persisted to disk. Every turn's messages (user, assistant, and
 * tool) are appended and the whole thing is written back to
 * `.castle/sessions/<id>.json` after each turn, so a session survives the process
 * and can be resumed. The stored history is full-fidelity — compaction is applied
 * per-turn when talking to the model, but never mutates what's saved.
 */
export type StoredSession = {
  id: string;
  createdAt: number;
  messages: ModelMessage[];
};

const SESSIONS_DIR = ".castle/sessions";

function sessionPath(cwd: string, id: string): string {
  return join(cwd, SESSIONS_DIR, `${id}.json`);
}

export function newStoredSession(): StoredSession {
  return { id: `sess-${Date.now()}`, createdAt: Date.now(), messages: [] };
}

export async function loadSession(cwd: string, id: string): Promise<StoredSession | null> {
  const f = Bun.file(sessionPath(cwd, id));
  if (!(await f.exists())) return null;
  try {
    return (await f.json()) as StoredSession;
  } catch {
    return null;
  }
}

export async function saveSession(cwd: string, session: StoredSession): Promise<void> {
  mkdirSync(join(cwd, SESSIONS_DIR), { recursive: true });
  await Bun.write(sessionPath(cwd, session.id), JSON.stringify(session, null, 2));
}

export type SessionSummary = { id: string; createdAt: number; turns: number; preview: string };

export async function listSessions(cwd: string): Promise<SessionSummary[]> {
  let files: string[];
  try {
    files = readdirSync(join(cwd, SESSIONS_DIR)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: SessionSummary[] = [];
  for (const f of files) {
    const s = await loadSession(cwd, f.replace(/\.json$/, ""));
    if (!s) continue;
    const firstUser = s.messages.find((m) => m.role === "user");
    out.push({
      id: s.id,
      createdAt: s.createdAt,
      turns: s.messages.filter((m) => m.role === "user").length,
      preview: firstUser ? previewOf(firstUser.content) : "",
    });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export async function latestSessionId(cwd: string): Promise<string | null> {
  return (await listSessions(cwd))[0]?.id ?? null;
}

function previewOf(content: unknown): string {
  const text = typeof content === "string" ? content : JSON.stringify(content);
  return text.replace(/\s+/g, " ").slice(0, 60);
}

/**
 * An interactive session: dependencies (model, tools, MCP) are set up once and
 * reused across turns, so the prompt prefix is stable and the KV cache stays warm
 * from one turn to the next.
 */
export class ChatSession {
  private constructor(
    private readonly cwd: string,
    private readonly deps: AgentDeps,
    private readonly session: StoredSession,
    private readonly maxSteps: number,
  ) {}

  static async start(opts: { cwd: string; model?: string; resumeId?: string; maxSteps?: number }): Promise<ChatSession> {
    const deps = await prepareAgent({ cwd: opts.cwd, model: opts.model });
    const session = opts.resumeId ? (await loadSession(opts.cwd, opts.resumeId)) : null;
    return new ChatSession(opts.cwd, deps, session ?? newStoredSession(), opts.maxSteps ?? 30);
  }

  get id(): string {
    return this.session.id;
  }

  get turns(): number {
    return this.session.messages.filter((m) => m.role === "user").length;
  }

  /** Run one user turn, streaming events; the growing history is persisted after. */
  async *turn(input: string, tracer: Tracer): AsyncGenerator<AgentEvent> {
    this.session.messages.push({ role: "user", content: input });
    const generated = yield* streamMessages(this.session.messages, this.deps, { tracer, maxSteps: this.maxSteps });
    this.session.messages.push(...generated);
    await saveSession(this.cwd, this.session);
  }

  close(): void {
    this.deps.closeMcp();
  }
}
