/**
 * Keyless public-demo MCP sessions (apps/mcp/src/http.ts): `claude mcp add --transport http reins <url>` with no key.
 * Each MCP session mints its own per-visitor demo key through the real web router, so sessions never share velocity
 * counts, requests or ledger rows. Keyed requests and non-demo deployments behave as before.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { updateWorkspace } from "@reins/db";
import { createTestContext } from "@reins/core/testing";
import { seedDemo } from "../../../scripts/seed.ts";
import { createRouter } from "../src/server/router.ts";
import { RateLimiter } from "../src/server/rateLimit.ts";
import { createMcpHttpHandler, keylessDemoFromEnv, mcpClientIp, type McpHttpOptions } from "../../mcp/src/http.ts";
import { PRESETS } from "../src/app/try/presets.ts";

const WEB = "https://reins-web.test";
const MCP = "https://reins-mcp.test/mcp";
const SECRET = "mint-secret-for-tests";

const prev = process.env.REINS_PUBLIC_DEMO;
beforeEach(() => {
  process.env.REINS_PUBLIC_DEMO = "1"; // playgroundEnabled() on the web side reads it
});
afterEach(() => {
  if (prev === undefined) delete process.env.REINS_PUBLIC_DEMO;
  else process.env.REINS_PUBLIC_DEMO = prev;
});

async function stack(mcpOpts: McpHttpOptions = {}, web: { mintSecret?: string; limiter?: RateLimiter } = { mintSecret: SECRET }) {
  const ctx = await createTestContext();
  await seedDemo(ctx.db, { connectDemoMerchant: true, env: { PAYPAL_ENV: "fake" } });
  await updateWorkspace(ctx.db, { paymentMode: "supervised" });
  const webHandle = createRouter(async () => ctx, { publicDemo: true, mcpMintSecret: web.mintSecret, rateLimiter: web.limiter });
  const webCalls: string[] = [];
  const webFetch = async (input: string, init?: RequestInit) => {
    webCalls.push(`${init?.method ?? "GET"} ${new URL(input).pathname}`);
    return webHandle(new Request(input, init));
  };
  const mcp = createMcpHttpHandler(WEB, webFetch, { keylessDemo: true, mintSecret: SECRET, ...mcpOpts });
  /** An MCP client for one "machine" (client IP via CF-Connecting-IP, as Cloudflare sets it). */
  const client = async (ip = "198.51.100.1", headers: Record<string, string> = {}) => {
    const c = new Client({ name: "judge", version: "0" });
    const transport = new StreamableHTTPClientTransport(new URL(MCP), {
      fetch: async (input, init) => {
        const h = new Headers(init?.headers);
        h.set("cf-connecting-ip", ip);
        for (const [k, v] of Object.entries(headers)) h.set(k, v);
        return mcp(new Request(String(input), { ...init, headers: h }));
      },
    });
    await c.connect(transport);
    return { c, transport };
  };
  return { ctx, mcp, webHandle, webCalls, client };
}

const text = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]!.text);
const sc = (r: unknown) => (r as { structuredContent: Record<string, unknown> }).structuredContent;
const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } };
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(MCP, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: new TextEncoder().encode(JSON.stringify(body)) }); // bytes, like the Node adapter

