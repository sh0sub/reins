import { beforeEach, describe, expect, it } from "vitest";
import { listDecisions } from "@reins/db";
import { createTestContext } from "../src/testing.ts";
import { decideRequest, getLedgerRow, getRequestForAgent, submitPurchase } from "../src/service.ts";
import { FooledAuditor } from "../src/playground.ts";
import { buildAuditInput } from "../src/policy/audit.ts";
import { annualCents, applyRecurring, cadenceLine, evaluateRecurring } from "../src/policy/recurring.ts";
import { getReceipt } from "../src/receipts.ts";
import { seedAgent, setMode } from "./helpers.ts";

type Ctx = Awaited<ReturnType<typeof createTestContext>>;

const hosting = { monthly_limit: "300.00", auto_approve_limit: "30.00", per_purchase_cap: "100.00", allowed_merchants: ["vercel.com", "namecheap.com"], blocked_merchants: [], categories: ["infrastructure"], purpose: "Keep hosting running for the landing page" };
const vercelPro = { merchant: "vercel.com", amount: "20.00", items: "Vercel Pro, monthly", reason: "Hosting plan for the landing page", category: "infrastructure", recurring: "monthly" };
const FIRST = "New subscription: $20.00 monthly = $240.00 a year. A person approves the first charge.";

describe("subscription guard: annualized math", () => {
  it("monthly x12, yearly x1; caps are not involved", () => {
    expect(annualCents(2000, "monthly")).toBe(24000);
    expect(annualCents(12000, "yearly")).toBe(12000);
    expect(annualCents(999, "monthly")).toBe(11988);
    expect(cadenceLine(2000, "monthly")).toBe("$20.00 monthly · $240.00 a year");
    expect(cadenceLine(9900, "yearly")).toBe("$99.00 yearly · $99.00 a year");
  });

  it("first charge escalates; a known subscription does not; DENY is never softened", () => {
    const first = evaluateRecurring({ recurring: "monthly", amountCents: 2000, merchant: "vercel.com", approvedBefore: false });
    expect(first).toMatchObject({ escalate: true, reasonEn: FIRST, result: { rule: "recurring_first", ok: true, ask: true } });
    expect(evaluateRecurring({ recurring: "monthly", amountCents: 2000, merchant: "vercel.com", approvedBefore: true }).escalate).toBe(false);
    expect(applyRecurring("AUTO_APPROVE", true)).toBe("ASK_HUMAN");
    expect(applyRecurring("DENY", true)).toBe("DENY");
    expect(applyRecurring("AUTO_APPROVE", false)).toBe("AUTO_APPROVE");
  });
});

