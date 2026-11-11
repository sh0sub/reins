import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { pathToFileURL } from "node:url";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { ReinsApi, type FetchLike } from "./api.ts";
import { createReinsMcpServer } from "./server.ts";

const jsonRpcError = (status: number, code: number, message: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

/** Abuse limits for keyless demo sessions (one free Render instance, in memory). */
export const KEYLESS_LIMITS = {
  /** New sessions per client IP: a burst of 10, then one every 3 minutes (a judge restarting Claude Code a few times). */
  perIpCapacity: 10,
  perIpRefillPerMinute: 1 / 3,
  /** Live sessions across all clients. */
  maxSessions: 300,
  /** A session nobody used for this long is closed; the client then gets 404 and starts a new one. */
  idleMs: 30 * 60_000,
  /** Live sessions per client address, so a few clients cannot hold every slot by pinging. */
  perIpSessions: 5,
  /** Absolute lifetime: even a session kept busy is closed after this. */
  maxAgeMs: 6 * 3_600_000,
};

export interface McpHttpOptions {
  /**
   * Keyless public demo: a request without Authorization may `initialize` a session, and that session gets its own
   * per-visitor demo key (Playground Agent, own velocity scope) minted from the web API. Default: keylessDemoFromEnv.
   */
  keylessDemo?: boolean;
  /** Shared with reins-web (REINS_MCP_MINT_SECRET): lets the web API skip its per-IP key limit for this server. */
  mintSecret?: string;
  limits?: Partial<typeof KEYLESS_LIMITS>;
  now?: () => number;
}

/** Keyless sessions only exist on the public demo: REINS_PUBLIC_DEMO=1 and REINS_MCP_KEYLESS_DEMO not "0". */
export function keylessDemoFromEnv(env: Record<string, string | undefined>): boolean {
  return env.REINS_PUBLIC_DEMO === "1" && env.REINS_MCP_KEYLESS_DEMO !== "0";
}

/**
 * Client address for the per-IP session limit. reins-mcp.onrender.com is served through Cloudflare, which sets
 * CF-Connecting-IP itself and overwrites a value the client sent, so that header is trusted first. Without it, the
 * rightmost X-Forwarded-For entry (appended by the proxy closest to us, not by the client) and then the socket
 * address are used; the leftmost X-Forwarded-For entry is never trusted because any client can write it.
 */
export function mcpClientIp(req: Request, remoteAddress?: string): string {
  const cf = req.headers.get("cf-connecting-ip")?.trim();
  const hops = (req.headers.get("x-forwarded-for") ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  return clientKey(cf || hops.at(-1) || remoteAddress || "unknown");
}

/** IPv6 clients are limited per /64 (one host usually owns a whole /64); IPv4 per address. */
function clientKey(ip: string): string {
  if (!ip.includes(":") || /^::ffff:\d/.test(ip)) return ip.replace(/^::ffff:/, "");
  const [head = "", tail = ""] = ip.toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = ip.includes("::") ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right] : left;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

interface Session {
  transport: WebStandardStreamableHTTPServerTransport;
  server: McpServer;
  lastSeen: number;
  createdAt: number;
  client: string;
}

/**
 * Streamable HTTP endpoint.
 * - With `Authorization: Bearer rk_...`: stateless. The key is forwarded to the Reins REST API; nothing is stored.
 * - Without a key, on the public demo only: `initialize` opens a session (Mcp-Session-Id) bound to a fresh per-visitor
 *   demo key, so two sessions never share velocity counts, requests or ledger rows. Everywhere else: 401.
 */
export function createMcpHttpHandler(apiBaseUrl: string, fetchImpl?: FetchLike, opts: McpHttpOptions = {}) {
  const keyless = opts.keylessDemo ?? keylessDemoFromEnv(process.env);
  const mintSecret = opts.mintSecret ?? process.env.REINS_MCP_MINT_SECRET;
  const limits = { ...KEYLESS_LIMITS, ...opts.limits };
  const now = opts.now ?? Date.now;
  const doFetch: FetchLike = fetchImpl ?? ((i, init) => fetch(i, init));
  const base = apiBaseUrl.replace(/\/$/, "");
  const sessions = new Map<string, Session>();
  const buckets = new Map<string, { tokens: number; at: number }>();

  const takeToken = (ip: string): boolean => {
    const t = now();
    const b = buckets.get(ip) ?? { tokens: limits.perIpCapacity, at: t };
    b.tokens = Math.min(limits.perIpCapacity, b.tokens + ((t - b.at) * limits.perIpRefillPerMinute) / 60_000);
    b.at = t;
    if (buckets.size > 10_000) buckets.clear();
    const ok = b.tokens >= 1;
    if (ok) b.tokens -= 1;
    buckets.set(ip, b);
    return ok;
  };

  const closeSession = (id: string) => {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    void s.transport.close();
    void s.server.close();
  };
  const stale = (s: Session) => s.lastSeen <= now() - limits.idleMs || s.createdAt <= now() - limits.maxAgeMs;
  const sweep = () => {
    for (const [id, s] of sessions) if (stale(s)) closeSession(id);
  };
  /** Initializes still minting their key, so concurrent initializes cannot overshoot the caps. */
  const pending = new Map<string, number>();

  /** A fresh per-visitor demo key from the web API (random visitor id, so every session gets its own scope). */
  const mintDemoKey = async (): Promise<string> => {
    const headers: Record<string, string> = { accept: "application/json", cookie: `reins_try=${randomBytes(12).toString("hex")}` };
    if (mintSecret) headers["x-reins-mint-secret"] = mintSecret;
    const res = await doFetch(`${base}/api/try/connect`, { method: "GET", headers });
    const body = (await res.json().catch(() => ({}))) as { api_key?: unknown };
    if (!res.ok || typeof body.api_key !== "string" || !body.api_key.startsWith("rk_demo_")) {
      throw new Error(`demo key unavailable (HTTP ${res.status})`);
    }
    return body.api_key;
  };

  async function keylessRequest(req: Request, remoteAddress?: string): Promise<Response> {
    const sessionId = req.headers.get("mcp-session-id");
    if (sessionId) {
      const s = sessions.get(sessionId);
      if (!s || stale(s)) {
        closeSession(sessionId);
        return jsonRpcError(404, -32001, "Session not found or expired. Start a new session (initialize).");
      }
      // no standalone SSE stream: responses are plain JSON (the client treats 405 as "no GET stream")
      if (req.method === "GET") return new Response(null, { status: 405, headers: { allow: "POST, DELETE" } });
      s.lastSeen = now();
      const res = await s.transport.handleRequest(req);
      if (req.method === "DELETE") closeSession(sessionId);
      return res;
    }
    if (req.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return jsonRpcError(400, -32700, "Parse error");
    }
    if (!(Array.isArray(body) ? body.some(isInitializeRequest) : isInitializeRequest(body))) {
      return jsonRpcError(400, -32000, "No session: send initialize first (keyless demo), or use Authorization: Bearer <Reins agent key>");
    }
    sweep();
    const client = mcpClientIp(req, remoteAddress);
    const inFlight = [...pending.values()].reduce((a, b) => a + b, 0);
    if (sessions.size + inFlight >= limits.maxSessions) return jsonRpcError(503, -32000, "The public demo is at its session limit. Try again in a few minutes.", { "retry-after": "60" });
    const mine = [...sessions.values()].filter((x) => x.client === client).length + (pending.get(client) ?? 0);
    if (mine >= limits.perIpSessions) return jsonRpcError(429, -32000, "Too many open sessions from this address. Close one or wait for it to go idle (30 minutes).", { "retry-after": "300" });
    if (!takeToken(client)) return jsonRpcError(429, -32000, "Too many new sessions from this address. Try again in a few minutes.", { "retry-after": "180" });
    let key: string;
    pending.set(client, (pending.get(client) ?? 0) + 1);
    try {
      key = await mintDemoKey();
    } catch (err) {
      return jsonRpcError(503, -32000, `Couldn't open a demo session: ${err instanceof Error ? err.message : "error"}. Try again shortly.`);
    } finally {
      const n = (pending.get(client) ?? 1) - 1;
      if (n > 0) pending.set(client, n);
      else pending.delete(client);
    }
    // one renewal at a time per session (two calls failing together must not mint two keys)
    let renewing: Promise<string> | null = null;
    const renew = () => (renewing ??= mintDemoKey().finally(() => (renewing = null)));
    const server = createReinsMcpServer(new ReinsApi(base, key, doFetch, renew));
    const transport: WebStandardStreamableHTTPServerTransport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, server, lastSeen: now(), createdAt: now(), client });
      },
    });
    await server.connect(transport);
    // the body was read above to check for initialize; hand it over instead of re-reading the stream
    const res = await transport.handleRequest(req, { parsedBody: body });
    if (!transport.sessionId || !sessions.has(transport.sessionId)) {
      void transport.close();
      void server.close();
    }
    return res;
  }

  async function handle(req: Request, remoteAddress?: string): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      // ?detail=1: whether keyless sessions are on and the shared mint secret is present (never its value)
      if (url.searchParams.get("detail") !== "1") return new Response("ok");
      return Response.json({ ok: true, keyless_demo: keyless, mint_secret: !!mintSecret, sessions: sessions.size });
    }
    if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 });
    const auth = req.headers.get("authorization") ?? "";
    if (!auth && keyless) return keylessRequest(req, remoteAddress);
    const key = /^Bearer\s+(rk_[A-Za-z0-9_]+)$/.exec(auth)?.[1];
    if (!key) return jsonRpcError(401, -32001, "Missing Authorization: Bearer <Reins agent key>", { "www-authenticate": "Bearer" });
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
  }
  return Object.assign(handle, { sessionCount: () => sessions.size });
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
      const response = await handle(await toRequest(req, `http://localhost:${port}`), req.socket.remoteAddress);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      res.writeHead(500).end();
    }
  }).listen(port, () => {
    console.error(`[reins-mcp] Streamable HTTP on :${port}/mcp`);
    // presence only, never the value: without the shared secret every keyless mint shares reins-web's per-IP limit
    if (keylessDemoFromEnv(process.env)) console.error(`[reins-mcp] keyless demo sessions on; mint secret ${process.env.REINS_MCP_MINT_SECRET ? "set" : "MISSING (set REINS_MCP_MINT_SECRET on reins-web and reins-mcp)"}`);
  });
}
