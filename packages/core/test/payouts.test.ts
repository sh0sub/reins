/**
 * Treasury mode end to end without a webhook (hosted demo): the sweeper reads the payout batch; UNCLAIMED is a truthful
 * "sent, not claimed yet" state, never "failed"; and treasury without a payee address falls back to supervised checkout.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPaymentByRequest, getRequest, updateRequest } from "@reins/db";
import { createTestContext, FakePayPalClient } from "../src/testing.ts";
import { resolvePendingPayments } from "../src/checkout.ts";
import { PAYOUT_UNCLAIMED_NOTE, usablePaymentMode } from "../src/pay/strategies.ts";
import { submitPurchase } from "../src/service.ts";
import { handlePayPalWebhook } from "../src/webhooks.ts";
import { dataset, seedAgent, setMode } from "./helpers.ts";

type Ctx = Awaited<ReturnType<typeof createTestContext>>;
const deliver = (ctx: Ctx, event: unknown) => handlePayPalWebhook(ctx, FakePayPalClient.headers() as unknown as Record<string, string>, JSON.stringify(event));

/** Makes the request old enough for the sweeper (it skips anything touched in the last 2 minutes). */
async function age(ctx: Ctx, requestId: string) {
  await updateRequest(ctx.db, requestId, {});
  const later = Date.now() + 5 * 60_000;
  ctx.now = () => later;
}

