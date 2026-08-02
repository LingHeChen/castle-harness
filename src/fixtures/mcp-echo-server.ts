/**
 * A minimal MCP stdio server used only in tests: newline-delimited JSON-RPC on
 * stdin/stdout, exposing a single `echo` tool. Enough to exercise the client's
 * handshake → list → call path without any network dependency.
 */
function send(msg: object): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function handle(msg: { id?: number; method?: string; params?: { arguments?: { text?: string } } }): void {
  switch (msg.method) {
    case "initialize":
      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "echo", version: "0" } } });
      break;
    case "notifications/initialized":
      break; // notification — no response
    case "tools/list":
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { tools: [{ name: "echo", description: "Echo back the given text.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] },
      });
      break;
    case "tools/call":
      send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `echo: ${msg.params?.arguments?.text ?? ""}` }] } });
      break;
  }
}

let buf = "";
const dec = new TextDecoder();
const reader = Bun.stdin.stream().getReader();
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) handle(JSON.parse(line));
  }
}
