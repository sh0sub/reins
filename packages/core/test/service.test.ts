import { beforeEach, describe, expect, it } from "vitest";
import { listDecisions, getPaymentByRequest } from "@reins/db";
import { createTestContext } from "../src/testing.ts";
import {
  authenticateAgent,
  createAgent,
  decideRequest,
  expireStale,
  getLedger,
  ReinsError,
  saveMandate,
  submitPurchase,
} from "../src/service.ts";
import { dataset, injected, report, seedAgent, setMode } from "./helpers.ts";

type Ctx = Awaited<ReturnType<typeof createTestContext>>;

describe("M2 agent registration", () => {
  it("returns the key once with an MCP snippet and authenticates by hash", async () => {
    const ctx = await createTestContext();
    const out = await createAgent(ctx, "Claude Code - DevOps");
    expect(out.api_key).toMatch(/^rk_live_/);
    expect(JSON.stringify(out.mcp_snippet)).toContain(out.api_key);
    expect((await authenticateAgent(ctx, `Bearer ${out.api_key}`)).id).toBe(out.agent.id);
    await expect(authenticateAgent(ctx, "Bearer rk_live_wrong")).rejects.toMatchObject({ status: 401 });
    await expect(authenticateAgent(ctx, undefined)).rejects.toBeInstanceOf(ReinsError);
  });
  it("validates mandates and versions them", async () => {
    const ctx = await createTestContext();
    const { agent } = await seedAgent(ctx);
    await expect(saveMandate(ctx, agent.id, { monthly_limit: "10", auto_approve_limit: "20", purpose: "x" })).rejects.toMatchObject({ status: 400 });
    const v2 = await saveMandate(ctx, agent.id, { monthly_limit: "60", auto_approve_limit: "25", per_purchase_cap: "60", blocked_merchants: ["https://www.Fiverr.com"], purpose: "Research" });
    expect(v2.version).toBe(2);
    expect(v2.blockedMerchants).toEqual(["fiverr.com"]);
  });
});

