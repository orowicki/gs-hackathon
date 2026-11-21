#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

const baseUrl = process.env.ALERTING_API_URL || "http://localhost:3000";
await createServer({ baseUrl }).connect(new StdioServerTransport());
console.error(`alerting MCP server ready (API ${baseUrl})`);