describe("keyless MCP sessions on the public demo", () => {
  it("is on only with REINS_PUBLIC_DEMO=1, and REINS_MCP_KEYLESS_DEMO=0 turns it off", () => {
    expect(keylessDemoFromEnv({ REINS_PUBLIC_DEMO: "1" })).toBe(true);
    expect(keylessDemoFromEnv({ REINS_PUBLIC_DEMO: "1", REINS_MCP_KEYLESS_DEMO: "1" })).toBe(true);
    expect(keylessDemoFromEnv({ REINS_PUBLIC_DEMO: "1", REINS_MCP_KEYLESS_DEMO: "0" })).toBe(false);
    expect(keylessDemoFromEnv({ REINS_MCP_KEYLESS_DEMO: "1" })).toBe(false);
    expect(keylessDemoFromEnv({})).toBe(false);
  });

  it("a non-demo deployment still answers 401 without a key and mints nothing", async () => {
    const { mcp, webCalls } = await stack({ keylessDemo: false });
    const r = await mcp(post(init));
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toBe("Bearer");
    expect(r.headers.get("mcp-session-id")).toBeNull();
    expect(webCalls).toEqual([]);
  });

  it("initialize without a key opens a session bound to a fresh Playground Agent demo key", async () => {
    const { client, webCalls, mcp } = await stack();
    const { c, transport } = await client();
    expect(transport.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(webCalls).toEqual(["GET /api/try/connect"]);
    const m = sc(await c.callTool({ name: "get_mandate", arguments: {} }));
    expect((m.agent as { name: string }).name).toBe("Playground Agent");
    expect(mcp.sessionCount()).toBe(1);
    // keyless needs a session: a tool call without one is refused, an unknown session is 404
    expect((await mcp(post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }))).status).toBe(400);
    expect((await mcp(post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, { "mcp-session-id": "nope" }))).status).toBe(404);
    // no standalone SSE stream (JSON responses only)
    expect((await mcp(new Request(MCP, { method: "GET", headers: { "mcp-session-id": transport.sessionId! } }))).status).toBe(405);
    await transport.terminateSession();
    expect(mcp.sessionCount()).toBe(0);
  });

  it("two sessions are isolated: own velocity window, own requests, own ledger rows; the 4th $29 call in one session is denied", async () => {
    const { client } = await stack();
    const a = (await client("198.51.100.1")).c;
    const b = (await client("198.51.100.2")).c;
    const split = PRESETS.find((p) => p.id === "split")!.purchase as Record<string, string>;
    const buy = (c: Client, i: number) => c.callTool({ name: "request_purchase", arguments: { ...split, client_request_id: `s-${i}` } });
    const statusesA: string[] = [];
    for (let i = 0; i < 4; i++) statusesA.push(String(sc(await buy(a, i)).status));
    expect(statusesA.slice(0, 3).every((s) => ["paid", "awaiting_buyer"].includes(s))).toBe(true);
    expect(statusesA[3]).toBe("denied");
    // B is untouched by A's three paid orders
    const first = sc(await buy(b, 0));
    expect(["paid", "awaiting_buyer"]).toContain(first.status);
    const txA = text(await a.callTool({ name: "list_transactions", arguments: { limit: 20 } }));
    const txB = text(await b.callTool({ name: "list_transactions", arguments: { limit: 20 } }));
    const idsB = ((sc(await b.callTool({ name: "list_transactions", arguments: { limit: 20 } })).transactions as Array<{ request_id: string }>) ?? []).map((t) => t.request_id);
    const idsA = ((sc(await a.callTool({ name: "list_transactions", arguments: { limit: 20 } })).transactions as Array<{ request_id: string }>) ?? []).map((t) => t.request_id);
    expect(idsA.length).toBeGreaterThanOrEqual(3);
    expect(idsB).toEqual([first.request_id]);
    expect(idsA).not.toContain(first.request_id);
    expect(txA).not.toBe(txB);
    // B cannot read A's request
    const peek = await b.callTool({ name: "get_request_status", arguments: { request_id: idsA[0]! } });
    expect(peek.isError).toBe(true);
  });

  it("new sessions are rate-limited per client IP (CF-Connecting-IP), and a forged X-Forwarded-For does not get around it", async () => {
    const { mcp } = await stack({ limits: { perIpCapacity: 2, perIpRefillPerMinute: 0 } });
    const from = (ip: string, xff: string) => mcp(post(init, { "cf-connecting-ip": ip, "x-forwarded-for": xff }));
    expect((await from("203.0.113.7", "1.1.1.1")).status).toBe(200);
    expect((await from("203.0.113.7", "2.2.2.2")).status).toBe(200);
    const third = await from("203.0.113.7", "3.3.3.3");
    expect(third.status).toBe(429);
    expect(third.headers.get("retry-after")).toBeTruthy();
    // another client is not affected
    expect((await from("203.0.113.8", "1.1.1.1")).status).toBe(200);
    // without CF-Connecting-IP the rightmost X-Forwarded-For hop counts, never the client-written leftmost one
    expect(mcpClientIp(new Request(MCP, { headers: { "x-forwarded-for": "6.6.6.6, 10.0.0.5" } }))).toBe("10.0.0.5");
    expect(mcpClientIp(new Request(MCP), "10.1.1.1")).toBe("10.1.1.1");
  });

  it("caps live sessions per client, groups IPv6 by /64, and closes sessions past their absolute lifetime", async () => {
    let t = 5_000_000;
    const { mcp } = await stack({ now: () => t, limits: { perIpSessions: 2, maxAgeMs: 3_600_000, idleMs: 7_200_000 } });
    const open = async (ip: string) => mcp(post(init, { "cf-connecting-ip": ip }));
    const s1 = (await open("2001:db8:1:2::a")).headers.get("mcp-session-id")!;
    expect((await open("2001:db8:1:2:ffff::b")).status).toBe(200);
    expect((await open("2001:0db8:0001:0002::c")).status).toBe(429); // same /64
    expect((await open("2001:db8:1:3::a")).status).toBe(200); // another /64
    expect(mcpClientIp(new Request(MCP, { headers: { "cf-connecting-ip": "2001:db8:1:2::a" } }))).toBe("2001:db8:1:2::/64");
    // kept busy, still closed after the absolute lifetime
    for (let i = 0; i < 3; i++) {
      t += 1_500_000;
      const r = await mcp(post({ jsonrpc: "2.0", id: 10 + i, method: "tools/list", params: {} }, { "mcp-session-id": s1, "mcp-protocol-version": "2025-03-26" }));
      expect(r.status).toBe(i < 2 ? 200 : 404);
    }
  });

  it("caps live sessions and closes idle ones", async () => {
    let t = 1_000_000;
    const { mcp } = await stack({ now: () => t, limits: { maxSessions: 2, idleMs: 60_000 } });
    const open = async (ip: string) => mcp(post(init, { "cf-connecting-ip": ip }));
    const s1 = (await open("192.0.2.1")).headers.get("mcp-session-id")!;
    expect((await open("192.0.2.2")).status).toBe(200);
    expect((await open("192.0.2.3")).status).toBe(503);
    t += 61_000;
    // both idle: swept on the next initialize, which then succeeds
    expect((await open("192.0.2.3")).status).toBe(200);
    expect(mcp.sessionCount()).toBe(1);
    expect((await mcp(post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, { "mcp-session-id": s1 }))).status).toBe(404);
  });

  it("without the mint secret the web API's per-IP connect bucket applies to the MCP server; with it, it does not", async () => {
    const tight = () => new RateLimiter({ connect: { capacity: 1, refillPerMinute: 0 } }, () => 0);
    const withSecret = await stack({}, { mintSecret: SECRET, limiter: tight() });
    expect((await withSecret.mcp(post(init, { "cf-connecting-ip": "192.0.2.10" }))).status).toBe(200);
    expect((await withSecret.mcp(post(init, { "cf-connecting-ip": "192.0.2.11" }))).status).toBe(200);
    const noSecret = await stack({ mintSecret: "" }, { mintSecret: SECRET, limiter: tight() });
    expect((await noSecret.mcp(post(init, { "cf-connecting-ip": "192.0.2.10" }))).status).toBe(200);
    expect((await noSecret.mcp(post(init, { "cf-connecting-ip": "192.0.2.11" }))).status).toBe(503);
  });

  it("a keyless session renews its demo key once if the web API forgot it (restart)", async () => {
    const { client, ctx } = await stack();
    const { c } = await client();
    const { revokeDemoKeys } = await import("@reins/core");
    const { listAgents } = await import("@reins/db");
    const pg = (await listAgents(ctx.db)).find((x) => x.name === "Playground Agent")!;
    revokeDemoKeys(ctx.db, [pg.id]);
    const res = await c.callTool({ name: "get_mandate", arguments: {} });
    expect(res.isError).toBeFalsy();
  });

  it("the keyed path is unchanged: stateless, the caller's key is forwarded, no session is created", async () => {
    const { mcp, webCalls } = await stack();
    const r = await mcp(post(init, { authorization: "Bearer rk_live_doesnotexist" }));
    expect(r.status).toBe(200);
    expect(r.headers.get("mcp-session-id")).toBeNull();
    const call = await mcp(post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_mandate", arguments: {} } }, { authorization: "Bearer rk_live_doesnotexist" }));
    const body = (await call.json()) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]!.text).toContain("invalid_key");
    expect(webCalls).toEqual(["GET /api/mandate"]);
    expect(mcp.sessionCount()).toBe(0);
    // a malformed Authorization header is still a 401, never a keyless session
    expect((await mcp(post(init, { authorization: "Bearer nope" }))).status).toBe(401);
  });

  it("the connect response offers the keyless one-liner first on the hosted public demo", async () => {
    const ctx = await createTestContext({ config: { publicBaseUrl: "https://reins-web.onrender.com" } });
    await seedDemo(ctx.db, { connectDemoMerchant: true, env: { PAYPAL_ENV: "fake" } });
    const { playgroundConnect } = await import("@reins/core");
    const c = await playgroundConnect(ctx, "visitor-keyless-01");
    expect(c.claude_code_command_keyless).toBe("claude mcp add --transport http reins https://reins-mcp.onrender.com/mcp");
    expect(Object.keys(c).indexOf("claude_code_command_keyless")).toBeLessThan(Object.keys(c).indexOf("claude_code_command"));
    delete process.env.REINS_PUBLIC_DEMO;
    expect((await playgroundConnect(ctx, "visitor-keyless-02")).claude_code_command_keyless).toBeNull();
  });
});