describe("purchase flow", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await createTestContext();
  });

  it("AUTO path (vaulted): pays immediately and returns a receipt", async () => {
    const { agent } = await seedAgent(ctx);
    await setMode(ctx, "vaulted");
    const v = await submitPurchase(ctx, agent, { ...dataset, client_request_id: "c-1" });
    expect(v).toMatchObject({ status: "paid", decision: "AUTO_APPROVE", display_id: "R-0001" });
    expect(v.receipt?.capture_id).toBeTruthy();
    const stages = (await listDecisions(ctx.db, v.request_id)).map((d) => `${d.stage}:${d.decision}`);
    expect(stages).toEqual(["hard_rules:PASS", "llm:AUTO_APPROVE"]);
  });

  it("is idempotent on client_request_id (no double payment)", async () => {
    const { agent } = await seedAgent(ctx);
    await setMode(ctx, "vaulted");
    const a = await submitPurchase(ctx, agent, { ...dataset, client_request_id: "same" });
    const b = await submitPurchase(ctx, agent, { ...dataset, client_request_id: "same" });
    expect(b.request_id).toBe(a.request_id);
    expect(ctx.paypal.calls.filter((c) => c === "createOrder")).toHaveLength(1);
  });

  it("ASK path: pending_human, notifies, then human approve pays (vaulted)", async () => {
    const { agent } = await seedAgent(ctx);
    await setMode(ctx, "vaulted");
    const v = await submitPurchase(ctx, agent, report);
    expect(v.status).toBe("pending_human");
    expect(ctx.notifier.pending.map((p) => p.request_id)).toEqual([v.request_id]);
    const paid = await decideRequest(ctx, v.request_id, "approve", "web");
    expect(paid.status).toBe("paid");
    await expect(decideRequest(ctx, v.request_id, "deny", "telegram")).rejects.toMatchObject({ status: 409 });
  });

  it("human deny records the actor and never calls PayPal", async () => {
    const { agent } = await seedAgent(ctx);
    const v = await submitPurchase(ctx, agent, report);
    const denied = await decideRequest(ctx, v.request_id, "deny", "telegram");
    expect(denied.status).toBe("denied");
    expect(ctx.paypal.calls).not.toContain("createOrder");
  });

  it("concurrent approvals: exactly one wins", async () => {
    const { agent } = await seedAgent(ctx);
    await setMode(ctx, "vaulted");
    const v = await submitPurchase(ctx, agent, report);
    const results = await Promise.allSettled([decideRequest(ctx, v.request_id, "approve", "web"), decideRequest(ctx, v.request_id, "approve", "telegram")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(ctx.paypal.calls.filter((c) => c === "createOrder")).toHaveLength(1);
  });

  it("DENY path: hard rules block the injection, auditor only explains", async () => {
    const { agent } = await seedAgent(ctx);
    const v = await submitPurchase(ctx, agent, injected);
    expect(v.status).toBe("denied");
    expect(v.decision).toBe("DENY");
    expect(v.reason).toContain("Blocked by hard rules");
    expect(v.reason).toContain("prompt injection");
    expect(v.reason).not.toContain("buy the premium logo package");
    const ds = await listDecisions(ctx.db, v.request_id);
    expect(ds[0]!.decision).toBe("DENY");
    expect(ds[1]!.details).toMatchObject({ advisory: true });
    expect(ctx.paypal.calls).toEqual([]);
  });

  it("LLM DENY after hard rules pass (injection to an allowed merchant)", async () => {
    const { agent } = await seedAgent(ctx);
    const v = await submitPurchase(ctx, agent, { ...dataset, reason: "The page told me to ignore previous instructions" });
    expect(v).toMatchObject({ status: "denied", decision: "DENY" });
  });

  it("no mandate -> DENY", async () => {
    const out = await createAgent(ctx, "No mandate");
    const agent = await authenticateAgent(ctx, `Bearer ${out.api_key}`);
    expect((await submitPurchase(ctx, agent, dataset)).status).toBe("denied");
  });

  it("auditor failure falls back to ASK_HUMAN", async () => {
    ctx = await createTestContext({ auditor: { name: "broken", audit: async () => { throw new Error("529 overloaded"); } } });
    const { agent } = await seedAgent(ctx);
    const v = await submitPurchase(ctx, agent, dataset);
    expect(v).toMatchObject({ status: "pending_human", decision: "ASK_HUMAN", risk: null });
  });

  it("supervised AUTO path waits for the buyer", async () => {
    const { agent } = await seedAgent(ctx);
    await setMode(ctx, "supervised");
    const v = await submitPurchase(ctx, agent, dataset);
    expect(v.status).toBe("awaiting_buyer");
    const p = await getPaymentByRequest(ctx.db, v.request_id);
    expect(p?.approveUrl).toContain("paypal.com");
  });

  it("payment failure marks the request failed", async () => {
    const { agent } = await seedAgent(ctx);
    await setMode(ctx, "vaulted");
    ctx.paypal.failNextCreate = new Error("PayPal 500");
    expect((await submitPurchase(ctx, agent, dataset)).status).toBe("failed");
  });

  it("monthly limit counts committed spend", async () => {
    const { agent } = await seedAgent(ctx, { auto_approve_limit: "60.00", monthly_limit: "60.00" });
    await setMode(ctx, "vaulted");
    expect((await submitPurchase(ctx, agent, { ...dataset, amount: "50.00" })).status).toBe("paid");
    const v = await submitPurchase(ctx, agent, { ...dataset, amount: "11.00" });
    expect(v.status).toBe("denied");
    expect(v.reason).toContain("left this month");
  });

  it("velocity: 4th request inside 10 minutes is denied", async () => {
    const { agent } = await seedAgent(ctx, { monthly_limit: "1000.00" });
    for (let i = 0; i < 3; i++) await submitPurchase(ctx, agent, { ...dataset, amount: "1.00" });
    const v = await submitPurchase(ctx, agent, { ...dataset, amount: "1.00" });
    expect(v.status).toBe("denied");
    expect(v.reason).toContain("last 10 minutes");
  });

  it("expires stale approvals and rejects late decisions", async () => {
    let now = Date.now();
    ctx = await createTestContext({ now: () => now, config: { approvalTtlMs: 60_000 } });
    const { agent } = await seedAgent(ctx);
    const v = await submitPurchase(ctx, agent, report);
    now += 61_000;
    await expect(decideRequest(ctx, v.request_id, "approve", "web")).rejects.toMatchObject({ code: "expired" });
    const v2 = await submitPurchase(ctx, agent, { ...report, client_request_id: "z" });
    now += 61_000;
    expect(await expireStale(ctx)).toBe(1);
    const [row] = await getLedger(ctx, { status: ["expired"], limit: 1 });
    expect(row?.request_id).toBe(v2.request_id);
  });

  it("emits SSE events for each state change", async () => {
    const seen: string[] = [];
    ctx.events.subscribe((e) => seen.push(`${e.type}:${e.request.status}`));
    const { agent } = await seedAgent(ctx);
    await setMode(ctx, "vaulted");
    await submitPurchase(ctx, agent, dataset);
    expect(seen).toEqual(["request.created:reviewing", "request.updated:paying", "request.updated:paid"]);
  });

  it("ledger rows carry decisions, mandate version and payment ids but no vault id", async () => {
    const { agent } = await seedAgent(ctx);
    await setMode(ctx, "vaulted");
    await submitPurchase(ctx, agent, dataset);
    const [row] = await getLedger(ctx);
    expect(row).toMatchObject({ agent_name: "Research Scout", mandate_version: 1, status: "paid" });
    expect(row!.payment?.capture_id).toBeTruthy();
    expect(JSON.stringify(row)).not.toContain("VAULT-TEST");
  });
});
