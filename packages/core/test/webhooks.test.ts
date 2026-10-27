import { beforeEach, describe, expect, it } from "vitest";
import { countWebhookEvents, getPaymentByRequest, getRequest } from "@reins/db";
import { createTestContext, FakePayPalClient } from "../src/testing.ts";
import { submitPurchase } from "../src/service.ts";
import { handlePayPalWebhook } from "../src/webhooks.ts";
import { dataset, seedAgent, setMode } from "./helpers.ts";

type Ctx = Awaited<ReturnType<typeof createTestContext>>;
const deliver = (ctx: Ctx, event: unknown, headers: Record<string, string> = FakePayPalClient.headers() as unknown as Record<string, string>) =>
  handlePayPalWebhook(ctx, headers, JSON.stringify(event));

describe("M12 webhook signature verification and idempotency", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await createTestContext();
  });

  it("rejects missing PayPal headers before any verification", async () => {
    const r = await handlePayPalWebhook(ctx, {}, JSON.stringify({ id: "WH-1", event_type: "X", resource: {} }));
    expect(r.status).toBe(400);
    expect(ctx.paypal.calls).not.toContain("verifyWebhookSignature");
  });

  it("rejects non-JSON bodies", async () => {
    const r = await handlePayPalWebhook(ctx, FakePayPalClient.headers() as never, "not json");
    expect(r.status).toBe(400);
  });

  it("rejects a FAILURE signature and stores nothing", async () => {
    ctx.paypal.verifyResult = "FAILURE";
    const r = await deliver(ctx, { id: "WH-2", event_type: "CHECKOUT.ORDER.APPROVED", resource: { id: "O" } });
    expect(r.status).toBe(401);
    expect(await countWebhookEvents(ctx.db)).toBe(0);
  });

  it("returns 503 when the webhook id is not configured or verification is unreachable", async () => {
    const noId = await createTestContext({ config: { paypalWebhookId: undefined } });
    expect((await deliver(noId, { id: "WH-3", event_type: "X", resource: {} })).status).toBe(503);
    ctx.paypal.verifyWebhookSignature = async () => {
      throw new Error("network");
    };
    expect((await deliver(ctx, { id: "WH-4", event_type: "X", resource: {} })).status).toBe(503);
  });

  it("CHECKOUT.ORDER.APPROVED captures a supervised order; the duplicate delivery is a no-op", async () => {
    const { agent } = await seedAgent(ctx);
    await setMode(ctx, "supervised");
    const v = await submitPurchase(ctx, agent, dataset);
    const pay = (await getPaymentByRequest(ctx.db, v.request_id))!;
    ctx.paypal.approveOrder(pay.paypalOrderId!);
    const event = ctx.paypal.orderApprovedEvent(pay.paypalOrderId!);

    const first = await deliver(ctx, event);
    expect(first).toMatchObject({ status: 200, body: { outcome: "paid" } });
    expect((await getRequest(ctx.db, v.request_id))!.status).toBe("paid");
    expect((await getPaymentByRequest(ctx.db, v.request_id))!.captureId).toBeTruthy();

    const again = await deliver(ctx, event);
    expect(again).toMatchObject({ status: 200, body: { duplicate: true } });
    expect(ctx.paypal.calls.filter((c) => c === "captureOrder")).toHaveLength(1);
    expect(await countWebhookEvents(ctx.db)).toBe(1);
  });

  it("PAYMENT.CAPTURE.COMPLETED after APPROVED is harmless", async () => {
    const { agent } = await seedAgent(ctx);
    await setMode(ctx, "supervised");
    const v = await submitPurchase(ctx, agent, dataset);
    const pay = (await getPaymentByRequest(ctx.db, v.request_id))!;
    ctx.paypal.approveOrder(pay.paypalOrderId!);
    await deliver(ctx, ctx.paypal.orderApprovedEvent(pay.paypalOrderId!));
    const r = await deliver(ctx, ctx.paypal.captureCompletedEvent(pay.paypalOrderId!));
    expect(r.body.outcome).toBe("no_transition");
    expect((await getRequest(ctx.db, v.request_id))!.status).toBe("paid");
  });

  it("treasury: PAYOUTS-ITEM.SUCCEEDED settles, FAILED fails", async () => {
    const { agent } = await seedAgent(ctx);
    await setMode(ctx, "treasury");
    const ok = await submitPurchase(ctx, agent, dataset);
    expect(ok.status).toBe("paying");
    const okPay = (await getPaymentByRequest(ctx.db, ok.request_id))!;
    expect((await deliver(ctx, ctx.paypal.payoutItemEvent(okPay.payoutBatchId!))).body.outcome).toBe("paid");

    const bad = await submitPurchase(ctx, agent, { ...dataset, client_request_id: "b" });
    const badPay = (await getPaymentByRequest(ctx.db, bad.request_id))!;
    expect((await deliver(ctx, ctx.paypal.payoutItemEvent(badPay.payoutBatchId!, "FAILED"))).body.outcome).toBe("failed");
    expect((await getRequest(ctx.db, bad.request_id))!.status).toBe("failed");
  });

  it("unknown orders and unsubscribed event types are acknowledged", async () => {
    expect((await deliver(ctx, { id: "WH-9", event_type: "CHECKOUT.ORDER.APPROVED", resource: { id: "NOPE" } })).body.outcome).toBe("unknown_order");
    expect((await deliver(ctx, { id: "WH-10", event_type: "BILLING.PLAN.CREATED", resource: {} })).body.outcome).toBe("ignored");
  });

  it("a processing error returns 500 and the retry is processed again", async () => {
    const { agent } = await seedAgent(ctx);
    await setMode(ctx, "supervised");
    const v = await submitPurchase(ctx, agent, dataset);
    const pay = (await getPaymentByRequest(ctx.db, v.request_id))!;
    ctx.paypal.approveOrder(pay.paypalOrderId!);
    const event = ctx.paypal.orderApprovedEvent(pay.paypalOrderId!);
    const realDb = ctx.db;
    // fail the first DB write after the event row is recorded
    const origUpdate = realDb.update.bind(realDb);
    let failUpdate = true;
    (realDb as { update: typeof realDb.update }).update = ((t: never) => {
      if (failUpdate) {
        failUpdate = false;
        throw new Error("db down");
      }
      return origUpdate(t);
    }) as typeof realDb.update;
    const first = await deliver(ctx, event);
    expect(first.status).toBe(500);
    (realDb as { update: typeof realDb.update }).update = origUpdate;
    const retry = await deliver(ctx, event);
    expect(retry.status).toBe(200);
    expect(retry.body.duplicate).toBeUndefined();
  });
});