describe("treasury payouts settle without a webhook", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await createTestContext();
  });

  it("SUCCESS from GET payout: paid, the payout transaction id is stored", async () => {
    const { agent } = await seedAgent(ctx);
    await setMode(ctx, "treasury");
    const v = await submitPurchase(ctx, agent, dataset);
    expect(v.status).toBe("paying");
    const pay = (await getPaymentByRequest(ctx.db, v.request_id))!;
    await resolvePendingPayments(ctx);
    expect((await getRequest(ctx.db, v.request_id))!.status).toBe("paying"); // too fresh: not asked yet
    await age(ctx, v.request_id);
    expect(await resolvePendingPayments(ctx)).toBe(0); // PENDING at PayPal: still paying, not failed
    expect((await getRequest(ctx.db, v.request_id))!.status).toBe("paying");
    ctx.paypal.payoutItemStatus.set(pay.payoutBatchId!, "SUCCESS");
    expect(await resolvePendingPayments(ctx)).toBe(1);
    expect((await getRequest(ctx.db, v.request_id))!.status).toBe("paid");
    expect(await getPaymentByRequest(ctx.db, v.request_id)).toMatchObject({ status: "completed", captureId: `${pay.payoutBatchId}-TXN` });
    expect(ctx.paypal.calls.filter((c) => c === "createPayout")).toHaveLength(1); // read only: never re-sent
  });

  it("UNCLAIMED (sweeper or webhook) keeps the request committed with a note; RETURNED then fails it", async () => {
    const { agent } = await seedAgent(ctx);
    await setMode(ctx, "treasury");
    const v = await submitPurchase(ctx, agent, dataset);
    const pay = (await getPaymentByRequest(ctx.db, v.request_id))!;
    ctx.paypal.payoutItemStatus.set(pay.payoutBatchId!, "UNCLAIMED");
    await age(ctx, v.request_id);
    await resolvePendingPayments(ctx);
    expect((await getRequest(ctx.db, v.request_id))!.status).toBe("paying");
    expect(await getPaymentByRequest(ctx.db, v.request_id)).toMatchObject({ status: "pending", error: PAYOUT_UNCLAIMED_NOTE });

    expect((await deliver(ctx, ctx.paypal.payoutItemEvent(pay.payoutBatchId!, "UNCLAIMED"))).body.outcome).toBe("unclaimed");
    expect((await getRequest(ctx.db, v.request_id))!.status).toBe("paying");
    expect((await getPaymentByRequest(ctx.db, v.request_id))!.status).toBe("pending");

    expect((await deliver(ctx, ctx.paypal.payoutItemEvent(pay.payoutBatchId!, "RETURNED"))).body.outcome).toBe("failed");
    expect((await getRequest(ctx.db, v.request_id))!.status).toBe("failed");
  });

  it("an unclaimed payout is asked about at most hourly; a batch refused as a whole fails the request", async () => {
    const { agent } = await seedAgent(ctx);
    await setMode(ctx, "treasury");
    const v = await submitPurchase(ctx, agent, dataset);
    const pay = (await getPaymentByRequest(ctx.db, v.request_id))!;
    ctx.paypal.payoutItemStatus.set(pay.payoutBatchId!, "UNCLAIMED");
    await age(ctx, v.request_id);
    await resolvePendingPayments(ctx);
    const asked = ctx.paypal.calls.filter((c) => c === "getPayout").length;
    await resolvePendingPayments(ctx);
    expect(ctx.paypal.calls.filter((c) => c === "getPayout").length).toBe(asked); // within the hour: not asked again

    const v2 = await submitPurchase(ctx, agent, { ...dataset, client_request_id: "batch-denied" });
    const pay2 = (await getPaymentByRequest(ctx.db, v2.request_id))!;
    ctx.paypal.getPayout = async (id: string) => ({ batch_header: { payout_batch_id: id, batch_status: id === pay2.payoutBatchId ? "DENIED" : "PENDING" }, items: [] });
    const later = Date.now() + 10 * 60_000;
    ctx.now = () => later;
    await resolvePendingPayments(ctx);
    expect((await getRequest(ctx.db, v2.request_id))!.status).toBe("failed");
    expect((await getPaymentByRequest(ctx.db, v2.request_id))!.error).toBe("Payout batch DENIED");
  });

  it("agents cannot use the recorded-run prefix (it would hide a payment from reconciliation)", async () => {
    const { agent } = await seedAgent(ctx);
    await expect(submitPurchase(ctx, agent, { ...dataset, client_request_id: "recorded:x" })).rejects.toMatchObject({ status: 400 });
  });

  it("a definite payout failure from GET payout fails the request", async () => {
    const { agent } = await seedAgent(ctx);
    await setMode(ctx, "treasury");
    const v = await submitPurchase(ctx, agent, dataset);
    const pay = (await getPaymentByRequest(ctx.db, v.request_id))!;
    ctx.paypal.payoutItemStatus.set(pay.payoutBatchId!, "BLOCKED");
    await age(ctx, v.request_id);
    await resolvePendingPayments(ctx);
    expect((await getRequest(ctx.db, v.request_id))!.status).toBe("failed");
    expect((await getPaymentByRequest(ctx.db, v.request_id))!.error).toBe("Payout BLOCKED");
  });
});

describe("treasury without TREASURY_PAYEE_EMAIL fails safe", () => {
  it("usablePaymentMode falls back to supervised only for treasury without a payee", () => {
    expect(usablePaymentMode("treasury", null)).toBe("supervised");
    expect(usablePaymentMode("treasury", "  ")).toBe("supervised");
    expect(usablePaymentMode("treasury", "payee@personal.example.com")).toBe("treasury");
    expect(usablePaymentMode("vaulted", null)).toBe("vaulted");
  });

  it("an approved request pays through supervised checkout (no payout, no failed payment) and warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const ctx = await createTestContext({ config: { treasuryPayeeEmail: null } });
    const { agent } = await seedAgent(ctx);
    await setMode(ctx, "treasury");
    const v = await submitPurchase(ctx, agent, dataset);
    expect(v.status).toBe("awaiting_buyer");
    expect(await getPaymentByRequest(ctx.db, v.request_id)).toMatchObject({ strategy: "supervised", status: "awaiting_buyer" });
    expect(ctx.paypal.calls).not.toContain("createPayout");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("TREASURY_PAYEE_EMAIL"));
    warn.mockRestore();
  });
});
