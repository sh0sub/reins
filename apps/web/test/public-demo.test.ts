/**
 * 2026-11-10 fixes on the web layer: C1 public-demo lock, M7 CSRF guard, M1 rate limits, #2 per-visitor playground
 * (the judge tour runs twice with the documented outcomes), H5 checkout routes, #4 landing redirect.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getPaymentByRequest, listAgents, updateWorkspace } from "@reins/db";
import { createTestContext } from "@reins/core/testing";
import { PLAYGROUND_AGENT, rotateAgentKey, playgroundConnect, authenticateAgent } from "@reins/core";
import { seedDemo } from "../../../scripts/seed.ts";
import { createRouter, type RouterOptions } from "../src/server/router.ts";
import { RateLimiter } from "../src/server/rateLimit.ts";
import { PRESETS } from "../src/app/try/presets.ts";

type Ctx = Awaited<ReturnType<typeof createTestContext>>;
const BASE = "https://reins.test";

async function demo(opts: RouterOptions = {}) {
  const ctx = await createTestContext();
  await seedDemo(ctx.db, { connectDemoMerchant: true, env: { PAYPAL_ENV: "fake" } });
  await updateWorkspace(ctx.db, { paymentMode: "supervised" });
  const handle = createRouter(async () => ctx, { publicDemo: true, ...opts });
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await handle(new Request(`${BASE}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) }));
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
  };
  return { ctx, handle, call };
}

const prev = { try: process.env.REINS_TRY, demo: process.env.REINS_PUBLIC_DEMO };
beforeEach(() => {
  process.env.REINS_PUBLIC_DEMO = "1"; // playgroundEnabled() reads it
  delete process.env.REINS_TRY;
});
afterEach(() => {
  if (prev.try === undefined) delete process.env.REINS_TRY;
  else process.env.REINS_TRY = prev.try;
  if (prev.demo === undefined) delete process.env.REINS_PUBLIC_DEMO;
  else process.env.REINS_PUBLIC_DEMO = prev.demo;
});

describe("C1 public demo refuses mutating admin routes", () => {
  it("403 with a clear message for agents, keys, pause, mandates, workspace, PayPal, vault and Telegram", async () => {
    const { ctx, call } = await demo();
    const scout = (await listAgents(ctx.db)).find((a) => a.name === "Research Scout")!;
    const refused: Array<[string, unknown]> = [
      ["/api/agents", { name: "Evil", mandate: {} }],
      [`/api/agents/${scout.id}/rotate-key`, {}],
      [`/api/agents/${scout.id}/pause`, {}],
      [`/api/agents/${scout.id}/resume`, {}],
      [`/api/agents/${scout.id}/mandates`, { monthly_limit: "99999.00" }],
      ["/api/workspace/mode", { mode: "treasury" }],
      ["/api/paypal/connect", { client_id: "x", client_secret: "y" }],
      ["/api/paypal/vault/start", {}],
      ["/api/paypal/vault/complete", { order_id: "O" }],
      ["/api/telegram/link", {}],
      ["/api/reconcile", {}],
    ];
    for (const [path, body] of refused) {
      const r = await call("POST", path, body);
      expect(r.status, path).toBe(403);
      expect(r.body.message, path).toContain("disabled on the public demo");
    }
    expect((await listAgents(ctx.db)).map((a) => a.name)).not.toContain("Evil");
  });

  it("GET reads, /api/try, /api/demo/request and decisions on seeded cards still work; allow-merchant is refused", async () => {
    const { call } = await demo();
    expect((await call("GET", "/api/agents")).status).toBe(200);
    expect((await call("GET", "/api/overview")).status).toBe(200);
    expect((await call("POST", "/api/try", PRESETS[0]!.purchase)).status).toBe(201);
    const raised = await call("POST", "/api/demo/request", {});
    expect(raised.status).toBe(201);
    const allow = await call("POST", `/api/requests/${raised.body.request_id}/decision`, { action: "approve", allow_merchant: true });
    expect(allow.status).toBe(403);
    expect(raised.body.status).toBe("pending_human");
    expect((await call("POST", `/api/requests/${raised.body.request_id}/decision`, { action: "deny" })).body.status).toBe("denied");
  });

  it("the owner's REINS_ADMIN_TOKEN still unlocks admin writes", async () => {
    const { call } = await demo({ adminToken: "owner-secret" });
    expect((await call("POST", "/api/agents", { name: "Mine" })).status).toBe(401);
    expect((await call("POST", "/api/agents", { name: "Mine" }, { "x-reins-admin": "owner-secret" })).status).toBe(201);
  });

  it("off the public demo nothing changes (local dev keeps every route)", async () => {
    const { call } = await demo({ publicDemo: false });
    expect((await call("POST", "/api/agents", { name: "Local" })).status).toBe(201);
  });
});

describe("M7 CSRF guard on admin writes", () => {
  it("POST needs application/json and a matching Origin when PUBLIC_BASE_URL is set", async () => {
    const { handle } = await demo({ publicDemo: false, publicBaseUrl: "https://reins.test" });
    const post = (headers: Record<string, string>) => handle(new Request(`${BASE}/api/agents`, { method: "POST", headers, body: JSON.stringify({ name: "X" }) }));
    expect((await post({ "content-type": "text/plain" })).status).toBe(415);
    expect((await post({ "content-type": "application/x-www-form-urlencoded" })).status).toBe(415);
    expect((await post({ "content-type": "application/json", origin: "https://evil.example" })).status).toBe(403);
    expect((await post({ "content-type": "application/json", origin: "https://reins.test" })).status).toBe(201);
    // local dev: the page's own host is fine even when PUBLIC_BASE_URL points at a tunnel
    expect((await post({ "content-type": "application/json", origin: "http://localhost:3000", host: "localhost:3000" })).status).toBe(201);
    expect((await post({ "content-type": "application/json; charset=utf-8" })).status).toBe(201);
  });

  it("the /try visitor cookie is HttpOnly, SameSite=Strict and Secure on https", async () => {
    const { call } = await demo();
    const r = await call("POST", "/api/try", PRESETS[0]!.purchase);
    const cookie = r.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^reins_try=[0-9a-f]{24}; /);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Secure");
  });
});

describe("#2 the inbox sample card waits for a person for every judge", () => {
  it("approving the seeded card and then four samples (one judge twice): each new sample is pending_human and approvable", async () => {
    const { ctx, call } = await demo();
    await updateWorkspace(ctx.db, { paymentMode: "vaulted", vaultId: "VAULT-FAKE" });
    const seeded = (await call("GET", "/api/inbox")).body.items.find((i: { agent_name: string }) => i.agent_name === "Research Scout");
    expect((await call("POST", `/api/requests/${seeded.request_id}/decision`, { action: "approve" })).body.status).toBe("paid");
    for (const judge of ["judge-aaaa-1", "judge-aaaa-1", "judge-bbbb-2", "judge-cccc-3"]) {
      const h = { cookie: `reins_try=${judge}` };
      const raised = await call("POST", "/api/demo/request", {}, h);
      expect(raised.body.status, judge).toBe("pending_human");
      expect((await call("POST", `/api/requests/${raised.body.request_id}/decision`, { action: "approve" }, h)).body.status, judge).toBe("paid");
    }
  });
});

describe("M1 per-IP token buckets", () => {
  it("/api/demo/request and /api/try answer 429 when one address floods them; another address is unaffected", async () => {
    const { call } = await demo({ rateLimiter: new RateLimiter({ demo: { capacity: 2, refillPerMinute: 1 }, try: { capacity: 3, refillPerMinute: 1 }, webhook: { capacity: 1, refillPerMinute: 1 } }) });
    const ip = { "x-forwarded-for": "203.0.113.9" };
    expect((await call("POST", "/api/demo/request", {}, ip)).status).toBe(201);
    expect((await call("POST", "/api/demo/request", {}, ip)).status).toBe(201);
    const limited = await call("POST", "/api/demo/request", {}, ip);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await call("POST", "/api/demo/request", {}, { "x-forwarded-for": "198.51.100.1" })).status).toBe(201);
    expect((await call("POST", "/api/webhooks/paypal", {}, ip)).status).not.toBe(429);
    expect((await call("POST", "/api/webhooks/paypal", {}, ip)).status).toBe(429);
  });
});

describe("#2 per-visitor playground: the judge tour gives the documented outcomes every time", () => {
  async function tour(call: Awaited<ReturnType<typeof demo>>["call"], cookie: string) {
    const h = { cookie: `reins_try=${cookie}` };
    const send = async (id: string) => (await call("POST", "/api/try", PRESETS.find((p) => p.id === id)!.purchase, h)).body;
    const domain = await send("domain");
    const report = await send("report");
    const injection = await send("injection");
    const split = PRESETS.find((p) => p.id === "split")!;
    const five = [];
    for (let i = 0; i < split.repeat!; i++) five.push((await call("POST", "/api/try", split.purchase, h)).body.row.status);
    return { domain: domain.row.status, report: report.row.status, reportId: report.row.request_id, injection: injection.row.status, five };
  }
  const approvedNoAsk = ["paid", "awaiting_buyer"]; // supervised checkout on the real sandbox stops at awaiting_buyer

  it("two judges in a row (supervised, like the live deploy): $12.98 approved, $59 waits, $450 denied, five $29 = 3 approved then denied", async () => {
    const { call } = await demo();
    for (const judge of ["judge-one-aaaa", "judge-two-bbbb"]) {
      const t = await tour(call, judge);
      expect(approvedNoAsk, judge).toContain(t.domain);
      expect(t.report, judge).toBe("pending_human");
      expect(t.injection, judge).toBe("denied");
      expect(t.five.slice(0, 3).every((s) => approvedNoAsk.includes(s)), judge).toBe(true);
      expect(t.five.slice(3), judge).toEqual(["denied", "denied"]);
      // the judge approves the $59 report from the /try card
      const approved = await call("POST", `/api/requests/${t.reportId}/decision`, { action: "approve" }, { cookie: `reins_try=${judge}` });
      expect(approvedNoAsk, judge).toContain(approved.body.status);
    }
  });

  it("the same tour on vaulted payments, run three times by fresh visitors, always pays $12.98 and three $29 orders", async () => {
    const { ctx, call } = await demo();
    await updateWorkspace(ctx.db, { paymentMode: "vaulted", vaultId: "VAULT-FAKE" });
    for (const judge of ["visitor-1111", "visitor-2222", "visitor-3333"]) {
      const t = await tour(call, judge);
      expect(t).toMatchObject({ domain: "paid", report: "pending_human", injection: "denied", five: ["paid", "paid", "paid", "denied", "denied"] });
    }
  });

  it("a visitor without a cookie gets one, and agents cannot claim the reserved try: prefix", async () => {
    const { ctx, call } = await demo();
    const first = await call("POST", "/api/try", PRESETS[0]!.purchase);
    expect(first.headers.get("set-cookie")).toContain("reins_try=");
    const { api_key } = await playgroundConnect(ctx);
    const r = await call("POST", "/api/requests", { ...PRESETS[0]!.purchase, client_request_id: "try:judge-one-aaaa:x" }, { authorization: `Bearer ${api_key}` });
    expect(r.status).toBe(400);
  });

  it("the cached demo key survives a key rotation (stale-key bug)", async () => {
    const { ctx, call } = await demo();
    expect((await call("POST", "/api/try", PRESETS[0]!.purchase)).status).toBe(201);
    const pg = (await listAgents(ctx.db)).find((a) => a.name === PLAYGROUND_AGENT)!;
    await rotateAgentKey(ctx, pg.id, "web");
    expect((await call("POST", "/api/try", { ...PRESETS[0]!.purchase, items: "second domain" })).status).toBe(201);
    const { api_key } = await playgroundConnect(ctx);
    await expect(authenticateAgent(ctx, `Bearer ${api_key}`)).resolves.toMatchObject({ id: pg.id });
  });
});

describe("H5 /api/pay/return and /api/pay/cancel", () => {
  let d: Awaited<ReturnType<typeof demo>>;
  let ctx: Ctx;
  beforeEach(async () => {
    d = await demo();
    ctx = d.ctx;
  });

  it("return captures once and reports paid; cancel with the token frees the budget", async () => {
    const a = (await d.call("POST", "/api/try", PRESETS[0]!.purchase)).body.row;
    expect(a.status).toBe("awaiting_buyer");
    const pay = (await getPaymentByRequest(ctx.db, a.request_id))!;
    ctx.paypal.approveOrder(pay.paypalOrderId!);
    const ret = await d.call("POST", "/api/pay/return", { request: a.request_id, token: pay.paypalOrderId });
    expect(ret).toMatchObject({ status: 200, body: { outcome: "paid", request: { status: "paid" } } });
    expect((await d.call("POST", "/api/pay/return", { request: a.request_id, token: pay.paypalOrderId })).body.outcome).toBe("unchanged");

    const b = (await d.call("POST", "/api/try", { ...PRESETS[0]!.purchase, items: "another domain" })).body.row;
    const payB = (await getPaymentByRequest(ctx.db, b.request_id))!;
    const cancel = await d.call("POST", "/api/pay/cancel", { request: b.request_id, token: payB.paypalOrderId });
    expect(cancel.body).toMatchObject({ outcome: "canceled", request: { status: "failed" } });
    expect((await d.call("POST", "/api/pay/return", {})).status).toBe(400);
  });
});

describe("#4 landing and pages", () => {
  const read = (p: string) => readFileSync(resolve(__dirname, "../src/app", p), "utf8");
  it("/ sends the public demo to /try, and /pay/return + /pay/cancel exist", () => {
    expect(read("page.tsx")).toContain('if (process.env.REINS_PUBLIC_DEMO === "1") redirect("/try")');
    expect(read("pay/return/page.tsx")).toContain('kind="return"');
    expect(read("pay/cancel/page.tsx")).toContain('kind="cancel"');
    expect(read("pay/CheckoutResult.tsx")).toContain("/api/pay/${kind}");
  });
});
