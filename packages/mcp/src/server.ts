import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createClient } from "./client.js";
import { TOOLS } from "./tools.js";

export interface ServerOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export function createServer(opts: ServerOptions): McpServer {
  const server = new McpServer({ name: "alerting", version: "0.0.0" });
  const client = createClient(opts);
  for (const t of TOOLS) {
    server.registerTool(t.name, { description: t.description, inputSchema: t.shape }, async (args: Record<string, unknown>) => {
      const r = await client.call(t.request(args));
      return { content: [{ type: "text" as const, text: r.text }], ...(r.ok ? {} : { isError: true }) };
    });
  }
  return server;
}
