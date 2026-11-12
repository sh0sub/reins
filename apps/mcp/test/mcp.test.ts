import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ReinsApi } from "../src/api.ts";
import { createReinsMcpServer, summarize, TOOL_NAMES } from "../src/server.ts";
import { apiBaseUrlFromEnv, createMcpHttpHandler } from "../src/http.ts";

type Seen = { url: string; method: string; auth: string | null; body: unknown };
function stubFetch(responses: Record<string, { status?: number; body: unknown }>) {
  const seen: Seen[] = [];
  const fn = async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const key = `${init.method ?? "GET"} ${u.pathname}`;
    seen.push({ url, method: init.method ?? "GET", auth: new Headers(init.headers).get("authorization"), body: init.body ? JSON.parse(String(init.body)) : undefined });
    const r = responses[key] ?? { status: 404, body: { error: "not_found", message: "nope" } };
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  };
  return { fn, seen };
}

async function connect(api: ReinsApi) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createReinsMcpServer(api);
  await server.connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  return client;
}

const paid = { request_id: "req_1", display_id: "R-0001", status: "paid", merchant: "namecheap.com", amount: "12.98", receipt: { capture_id: "8XK21", payout_batch_id: null } };

describe("M4 Reins MCP server", () => {
  it("exposes exactly the 4 tools", async () => {
    const client = await connect(new ReinsApi("http://x", "rk_live_k", stubFetch({}).fn));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    const rp = tools.find((t) => t.name === "request_purchase")!;
    expect(rp.inputSchema.required).toEqual(expect.arrayContaining(["merchant", "amount", "items", "reason"]));
  });

  it("request_purchase forwards Bearer key + idempotency key and summarizes the receipt", async () => {
    const f = stubFetch({ "POST /api/requests": { status: 201, body: paid } });
    const client = await connect(new ReinsApi("http://reins.test/", "rk_live_abc", f.fn));
    const res = await client.callTool({ name: "request_purchase", arguments: { merchant: "namecheap.com", amount: "12.98", items: "reins.dev renewal", reason: "Domain expires Nov 30" } });
    expect(res.isError).toBeFalsy();
    expect((res.content as Array<{ text: string }>)[0]!.text).toContain("Paid $12.98 to namecheap.com (R-0001, capture 8XK21)");
    expect(res.structuredContent).toMatchObject({ status: "paid" });
    expect(f.seen[0]).toMatchObject({ url: "http://reins.test/api/requests", method: "POST", auth: "Bearer rk_live_abc" });
    // M5: no client_request_id -> a hash of the purchase and its 10-minute window, so a retry dedupes
    expect((f.seen[0]!.body as { client_request_id: string }).client_request_id).toMatch(/^mcp-[0-9a-f]{32}$/);
  });

  it("rejects malformed amounts before calling the API", async () => {
    const f = stubFetch({});
    const client = await connect(new ReinsApi("http://x", "rk_live_k", f.fn));
    const res = await client.callTool({ name: "request_purchase", arguments: { merchant: "m.com", amount: "12.999", items: "i", reason: "r" } });
    expect(res.isError).toBe(true);
    expect(f.seen).toHaveLength(0);
  });

  it("request_purchase: recurring monthly/yearly is forwarded, other values are rejected before the API", async () => {
    const f = stubFetch({ "POST /api/requests": { status: 201, body: { ...paid, status: "pending_human", recurring: "monthly" } } });
    const client = await connect(new ReinsApi("http://x", "rk_live_k", f.fn));
    const { tools } = await client.listTools();
    const rp = tools.find((t) => t.name === "request_purchase")!;
    expect(rp.description).toMatch(/set recurring to "monthly" or "yearly"/);
    expect((rp.inputSchema.properties as Record<string, unknown>).recurring).toBeTruthy();
    expect(rp.inputSchema.required).not.toContain("recurring");
    const args = { merchant: "vercel.com", amount: "20.00", items: "Vercel Pro, monthly", reason: "Hosting plan" };
    const bad = await client.callTool({ name: "request_purchase", arguments: { ...args, recurring: "weekly" } });
    expect(bad.isError).toBe(true);
    expect(f.seen).toHaveLength(0);
    const ok = await client.callTool({ name: "request_purchase", arguments: { ...args, recurring: "monthly" } });
    expect(ok.isError).toBeFalsy();
    expect(f.seen[0]!.body).toMatchObject({ recurring: "monthly" });
    await client.callTool({ name: "request_purchase", arguments: args });
    expect((f.seen[1]!.body as Record<string, unknown>).recurring).toBeUndefined();
    // a subscription and a one-off order of the same thing get different default idempotency keys
    expect((f.seen[0]!.body as { client_request_id: string }).client_request_id).not.toBe((f.seen[1]!.body as { client_request_id: string }).client_request_id);
  });

  it("get_mandate / get_request_status / list_transactions hit the right routes", async () => {
    const f = stubFetch({
      "GET /api/mandate": { body: { mandate: { monthly_limit: "150.00" } } },
      "GET /api/requests/req_1": { body: { ...paid, status: "pending_human" } },
      "GET /api/transactions": { body: { transactions: [paid] } },
    });
    const client = await connect(new ReinsApi("http://x", "rk_live_k", f.fn));
    expect(JSON.stringify((await client.callTool({ name: "get_mandate", arguments: {} })).structuredContent)).toContain("150.00");
    expect(((await client.callTool({ name: "get_request_status", arguments: { request_id: "req_1" } })).content as Array<{ text: string }>)[0]!.text).toContain("waiting for human approval");
    expect(((await client.callTool({ name: "list_transactions", arguments: { limit: 5 } })).content as Array<{ text: string }>)[0]!.text).toContain("1 transaction(s)");
    expect(f.seen.map((s) => new URL(s.url).pathname + new URL(s.url).search)).toEqual(["/api/mandate", "/api/requests/req_1", "/api/transactions?limit=5"]);
  });

  it("API errors become isError tool results (e.g. revoked key)", async () => {
    const f = stubFetch({ "GET /api/mandate": { status: 401, body: { error: "invalid_key", message: "Invalid or revoked agent key" } } });
    const client = await connect(new ReinsApi("http://x", "rk_live_k", f.fn));
    const res = await client.callTool({ name: "get_mandate", arguments: {} });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0]!.text).toContain("invalid_key");
  });

  it("summaries tell the agent not to retry denied requests", () => {
    expect(summarize({ status: "denied", amount: "450.00", merchant: "fiverr.com", display_id: "R-0143", reason: "Blocked" })).toContain("Do not retry");
  });
});