describe("subscription guard: policy flow", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    // several requests in a row per test: keep the velocity rule (3 per 10 min) out of the way
    ctx = await createTestContext({ config: { velocityMax: 20 } });
    await setMode(ctx, "vaulted");
  });

  it("first time asks a person even under the auto-approve limit, decided in code at the hard-rule stage", async () => {
    const { agent } = await seedAgent(ctx, hosting);
    const v = await submitPurchase(ctx, agent, vercelPro);
    expect(v).toMatchObject({ status: "pending_human", decision: "ASK_HUMAN", recurring: "monthly", annual_amount: "240.00" });
    expect(v.reason).toMatch(new RegExp(`^${FIRST.replace(/[.$]/g, "\\$&")}`));
    const ds = await listDecisions(ctx.db, v.request_id);
    const hard = ds.find((d) => d.stage === "hard_rules")!;
    expect(hard.decision).toBe("ASK_HUMAN");
    expect((hard.details as { results: Array<{ rule: string; ask?: boolean }> }).results.at(-1)).toMatchObject({ rule: "recurring_first", ask: true });
    // the auditor still ran (and was told it is recurring); its approve is overridden by code
    expect(ds.find((d) => d.stage === "llm")!.decision).toBe("AUTO_APPROVE");
    expect(ctx.paypal.calls).not.toContain("createOrder");
  });

  it("a fooled auditor cannot auto-approve a new subscription", async () => {
    ctx = await createTestContext({ auditor: new FooledAuditor() });
    await setMode(ctx, "vaulted");
    const { agent } = await seedAgent(ctx, hosting);
    expect((await submitPurchase(ctx, agent, vercelPro)).status).toBe("pending_human");
  });

  it("is still denied when another hard rule fails (cap, allow list)", async () => {
    const { agent } = await seedAgent(ctx, { ...hosting, per_purchase_cap: "15.00" });
    const capped = await submitPurchase(ctx, agent, vercelPro);
    expect(capped).toMatchObject({ status: "denied", decision: "DENY" });
    expect(capped.reason).toContain("per-purchase cap");
    const offList = await submitPurchase(ctx, agent, { ...vercelPro, merchant: "netlify.com", amount: "10.00" });
    expect(offList).toMatchObject({ status: "denied", decision: "DENY" });
  });

  it("after a person approved and it was paid, the next charge at that merchant + cadence follows the normal path", async () => {
    const { agent } = await seedAgent(ctx, hosting);
    const first = await submitPurchase(ctx, agent, { ...vercelPro, client_request_id: "sub-1" });
    expect((await decideRequest(ctx, first.request_id, "approve", "web")).status).toBe("paid");

    const second = await submitPurchase(ctx, agent, { ...vercelPro, client_request_id: "sub-2" });
    expect(second).toMatchObject({ status: "paid", decision: "AUTO_APPROVE", recurring: "monthly" });
    const hard = (await listDecisions(ctx.db, second.request_id)).find((d) => d.stage === "hard_rules")!;
    expect(hard.decision).toBe("PASS");

    // a price above the one a person approved is a new subscription again
    const pricier = await submitPurchase(ctx, agent, { ...vercelPro, amount: "25.00", client_request_id: "sub-2b" });
    expect(pricier.status).toBe("pending_human");
    expect(pricier.reason).toContain("New subscription: $25.00 monthly = $300.00 a year.");

    // a different cadence at the same merchant is a new subscription
    const yearly = await submitPurchase(ctx, agent, { ...vercelPro, amount: "25.00", items: "Vercel Pro, yearly", recurring: "yearly", client_request_id: "sub-3" });
    expect(yearly.status).toBe("pending_human");
    expect(yearly.reason).toContain("New subscription: $25.00 yearly = $25.00 a year.");

    // receipt carries the cadence line
    const receipt = await getReceipt(ctx, second.request_id);
    expect(receipt.recurring).toEqual({ cadence: "monthly", annual_amount: "240.00" });
  });

  it("an earlier subscription a person denied does not count", async () => {
    const { agent } = await seedAgent(ctx, hosting);
    const first = await submitPurchase(ctx, agent, { ...vercelPro, client_request_id: "a" });
    await decideRequest(ctx, first.request_id, "deny", "web");
    expect((await submitPurchase(ctx, agent, { ...vercelPro, client_request_id: "b" })).status).toBe("pending_human");
  });

  it("one-off purchases are unaffected", async () => {
    const { agent } = await seedAgent(ctx, hosting);
    const { recurring: _drop, ...oneOff } = vercelPro;
    const v = await submitPurchase(ctx, agent, oneOff);
    expect(v).toMatchObject({ status: "paid", decision: "AUTO_APPROVE", recurring: null, annual_amount: null });
    const ds = await listDecisions(ctx.db, v.request_id);
    expect(ds.map((d) => `${d.stage}:${d.decision}`)).toEqual(["hard_rules:PASS", "llm:AUTO_APPROVE"]);
    expect((ds[0]!.details as { results: Array<{ rule: string }> }).results.some((r) => r.rule === "recurring_first")).toBe(false);
  });

  it("rejects an unknown cadence; get_request_status and the ledger return the field", async () => {
    const { agent } = await seedAgent(ctx, hosting);
    await expect(submitPurchase(ctx, agent, { ...vercelPro, recurring: "weekly" })).rejects.toMatchObject({ status: 400, code: "invalid_input" });
    await expect(submitPurchase(ctx, agent, { ...vercelPro, recurring: 12 })).rejects.toMatchObject({ status: 400 });
    const v = await submitPurchase(ctx, agent, vercelPro);
    expect((await getRequestForAgent(ctx, agent, v.request_id)).recurring).toBe("monthly");
    expect(await getLedgerRow(ctx, v.request_id)).toMatchObject({ recurring: "monthly", annual_amount: "240.00" });
  });

  it("the same idempotency key with a different cadence is a conflict, not a retry", async () => {
    const { agent } = await seedAgent(ctx, hosting);
    await submitPurchase(ctx, agent, { ...vercelPro, client_request_id: "k" });
    await expect(submitPurchase(ctx, agent, { ...vercelPro, recurring: undefined, client_request_id: "k" })).rejects.toMatchObject({ status: 409 });
  });

  it("the auditor input says the request is recurring (one-off requests have no such field)", () => {
    const mandate = { purpose: "p", categories: [], allowedMerchants: [], blockedMerchants: [], monthlyLimitCents: 1000, autoApproveLimitCents: 100, perTxCapCents: null, currency: "USD" } as never;
    const base = { merchant: "vercel.com", amountCents: 2000, currency: "USD", items: "i", reason: "r", category: null };
    expect(buildAuditInput(mandate, { ...base, recurring: "monthly" }, [], 0).request.recurring).toBe("monthly");
    expect("recurring" in buildAuditInput(mandate, base, [], 0).request).toBe(false);
  });
});
