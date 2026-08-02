import { test, expect } from "bun:test";
import { join } from "node:path";
import { McpClient, toolsFromMcp } from "./core/mcp";

const FIXTURE = join(import.meta.dir, "fixtures/mcp-echo-server.ts");

test("MCP stdio client: handshake → list → call round-trip", async () => {
  const client = new McpClient();
  await client.connect({ command: "bun", args: [FIXTURE] });

  const tools = await client.listTools();
  expect(tools.map((t) => t.name)).toContain("echo");

  const out = await client.callTool("echo", { text: "hello mcp" });
  expect(out).toBe("echo: hello mcp");

  client.close();
});

test("toolsFromMcp namespaces and proxies MCP tools", async () => {
  const client = new McpClient();
  await client.connect({ command: "bun", args: [FIXTURE] });
  const toolset = toolsFromMcp("demo", client, await client.listTools());

  expect(Object.keys(toolset)).toContain("mcp__demo__echo");
  const exec = (toolset["mcp__demo__echo"] as { execute?: (i: unknown, o: unknown) => Promise<unknown> }).execute!;
  expect(await exec({ text: "via registry" }, {})).toBe("echo: via registry");

  client.close();
});
