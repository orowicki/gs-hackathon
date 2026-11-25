import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createClient } from "./client.js";
import { PROMPTS } from "./prompts.js";
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
    server.registerTool(t.name, { description: t.description, inputSchema: t.extraKeys ? z.object(t.shape).passthrough() : t.shape }, async (args: Record<string, unknown>) => {
      const r = await client.call(t.request(args));
      return { content: [{ type: "text" as const, text: r.text }], ...(r.ok ? {} : { isError: true }) };
    });
  }
  for (const p of PROMPTS) {
    server.registerPrompt(p.name, { title: p.title, description: p.description, argsSchema: p.args }, (args: Record<string, unknown>) => ({
      messages: [{ role: "user" as const, content: { type: "text" as const, text: p.render(args as Record<string, string | undefined>) } }],
    }));
  }
  return server;
}
