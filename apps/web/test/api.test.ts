import { beforeEach, describe, expect, it } from "vitest";
import { updateWorkspace } from "@reins/db";
import { createTestContext, FakePayPalClient } from "@reins/core/testing";
import { createRouter } from "../src/server/router.ts";

type Ctx = Awaited<ReturnType<typeof createTestContext>>;
const BASE = "http://localhost:3000";

function client(handle: (r: Request) => Promise<Response>) {
  return async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await handle(new Request(`${BASE}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }));
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
}
const mandate = { monthly_limit: "60.00", auto_approve_limit: "25.00", per_purchase_cap: "100.00", blocked_merchants: ["fiverr.com"], categories: ["research"], purpose: "Buy market research reports" };

describe("D4 REST API", () => {
  let ctx: Ctx;
  let call: ReturnType<typeof client>;
  beforeEach(async () => {
    ctx = await createTestContext();
    call = client(createRouter(async () => ctx));
  });

  it("health, 404 and 405", async () => {
    expect((await call("GET", "/api/health")).status).toBe(200);
    expect((await call("GET", "/api/nope")).status).toBe(404);
    expect((await call("POST", "/api/health")).status).toBe(405);
  });

  it("agent CRUD + key issued once + mandate versions", async () => {
    const created = await call("POST", "/api/agents", { name: "Research Scout", mandate });
    expect(created.status).toBe(201);
    expect(created.body.api_key).toMatch(/^rk_live_/);
    expect(created.body.mandate.version).toBe(1);
    const list = await call("GET", "/api/agents");
    expect(list.body.agents[0]).toMatchObject({ name: "Research Scout", mandate_version: 1 });
    expect(JSON.stringify(list.body)).not.toContain(created.body.api_key);
    const v2 = await call("POST", `/api/agents/${created.body.agent.id}/mandates`, { ...mandate, per_purchase_cap: "60.00" });
    expect(v2.body.mandate.version).toBe(2);
    expect((await call("GET", `/api/agents/${created.body.agent.id}/mandates`)).body.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    expect((await call("POST", `/api/agents/${created.body.agent.id}/mandates`, { purpose: "" })).status).toBe(400);
  });

  it("agent routes require a valid Bearer key and only see their own requests", async () => {
    const a = (await call("POST", "/api/agents", { name: "A", mandate })).body;
    const b = (await call("POST", "/api/agents", { name: "B", mandate })).body;
    expect((await call("GET", "/api/mandate")).status).toBe(401);
    expect((await call("GET", "/api/mandate", undefined, { authorization: "Bearer rk_live_nope" })).status).toBe(401);
    const m = await call("GET", "/api/mandate", undefined, { authorization: `Bearer ${a.api_key}` });
    expect(m.body.mandate.auto_approve_limit).toBe("25.00");
    const r = await call("POST", "/api/requests", { merchant: "statista.com", amount: "12.00", items: "dataset", reason: "market research", category: "research" }, { authorization: `Bearer ${a.api_key}` });
    expect(r.status).toBe(201);
    expect((await call("GET", `/api/requests/${r.body.request_id}`, undefined, { authorization: `Bearer ${b.api_key}` })).status).toBe(404);
    expect((await call("GET", `/api/requests/${r.body.request_id}`, undefined, { authorization: `Bearer ${a.api_key}` })).body.request_id).toBe(r.body.request_id);
    expect((await call("GET", "/api/transactions", undefined, { authorization: `Bearer ${b.api_key}` })).body.transactions).toEqual([]);
  });

  it("Idempotency-Key header maps to client_request_id", async () => {
    const a = (await call("POST", "/api/agents", { name: "A", mandate })).body;
    const h = { authorization: `Bearer ${a.api_key}`, "idempotency-key": "k-1" };
    const body = { merchant: "statista.com", amount: "12.00", items: "dataset", reason: "market research", category: "research" };
    const r1 = await call("POST", "/api/requests", body, h);
    const r2 = await call("POST", "/api/requests", body, h);
    expect(r2.body.request_id).toBe(r1.body.request_id);
  });

  it("validates purchase input", async () => {
    const a = (await call("POST", "/api/agents", { name: "A", mandate })).body;
    const r = await call("POST", "/api/requests", { merchant: "x.com", amount: "-5", items: "i", reason: "r" }, { authorization: `Bearer ${a.api_key}` });
    expect(r).toMatchObject({ status: 400, body: { error: "invalid_input" } });
  });

  it("inbox -> decision (web) and 409 on a second decision", async () => {
    await updateWorkspace(ctx.db, { paymentMode: "vaulted", vaultId: "V" });
    const a = (await call("POST", "/api/agents", { name: "A", mandate })).body;
    const r = await call("POST", "/api/requests", { merchant: "statista.com", amount: "59.00", items: "Market report", reason: "market research report", category: "research" }, { authorization: `Bearer ${a.api_key}` });
    expect(r.body.status).toBe("pending_human");
    const inbox = await call("GET", "/api/inbox");
    expect(inbox.body.items.map((i: { request_id: string }) => i.request_id)).toEqual([r.body.request_id]);
    const d = await call("POST", `/api/requests/${r.body.request_id}/decision`, { action: "approve" });
    expect(d.body).toMatchObject({ status: "paid", decisions: expect.any(Array) });
    expect((await call("GET", "/api/inbox")).body.items).toEqual([]);
    expect((await call("POST", `/api/requests/${r.body.request_id}/decision`, { action: "deny" })).status).toBe(409);
    expect((await call("POST", `/api/requests/${r.body.request_id}/decision`, { action: "maybe" })).status).toBe(400);
  });

  it("workspace view never exposes the vault id; mode switch validates", async () => {
    await updateWorkspace(ctx.db, { vaultId: "VAULT-SECRET" });
    const ws = await call("GET", "/api/workspace");
    expect(ws.body.has_vault).toBe(true);
    expect(JSON.stringify(ws.body)).not.toContain("VAULT-SECRET");
    expect((await call("POST", "/api/workspace/mode", { mode: "treasury" })).body.payment_mode).toBe("treasury");
    expect((await call("POST", "/api/workspace/mode", { mode: "card" })).status).toBe(400);
  });

  it("demo connect + vault setup + telegram link", async () => {
    expect((await call("POST", "/api/paypal/connect", { demo: true, merchant_email: "sb-merchant@business.example.com" })).body).toMatchObject({ connected: true, paypal_env: "fake" });
    const start = await call("POST", "/api/paypal/vault/start");
    ctx.paypal.approveOrder(start.body.orderId);
    expect((await call("POST", "/api/paypal/vault/complete", { order_id: start.body.orderId })).body).toEqual({ payment_mode: "vaulted", has_vault: true });
    expect((await call("POST", "/api/telegram/link")).body.url).toMatch(/^https:\/\/t\.me\/\w+\?start=lk_/);
  });

  it("webhook endpoint verifies and dedupes", async () => {
    const event = { id: "WH-77", event_type: "BILLING.PLAN.CREATED", resource: {} };
    const headers = FakePayPalClient.headers() as unknown as Record<string, string>;
    expect((await call("POST", "/api/webhooks/paypal", event, headers)).body).toMatchObject({ ok: true, outcome: "ignored" });
    expect((await call("POST", "/api/webhooks/paypal", event, headers)).body).toMatchObject({ ok: true, duplicate: true });
    expect((await call("POST", "/api/webhooks/paypal", event)).status).toBe(400);
  });

  it("admin token guards dashboard routes but not agent/webhook routes", async () => {
    const guarded = client(createRouter(async () => ctx, { adminToken: "s3cret-admin" }));
    expect((await guarded("GET", "/api/agents")).status).toBe(401);
    expect((await guarded("GET", "/api/agents", undefined, { "x-reins-admin": "s3cret-admin" })).status).toBe(200);
    expect((await guarded("GET", "/api/agents", undefined, { cookie: "reins_admin=s3cret-admin" })).status).toBe(200);
    expect((await guarded("GET", "/api/health")).status).toBe(200);
  });

  it("SSE stream pushes request updates", async () => {
    const handle = createRouter(async () => ctx);
    const ac = new AbortController();
    const res = await handle(new Request(`${BASE}/api/events`, { signal: ac.signal }));
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    expect(dec.decode((await reader.read()).value)).toContain("event: ready");
    const a = (await call("POST", "/api/agents", { name: "A", mandate })).body;
    await call("POST", "/api/requests", { merchant: "statista.com", amount: "59.00", items: "report", reason: "market research report", category: "research" }, { authorization: `Bearer ${a.api_key}` });
    const chunk = dec.decode((await reader.read()).value);
    expect(chunk).toContain("event: request.created");
    ac.abort();
    await reader.cancel();
    expect(ctx.events.size).toBe(0);
  });
});
