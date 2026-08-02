import { tool, jsonSchema, type ToolSet } from "ai";
import { join } from "node:path";
import type { Subprocess } from "bun";

/**
 * A minimal Model Context Protocol client over the stdio transport.
 *
 * MCP stdio is newline-delimited JSON-RPC 2.0: spawn the server, exchange one
 * JSON object per line over stdin/stdout. The handshake is `initialize` →
 * `notifications/initialized`; then `tools/list` discovers tools and
 * `tools/call` invokes them. We proxy each discovered tool into the agent's
 * registry, namespaced `mcp__<server>__<tool>`, so from the loop's point of view
 * an MCP tool is just another tool.
 *
 * Hand-rolled on purpose: the protocol is small, and owning it is the point.
 */

export type McpServerConfig = { command: string; args?: string[]; env?: Record<string, string> };
export type McpConfig = { servers: Record<string, McpServerConfig> };
type McpTool = { name: string; description?: string; inputSchema?: object };

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export class McpClient {
  private proc?: Subprocess<"pipe", "pipe", "ignore">;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private buffer = "";

  async connect(config: McpServerConfig): Promise<void> {
    this.proc = Bun.spawn([config.command, ...(config.args ?? [])], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, ...(config.env ?? {}) },
    });
    void this.readLoop();
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "castle", version: "0.1.0" },
    });
    this.notify("notifications/initialized", {});
  }

  async listTools(): Promise<McpTool[]> {
    const res = (await this.request("tools/list", {})) as { tools?: McpTool[] };
    return res.tools ?? [];
  }

  async callTool(name: string, args: unknown): Promise<string> {
    const res = (await this.request("tools/call", { name, arguments: args })) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    const text = (res.content ?? []).map((c) => (c.type === "text" ? c.text ?? "" : JSON.stringify(c))).join("\n");
    return res.isError ? `Error: ${text}` : text || "(no output)";
  }

  close(): void {
    this.proc?.kill();
  }

  private async readLoop(): Promise<void> {
    const reader = this.proc!.stdout.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      this.buffer += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (!line) continue;
        try {
          this.handle(JSON.parse(line));
        } catch {
          /* ignore non-JSON lines */
        }
      }
    }
  }

  private handle(msg: { id?: number; result?: unknown; error?: { message: string } }): void {
    if (msg.id == null) return; // server-initiated notification/request — ignore
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message));
    else p.resolve(msg.result);
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    this.write({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private write(msg: object): void {
    this.proc!.stdin.write(JSON.stringify(msg) + "\n");
    this.proc!.stdin.flush();
  }
}

export async function loadMcpConfig(cwd: string): Promise<McpConfig | null> {
  const f = Bun.file(join(cwd, ".castle/mcp.json"));
  if (!(await f.exists())) return null;
  try {
    return (await f.json()) as McpConfig;
  } catch {
    return null;
  }
}

/** Proxy an MCP server's tools into an ai ToolSet, namespaced by server. */
export function toolsFromMcp(serverName: string, client: McpClient, mcp: McpTool[]): ToolSet {
  const out: ToolSet = {};
  for (const t of mcp) {
    out[`mcp__${serverName}__${t.name}`] = tool({
      description: t.description ?? `MCP tool ${t.name}`,
      inputSchema: jsonSchema(t.inputSchema ?? { type: "object", properties: {} }),
      execute: async (args) => client.callTool(t.name, args),
    });
  }
  return out;
}

/** Connect to every server in `.castle/mcp.json` and collect their tools. */
export async function connectConfiguredMcp(cwd: string): Promise<{ tools: ToolSet; close: () => void }> {
  const config = await loadMcpConfig(cwd);
  if (!config) return { tools: {}, close: () => {} };

  const clients: McpClient[] = [];
  let tools: ToolSet = {};
  for (const [name, sc] of Object.entries(config.servers)) {
    try {
      const client = new McpClient();
      await client.connect(sc);
      tools = { ...tools, ...toolsFromMcp(name, client, await client.listTools()) };
      clients.push(client);
    } catch {
      /* a server that won't start shouldn't kill the run */
    }
  }
  return { tools, close: () => clients.forEach((c) => c.close()) };
}
