/**
 * 2026-11-10 security / money-correctness fixes (docs/spec-matrix.md rows FX-*): merchant hostnames (H1-H3), pay-time
 * re-check and reserved spend (C2), advisory-audit skip and the daily Claude cap (M1), PayPal unknown outcomes (H4),
 * checkout return/cancel/timeout (H5) and authoritative webhooks (M2/M3).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { getPaymentByRequest, getRequest, listDecisions, setAgentPaused } from "@reins/db";
import { createTestContext, FakePayPalClient } from "../src/testing.ts";
import { InvalidMerchantError, isPublicSuffix, parseMerchant, registrableDomain } from "../src/merchant.ts";
import { LIMITS_CHANGED, decideRequest, saveMandate, submitPurchase } from "../src/service.ts";
import { cancelCheckout, resolvePendingPayments, returnFromCheckout } from "../src/checkout.ts";
import { handlePayPalWebhook } from "../src/webhooks.ts";
import { BudgetedAuditor, DailyCallBudget, budgeted, ClaudeBudgetExceeded } from "../src/claudeBudget.ts";
import { MockAuditor } from "../src/policy/mockAuditor.ts";
import { HttpPayPalClient } from "../src/paypal/http.ts";
import { PayPalApiError, PayPalUnknownError } from "../src/paypal/types.ts";
import type { AuditProvider } from "../src/policy/audit.ts";
import { dataset, report, seedAgent, setMode } from "./helpers.ts";

type Ctx = Awaited<ReturnType<typeof createTestContext>>;
const base = { monthly_limit: "100.00", auto_approve_limit: "50.00", per_purchase_cap: "100.00", blocked_merchants: [], categories: ["research"], purpose: "Buy market research reports" };

describe("H1 strict merchant hostnames", () => {
  it("normalizes the variants that used to slip past a block list", () => {
    expect(parseMerchant("fiverr.com.")).toBe("fiverr.com");
    expect(parseMerchant("//fiverr.com/gig")).toBe("fiverr.com");
    expect(parseMerchant("FIVERR.COM:443")).toBe("fiverr.com");
    expect(parseMerchant("https://www.Fiverr.com/x?y=1")).toBe("fiverr.com");
    expect(parseMerchant("bücher.de")).toBe("xn--bcher-kva.de");
  });
  it("rejects what is not a hostname", () => {
    for (const bad of ["", "   ", "com", "fiverr..com", "-x.com", "a_b.com", "user@fiverr.com", "1.2.3.4", "fiverr com", ".com"]) {
      expect(() => parseMerchant(bad), bad).toThrow(InvalidMerchantError);
    }
  });
  it("REST/MCP input: an invalid merchant is a 400, a disguised blocked one is still blocked", async () => {
    const ctx = await createTestContext();
    const { agent } = await seedAgent(ctx);
    await expect(submitPurchase(ctx, agent, { ...dataset, merchant: "com" })).rejects.toMatchObject({ status: 400, code: "invalid_input" });
    await expect(submitPurchase(ctx, agent, { ...dataset, merchant: "" })).rejects.toMatchObject({ status: 400 });
    const v = await submitPurchase(ctx, agent, { ...dataset, merchant: "FIVERR.COM.:443" });
    expect(v).toMatchObject({ merchant: "fiverr.com", status: "denied" });
  });
});

describe("H2 no rules on public suffixes", () => {
  it("knows bare TLDs, two-level country suffixes and hosting platforms", () => {
    for (const s of ["com", "io", "co.uk", "github.io", "vercel.app"]) expect(isPublicSuffix(s), s).toBe(true);
    for (const s of ["vercel.com", "alice.github.io", "bbc.co.uk"]) expect(isPublicSuffix(s), s).toBe(false);
  });
  it("refuses allow-list entries and merchant rules on a public suffix, keeps registrable ones", async () => {
    const ctx = await createTestContext();
    const { agent } = await seedAgent(ctx);
    await expect(saveMandate(ctx, agent.id, { ...base, allowed_merchants: ["github.io"] })).rejects.toMatchObject({ status: 400 });
    await expect(saveMandate(ctx, agent.id, { ...base, allowed_merchants: ["co.uk"] })).rejects.toMatchObject({ status: 400 });
    await expect(saveMandate(ctx, agent.id, { ...base, merchant_auto_limits: { "vercel.app": "40.00" } })).rejects.toMatchObject({ status: 400 });
    const m = await saveMandate(ctx, agent.id, { ...base, allowed_merchants: ["Alice.GitHub.io", "statista.com."], merchant_auto_limits: { "STATISTA.COM": "59.00" } });
    expect(m.allowedMerchants).toEqual(["alice.github.io", "statista.com"]);
    expect(m.merchantAutoLimits).toEqual({ "statista.com": 5900 });
  });
});

describe("H3 split guard and patterns group by registrable domain", () => {
  it("registrableDomain", () => {
    expect(registrableDomain("api.vercel.com")).toBe("vercel.com");
    expect(registrableDomain("a.b.bbc.co.uk")).toBe("bbc.co.uk");
    expect(registrableDomain("x.alice.github.io")).toBe("alice.github.io");
  });
  it("$29 orders spread over subdomains still add up against the $100 cap", async () => {
    const ctx = await createTestContext({ config: { velocityMax: 100 } });
    const { agent } = await seedAgent(ctx, { ...base, monthly_limit: "500.00", categories: ["infrastructure"], purpose: "Pay hosting credit for the project" });
    await setMode(ctx, "vaulted");
    const order = { amount: "29.00", items: "Hosting credit", reason: "Hosting credit for the project", category: "infrastructure" };
    const out = [];
    for (const m of ["vercel.com", "api.vercel.com", "eu.vercel.com", "billing.vercel.com"]) out.push((await submitPurchase(ctx, agent, { ...order, merchant: m })).status);
    expect(out.slice(0, 3)).toEqual(["paid", "paid", "paid"]);
    expect(out[3]).toBe("denied");
  });
});

describe("C2 pay-time re-check and reserved spend", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await createTestContext();
    await setMode(ctx, "vaulted");
  });

  it("3 x $90 pending, cap lowered to $100, approve all: only one pays, the rest are denied with 'limits changed'", async () => {
    const { agent } = await seedAgent(ctx, { ...base, monthly_limit: "300.00", auto_approve_limit: "25.00" });
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await submitPurchase(ctx, agent, { ...report, amount: "90.00", items: `Report ${i}` })).request_id);
    for (const id of ids) expect((await getRequest(ctx.db, id))!.status).toBe("pending_human");
    await saveMandate(ctx, agent.id, { ...base, monthly_limit: "100.00", auto_approve_limit: "25.00" });
    const views = [];
    for (const id of ids) views.push(await decideRequest(ctx, id, "approve", "web"));
    expect(views.map((v) => v.status)).toEqual(["paid", "denied", "denied"]);
    expect(views[1]!.reason).toContain(LIMITS_CHANGED);
    expect(ctx.paypal.calls.filter((c) => c === "createOrder")).toHaveLength(1);
    const trail = await listDecisions(ctx.db, ids[1]!);
    expect(trail.at(-1)).toMatchObject({ stage: "system", decision: "DENY", actor: "policy" });
  });

  it("pausing, blocking or revoking after the request: the approval no longer pays", async () => {
    const { agent } = await seedAgent(ctx, { ...base, auto_approve_limit: "25.00" });
    const a = await submitPurchase(ctx, agent, { ...report, amount: "40.00" });
    const b = await submitPurchase(ctx, agent, { ...report, amount: "41.00", items: "Report 2" });
    await setAgentPaused(ctx.db, agent.id, Date.now());
    expect((await decideRequest(ctx, a.request_id, "approve", "web")).status).toBe("denied");
    await setAgentPaused(ctx.db, agent.id, null);
    await saveMandate(ctx, agent.id, { ...base, auto_approve_limit: "25.00", blocked_merchants: ["statista.com"] });
    const vb = await decideRequest(ctx, b.request_id, "approve", "web");
    expect(vb.status).toBe("denied");
    expect(vb.reason).toMatch(/Limits changed since the request: .*blocked/);
    expect(ctx.paypal.calls).not.toContain("createOrder");
  });

  it("a pending request reserves its amount at submit time", async () => {
    const { agent } = await seedAgent(ctx, { ...base, auto_approve_limit: "25.00" });
    expect((await submitPurchase(ctx, agent, { ...report, amount: "80.00" })).status).toBe("pending_human");
    const next = await submitPurchase(ctx, agent, { ...dataset, amount: "21.00", category: "research" });
    expect(next.status).toBe("denied");
    expect(next.reason).toContain("monthly cap");
  });

  it("concurrent submits under a cap never go over it", async () => {
    const c = await createTestContext({ config: { velocityMax: 100 } });
    await setMode(c, "vaulted");
    const { agent } = await seedAgent(c, { ...base, monthly_limit: "100.00", auto_approve_limit: "30.00" });
    const views = await Promise.all(
      Array.from({ length: 12 }, (_, i) => submitPurchase(c, agent, { merchant: `vendor${i}.com`, amount: "30.00", items: `Dataset ${i}`, reason: "Research data", category: "research" })),
    );
    const paid = views.filter((v) => v.status === "paid");
    // in-flight requests reserve their amount, so a burst errs on the side of denying; it never overspends
    expect(paid.length * 30).toBeLessThanOrEqual(100);
    expect(views.every((v) => v.status === "paid" || v.status === "denied")).toBe(true);
    expect(c.paypal.calls.filter((x) => x === "createOrder").length).toBe(paid.length);
  });

  it("concurrent approvals of pending requests never go over the cap", async () => {
    const { agent } = await seedAgent(ctx, { ...base, monthly_limit: "500.00", auto_approve_limit: "25.00" });
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await submitPurchase(ctx, agent, { ...report, amount: "60.00", items: `R${i}` })).request_id);
    await saveMandate(ctx, agent.id, { ...base, monthly_limit: "100.00", auto_approve_limit: "25.00" });
    const views = await Promise.all(ids.map((id) => decideRequest(ctx, id, "approve", "web")));
    expect(views.filter((v) => v.status === "paid").length).toBeLessThanOrEqual(1);
  });
});

describe("M1 advisory audit and the daily Claude cap", () => {
  it("no advisory auditor call for a velocity or amount failure", async () => {
    let calls = 0;
    const counting: AuditProvider = { name: "count", audit: async (i) => (calls++, new MockAuditor().audit(i)) };
    const ctx = await createTestContext({ auditor: counting });
    const { agent } = await seedAgent(ctx);
    for (let i = 0; i < 3; i++) await submitPurchase(ctx, agent, { ...dataset, items: `D${i}` });
    const before = calls;
    const burst = await submitPurchase(ctx, agent, { ...dataset, items: "D4" });
    expect(burst.status).toBe("denied");
    expect(calls).toBe(before);
  });

  it("over the cap the template auditor decides and is named in the trail", async () => {
    let claude = 0;
    const primary: AuditProvider = { name: "claude:test", audit: async (i) => (claude++, new MockAuditor().audit(i)) };
    const budget = new DailyCallBudget(1);
    const ctx = await createTestContext({ auditor: new BudgetedAuditor(primary, new MockAuditor(), budget) });
    const { agent } = await seedAgent(ctx);
    await submitPurchase(ctx, agent, dataset);
    const second = await submitPurchase(ctx, agent, { ...dataset, items: "Other dataset" });
    expect(claude).toBe(1);
    const llm = (await listDecisions(ctx.db, second.request_id)).find((d) => d.stage === "llm");
    expect(llm?.actor).toBe("mock");
  });

  it("budgeted writers throw once the budget is gone (callers fall back to templates) and reset the next UTC day", async () => {
    let now = Date.UTC(2026, 10, 10, 23, 0);
    const budget = new DailyCallBudget(1, () => now);
    const w = budgeted({ write: async () => "claude sentence" }, "write", budget);
    expect(await w.write()).toBe("claude sentence");
    await expect(w.write()).rejects.toBeInstanceOf(ClaudeBudgetExceeded);
    now += 2 * 3_600_000;
    expect(await w.write()).toBe("claude sentence");
  });
});

describe("H4 PayPal timeouts, retries and unknown outcomes", () => {
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

  it("retries a 5xx once with the same PayPal-Request-Id and every attempt carries a timeout signal", async () => {
    const seen: RequestInit[] = [];
    let n = 0;
    const c = new HttpPayPalClient({
      clientId: "i",
      clientSecret: "s",
      fetch: async (url, init = {}) => {
        if (url.endsWith("/v1/oauth2/token")) return json({ access_token: "t", expires_in: 3600 });
        seen.push(init);
        return ++n === 1 ? json({ name: "INTERNAL_SERVER_ERROR" }, 503) : json({ id: "O1", status: "CREATED" });
      },
    });
    expect((await c.createOrder({ intent: "CAPTURE", purchase_units: [] }, "reins-create-r1")).id).toBe("O1");
    expect(seen).toHaveLength(2);
    expect(seen.map((i) => (i.headers as Record<string, string>)["PayPal-Request-Id"])).toEqual(["reins-create-r1", "reins-create-r1"]);
    expect(seen.every((i) => i.signal instanceof AbortSignal)).toBe(true);
  });

  it("a 4xx on the retry after an unanswered first attempt is unknown, not a failure (duplicate in flight)", async () => {
    let n = 0;
    const c = new HttpPayPalClient({ clientId: "i", clientSecret: "s", fetch: async (url) => (url.endsWith("/token") ? json({ access_token: "t", expires_in: 3600 }) : ++n === 1 ? Promise.reject(new TypeError("socket hang up")) : json({ name: "UNPROCESSABLE_ENTITY", details: [{ issue: "DUPLICATE_REQUEST_ID" }] }, 422)) });
    await expect(c.captureOrder("O1", "reins-capture-r1")).rejects.toBeInstanceOf(PayPalUnknownError);
  });

  it("two network failures -> PayPalUnknownError; a 4xx is definite and not retried", async () => {
    let calls = 0;
    const flaky = new HttpPayPalClient({ clientId: "i", clientSecret: "s", fetch: async (url) => (url.endsWith("/token") ? json({ access_token: "t", expires_in: 3600 }) : (calls++, Promise.reject(new TypeError("fetch failed")))) });
    await expect(flaky.getOrder("O1")).rejects.toBeInstanceOf(PayPalUnknownError);
    expect(calls).toBe(2);
    let c4 = 0;
    const bad = new HttpPayPalClient({ clientId: "i", clientSecret: "s", fetch: async (url) => (url.endsWith("/token") ? json({ access_token: "t", expires_in: 3600 }) : (c4++, json({ name: "UNPROCESSABLE_ENTITY" }, 422))) });
    await expect(bad.getOrder("O1")).rejects.toBeInstanceOf(PayPalApiError);
    expect(c4).toBe(1);
  });

  it("an unknown create keeps the request paying (still committed); the sweeper resolves it idempotently", async () => {
    const ctx = await createTestContext();
    await setMode(ctx, "vaulted");
    const { agent } = await seedAgent(ctx);
    ctx.paypal.failNextCreate = new PayPalUnknownError("PayPal timeout (after one retry)");
    const v = await submitPurchase(ctx, agent, dataset);
    expect(v.status).toBe("paying");
    expect((await getPaymentByRequest(ctx.db, v.request_id))!.status).toBe("pending");
    // still counts against the $60 cap: $12 + $49 would be over
    expect((await submitPurchase(ctx, agent, { ...dataset, amount: "49.00", items: "Big dataset" })).status).toBe("denied");
    expect(await resolvePendingPayments(ctx, 0)).toBe(1);
    expect((await getRequest(ctx.db, v.request_id))!.status).toBe("paid");
    expect((await getPaymentByRequest(ctx.db, v.request_id))!.status).toBe("completed");
  });

  it("M3: a PENDING vault capture stays committed instead of failing", async () => {
    const ctx = await createTestContext();
    await setMode(ctx, "vaulted");
    const { agent } = await seedAgent(ctx);
    const real = ctx.paypal.createOrder.bind(ctx.paypal);
    ctx.paypal.createOrder = async (b, id) => {
      const o = await real(b, id);
      o.purchase_units![0]!.payments!.captures![0]!.status = "PENDING";
      return o;
    };
    expect((await submitPurchase(ctx, agent, dataset)).status).toBe("paying");
  });
});

describe("H5 checkout return, cancel and abandoned checkouts; M2 authoritative webhooks", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await createTestContext();
    await setMode(ctx, "supervised");
  });
  const deliver = (event: unknown) => handlePayPalWebhook(ctx, FakePayPalClient.headers() as never, JSON.stringify(event));

  it("return captures once with reins-capture-<id>; the webhook arriving after is a no-op", async () => {
    const { agent } = await seedAgent(ctx);
    const v = await submitPurchase(ctx, agent, dataset);
    expect(v.status).toBe("awaiting_buyer");
    const pay = (await getPaymentByRequest(ctx.db, v.request_id))!;
    ctx.paypal.approveOrder(pay.paypalOrderId!);
    const r = await returnFromCheckout(ctx, v.request_id, pay.paypalOrderId);
    expect(r).toMatchObject({ outcome: "paid", view: { status: "paid" } });
    const again = await returnFromCheckout(ctx, v.request_id, pay.paypalOrderId);
    expect(again.outcome).toBe("unchanged");
    expect((await deliver(ctx.paypal.orderApprovedEvent(pay.paypalOrderId!))).body.outcome).toBe("already_handled");
    expect(ctx.paypal.calls.filter((c) => c === "captureOrder")).toHaveLength(1);
    await expect(returnFromCheckout(ctx, v.request_id, "SOMEONE-ELSES-ORDER")).rejects.toMatchObject({ status: 409 });
  });

  it("return while the webhook is mid-capture (request already paying) never captures a second time", async () => {
    const { agent } = await seedAgent(ctx);
    const v = await submitPurchase(ctx, agent, dataset);
    const pay = (await getPaymentByRequest(ctx.db, v.request_id))!;
    ctx.paypal.approveOrder(pay.paypalOrderId!);
    const { transitionRequest } = await import("@reins/db");
    await transitionRequest(ctx.db, v.request_id, ["awaiting_buyer"], { status: "paying" }); // the webhook claimed it
    expect((await returnFromCheckout(ctx, v.request_id, pay.paypalOrderId)).outcome).toBe("pending");
    expect(ctx.paypal.calls).not.toContain("captureOrder");
  });

  it("return before approval leaves the order waiting", async () => {
    const { agent } = await seedAgent(ctx);
    const v = await submitPurchase(ctx, agent, dataset);
    expect((await returnFromCheckout(ctx, v.request_id)).outcome).toBe("not_approved");
    expect((await getRequest(ctx.db, v.request_id))!.status).toBe("awaiting_buyer");
  });

  it("cancel needs the order token, moves the request to failed and frees the budget", async () => {
    const { agent } = await seedAgent(ctx);
    const v = await submitPurchase(ctx, agent, { ...dataset, amount: "25.00" });
    const pay = (await getPaymentByRequest(ctx.db, v.request_id))!;
    expect((await cancelCheckout(ctx, v.request_id)).outcome).toBe("unchanged");
    expect((await cancelCheckout(ctx, v.request_id, pay.paypalOrderId)).outcome).toBe("canceled");
    expect((await getRequest(ctx.db, v.request_id))!.status).toBe("failed");
    expect((await getPaymentByRequest(ctx.db, v.request_id))!.status).toBe("failed");
    // $60 cap: with the canceled $25 released, $25 + $25 fit again
    expect((await submitPurchase(ctx, agent, { ...dataset, amount: "25.00", items: "A" })).status).toBe("awaiting_buyer");
    expect((await submitPurchase(ctx, agent, { ...dataset, amount: "25.00", items: "B" })).status).toBe("awaiting_buyer");
  });

  it("an awaiting_buyer order older than 3 hours stops counting at the next submit", async () => {
    let now = Date.now();
    const c = await createTestContext({ now: () => now });
    await setMode(c, "supervised");
    const { agent } = await seedAgent(c);
    const old = await submitPurchase(c, agent, { ...dataset, amount: "25.00" });
    expect(old.status).toBe("awaiting_buyer");
    expect((await submitPurchase(c, agent, { ...dataset, merchant: "data.world", amount: "25.00", items: "B" })).status).toBe("awaiting_buyer");
    expect((await submitPurchase(c, agent, { ...dataset, merchant: "zenodo.org", amount: "25.00", items: "C" })).status).toBe("denied");
    now = Date.now() + 3 * 3_600_000 + 60_000; // rows stamp updatedAt with the wall clock
    const fresh = await submitPurchase(c, agent, { ...dataset, merchant: "figshare.com", amount: "25.00", items: "D" });
    expect((await getRequest(c.db, old.request_id))!.status).toBe("expired");
    expect(fresh.status).toBe("awaiting_buyer");
  });

  it("M2: PAYMENT.CAPTURE.COMPLETED is authoritative (failed -> paid); a late DENIED never marks a paid payment failed", async () => {
    const { agent } = await seedAgent(ctx);
    const v = await submitPurchase(ctx, agent, dataset);
    const pay = (await getPaymentByRequest(ctx.db, v.request_id))!;
    await cancelCheckout(ctx, v.request_id, pay.paypalOrderId);
    ctx.paypal.approveOrder(pay.paypalOrderId!);
    await ctx.paypal.captureOrder(pay.paypalOrderId!, `reins-capture-${v.request_id}`);
    expect((await deliver(ctx.paypal.captureCompletedEvent(pay.paypalOrderId!))).body.outcome).toBe("paid");
    expect((await getRequest(ctx.db, v.request_id))!.status).toBe("paid");
    const denied = { ...ctx.paypal.captureCompletedEvent(pay.paypalOrderId!), id: "WH-DENIED-1", event_type: "PAYMENT.CAPTURE.DENIED" };
    expect((await deliver(denied)).body.outcome).toBe("no_transition");
    expect((await getPaymentByRequest(ctx.db, v.request_id))!.status).toBe("completed");
  });
});
