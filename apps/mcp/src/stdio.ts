import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ReinsApi } from "./api.ts";
import { createReinsMcpServer } from "./server.ts";

const key = process.env.REINS_API_KEY;
if (!key) {
  console.error("[reins-mcp] REINS_API_KEY is required (the rk_live_... key shown when you created the agent)");
  process.exit(1);
}
const server = createReinsMcpServer(new ReinsApi(process.env.REINS_URL ?? process.env.REINS_API_URL ?? "http://localhost:3000", key));
await server.connect(new StdioServerTransport());
console.error("[reins-mcp] stdio server ready");
