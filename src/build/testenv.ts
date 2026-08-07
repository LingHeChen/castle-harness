import type { Subprocess } from "bun";

/**
 * The integration test environment — a subsystem, not more test files.
 *
 * Unit acceptance (`bun test <file>` per task) proves each piece in isolation, but
 * the bugs that matter for a real app live in the seams: the DB↔API↔client
 * boundary, state machines, two users racing for the last item. Exercising those
 * needs a live app: bring the server (and its DB) up, wait until it's actually
 * serving, let tests hit it, then tear it all down — reliably, even when the
 * server crashes on boot. That lifecycle is what this module owns. The integration
 * phase (integration.ts) drives it; here we just make "up, ready, down" trustworthy.
 */

export type ReadyProbe =
  /** ready when GET {path} returns a status below {below} (default 500) — a live server */
  | { type: "http"; path: string; below?: number }
  /** ready when a TCP connection to the port succeeds — for non-HTTP servers */
  | { type: "tcp" };

export type StartOptions = {
  cwd: string;
  /** argv to launch the server, e.g. ["bun", "run", "server.ts"]. PORT is injected into env. */
  command: string[];
  port: number;
  host?: string; // default 127.0.0.1
  env?: Record<string, string>;
  ready?: ReadyProbe; // default { type: "http", path: "/" }
  timeoutMs?: number; // default 20_000
  pollMs?: number; // default 200
};

export type ServerHandle = {
  baseUrl: string;
  port: number;
  pid: number;
  /** Everything the server wrote to stdout+stderr so far (for diagnosing a failed boot). */
  logs(): string;
  /** Graceful shutdown (SIGTERM), escalating to SIGKILL if it doesn't exit. */
  stop(): Promise<void>;
};

export class ServerStartError extends Error {
  constructor(message: string, readonly logs: string) {
    super(logs ? `${message}\n--- server output ---\n${logs}` : message);
    this.name = "ServerStartError";
  }
}

/**
 * Spawn the app server, wait until it is actually accepting requests, and return a
 * handle. Throws {@link ServerStartError} (with captured output) if the process
 * dies during boot or never becomes ready before the timeout — a hung or
 * crash-on-boot server fails loudly here instead of causing every test to time out.
 */
export async function startServer(opts: StartOptions): Promise<ServerHandle> {
  const host = opts.host ?? "127.0.0.1";
  const ready = opts.ready ?? { type: "http", path: "/" };
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const pollMs = opts.pollMs ?? 200;
  const baseUrl = `http://${host}:${opts.port}`;

  const proc = Bun.spawn(opts.command, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env, PORT: String(opts.port) },
    stdout: "pipe",
    stderr: "pipe",
  });

  // Continuously drain stdout/stderr into a buffer so logs() is available at any
  // point (including after a crash), without blocking on stream close.
  const chunks: string[] = [];
  const dec = new TextDecoder();
  const drain = async (stream: ReadableStream<Uint8Array> | undefined) => {
    if (!stream) return;
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(dec.decode(value));
      }
    } catch {
      /* stream closed on teardown */
    }
  };
  void drain(proc.stdout);
  void drain(proc.stderr);
  const logs = () => chunks.join("");

  const handle: ServerHandle = {
    baseUrl,
    port: opts.port,
    pid: proc.pid,
    logs,
    stop: () => stopProcess(proc, host, opts.port),
  };

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new ServerStartError(`server process exited (code ${proc.exitCode}) before becoming ready`, logs());
    }
    if (await probe(baseUrl, host, opts.port, ready, pollMs)) return handle;
    await sleep(pollMs);
  }

  await stopProcess(proc, host, opts.port);
  throw new ServerStartError(`server did not become ready within ${timeoutMs}ms`, logs());
}

/** One readiness check. A resolved connection/response means "listening"; refusal means "not yet". */
async function probe(baseUrl: string, host: string, port: number, ready: ReadyProbe, pollMs: number): Promise<boolean> {
  if (ready.type === "http") {
    try {
      const res = await fetch(baseUrl + ready.path, { signal: AbortSignal.timeout(Math.max(pollMs * 4, 1000)) });
      return res.status < (ready.below ?? 500); // any real response (even 404) proves it's up
    } catch {
      return false; // connection refused / still booting
    }
  }
  // tcp: a successful connect is enough
  try {
    const socket = await Bun.connect({ hostname: host, port, socket: { data() {}, open(s) { s.end(); }, error() {} } });
    socket.end();
    return true;
  } catch {
    return false;
  }
}

/**
 * SIGTERM the whole process tree, then SIGKILL it if it doesn't exit in time.
 * Killing the tree (not just `proc`) matters because a launcher like `bun run
 * server.ts` forks the real server as a child — killing only the launcher would
 * orphan the server and leave the port bound.
 */
async function stopProcess(proc: Subprocess, host: string, port: number): Promise<void> {
  const closed = () => portClosed(host, port);
  await killTree(proc.pid, "SIGTERM");
  await killListeners(port, "SIGTERM");
  if (await waitFor(closed, 2000)) return;
  // Still bound — escalate to SIGKILL of the tree and whatever holds the port.
  await killTree(proc.pid, "SIGKILL");
  await killListeners(port, "SIGKILL");
  await waitFor(closed, 1500);
}

/** True once nothing accepts a TCP connection on the port (the real teardown signal). */
async function portClosed(host: string, port: number): Promise<boolean> {
  try {
    const s = await Bun.connect({ hostname: host, port, socket: { data() {}, open(x) { x.end(); }, error() {} } });
    s.end();
    return false;
  } catch {
    return true;
  }
}

async function waitFor(cond: () => Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await sleep(120);
  }
  return cond();
}

/** SIGKILL/SIGTERM whatever process is LISTENing on the port (covers reparented children). */
async function killListeners(port: number, signal: "SIGTERM" | "SIGKILL"): Promise<void> {
  try {
    const proc = Bun.spawn(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    for (const pid of out.split("\n").map((s) => Number.parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n) && n > 0)) {
      try {
        process.kill(pid, signal);
      } catch {
        /* gone */
      }
    }
  } catch {
    /* lsof unavailable */
  }
}

/** Kill a pid and all its descendants (children first so pgrep can still see them). */
async function killTree(pid: number, signal: "SIGTERM" | "SIGKILL"): Promise<void> {
  for (const child of await childPids(pid)) await killTree(child, signal);
  try {
    process.kill(pid, signal);
  } catch {
    /* already gone */
  }
}

async function childPids(pid: number): Promise<number[]> {
  try {
    const proc = Bun.spawn(["pgrep", "-P", String(pid)], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    return out
      .split("\n")
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return [];
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Find a currently-free TCP port by binding to :0 and reading the assigned port.
 * There's an inherent race (the port could be taken before the caller uses it), so
 * this is for test/dev orchestration, not a hard guarantee.
 */
export async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = server.port ?? 0;
  server.stop(true);
  return port;
}
