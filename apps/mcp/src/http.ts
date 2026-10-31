import { createServer, type IncomingMessage } from "node:http";
import { pathToFileURL } from "node:url";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { ReinsApi, type FetchLike } from "./api.ts";
import { createReinsMcpServer } from "./server.ts";

/**
 * Streamable HTTP endpoint (stateless). Each request carries the agent's Bearer key, which is forwarded to the
 * Reins REST API; the MCP server itself stores nothing.
 */
export function createMcpHttpHandler(apiBaseUrl: string, fetchImpl?: FetchLike) {
  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") return new Response("ok");
    if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 });
    const auth = req.headers.get("authorization") ?? "";
    const key = /^Bearer\s+(rk_[A-Za-z0-9_]+)$/.exec(auth)?.[1];
    if (!key) {
      return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Missing Authorization: Bearer <Reins agent key>" }, id: null }), {
        status: 401,
        headers: { "content-type": "application/json", "www-authenticate": "Bearer" },
      });
    }
    const server = createReinsMcpServer(new ReinsApi(apiBaseUrl, key, fetchImpl));
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(req);
    } finally {
      // stateless: tear down after the response is produced
      void transport.close();
      void server.close();
    }
  };
}

/**
 * Reins web API base URL: REINS_API_URL, else REINS_API_HOSTPORT over Render's private network
 * (render.yaml fills it from the web service's `hostport`, e.g. "reins-web:10000").
 */
export function apiBaseUrlFromEnv(env: Record<string, string | undefined>): string {
  if (env.REINS_API_URL) return env.REINS_API_URL;
  if (env.REINS_API_HOSTPORT) return `http://${env.REINS_API_HOSTPORT}`;
  return "http://localhost:3000";
}

async function toRequest(req: IncomingMessage, origin: string): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  const body = chunks.length && req.method !== "GET" && req.method !== "HEAD" ? Buffer.concat(chunks) : undefined;
  return new Request(new URL(req.url ?? "/", origin), { method: req.method, headers, body });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const port = Number(process.env.PORT ?? 3333);
  const handle = createMcpHttpHandler(apiBaseUrlFromEnv(process.env));
  createServer(async (req, res) => {
    try {
      const response = await handle(await toRequest(req, `http://localhost:${port}`));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      res.writeHead(500).end();
    }
  }).listen(port, () => console.error(`[reins-mcp] Streamable HTTP on :${port}/mcp`));
}