describe("M4 Streamable HTTP transport", () => {
  const rpc = (body: unknown, auth?: string) =>
    new Request("http://localhost:3333/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(auth ? { authorization: auth } : {}) },
      body: JSON.stringify(body),
    });
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } };

  it("requires a Bearer agent key", async () => {
    const handle = createMcpHttpHandler("http://x", stubFetch({}).fn);
    expect((await handle(rpc(init))).status).toBe(401);
    expect((await handle(rpc(init, "Bearer not-a-reins-key"))).status).toBe(401);
  });

  it("initializes and lists tools statelessly; tool calls carry the caller's key", async () => {
    const f = stubFetch({ "GET /api/mandate": { body: { mandate: { purpose: "x" } } } });
    const handle = createMcpHttpHandler("http://reins.test", f.fn);
    const r1 = await handle(rpc(init, "Bearer rk_live_http"));
    expect(r1.status).toBe(200);
    expect(((await r1.json()) as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe("reins");
    const r2 = await handle(rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, "Bearer rk_live_http"));
    expect(((await r2.json()) as { result: { tools: unknown[] } }).result.tools).toHaveLength(4);
    const r3 = await handle(rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_mandate", arguments: {} } }, "Bearer rk_live_http"));
    expect(r3.status).toBe(200);
    expect(f.seen[0]!.auth).toBe("Bearer rk_live_http");
  });
});

describe("#38 MCP HTTP on Render: web API base URL", () => {
  it("REINS_API_URL wins, else the private-network hostport, else localhost", () => {
    expect(apiBaseUrlFromEnv({ REINS_API_URL: "https://reins-web.onrender.com", REINS_API_HOSTPORT: "reins-web:10000" })).toBe("https://reins-web.onrender.com");
    expect(apiBaseUrlFromEnv({ REINS_API_HOSTPORT: "reins-web:10000" })).toBe("http://reins-web:10000");
    expect(apiBaseUrlFromEnv({})).toBe("http://localhost:3000");
  });
});

describe("get_request_status waits for a settling payment", () => {
  const paying = { request_id: "req_1", display_id: "R-0001", status: "paying", merchant: "namecheap.com", amount: "12.98", receipt: null };
  const settled = { ...paying, status: "paid", receipt: { capture_id: null, payout_batch_id: "BATCH9" } };
  async function run(answers: Array<Record<string, unknown> | Error>, settleWaitMs?: number) {
    let calls = 0;
    const sleeps: number[] = [];
    const api = {
      getRequestStatus: async () => {
        const a = answers[Math.min(calls++, answers.length - 1)]!;
        if (a instanceof Error) throw a;
        return a;
      },
    } as unknown as ReinsApi;
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createReinsMcpServer(api, { settleWaitMs, sleep: async (ms) => void sleeps.push(ms) }).connect(a);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(b);
    const res = await client.callTool({ name: "get_request_status", arguments: { request_id: "req_1" } });
    return { res, text: (res.content as Array<{ text: string }>)[0]!.text, calls: () => calls, sleeps };
  }

  it("returns paid in one call once the payout settles, and names it a payout", async () => {
    const r = await run([paying, paying, settled]);
    expect(r.res.structuredContent).toMatchObject({ status: "paid" });
    expect(r.text).toContain("Paid $12.98 to namecheap.com (R-0001, payout BATCH9)");
    expect(r.calls()).toBe(3);
    expect(r.sleeps).toHaveLength(2);
  });

  it("gives up after the wait and says to call again", async () => {
    const r = await run([paying], 5_000);
    expect(r.res.structuredContent).toMatchObject({ status: "paying" });
    expect(r.text).toContain("Call get_request_status again");
    expect(r.sleeps).toHaveLength(2);
    expect(r.calls()).toBe(3);
  });

  it("does not wait for other statuses, and keeps the last good status if a poll fails", async () => {
    const pending = { ...paying, status: "pending_human" };
    const p = await run([pending]);
    expect(p.sleeps).toHaveLength(0);
    expect(p.calls()).toBe(1);
    const f = await run([paying, new Error("network")]);
    expect(f.res.isError).toBeFalsy();
    expect(f.res.structuredContent).toMatchObject({ status: "paying" });
  });
});
