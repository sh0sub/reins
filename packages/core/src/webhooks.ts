import {
  getPaymentByBatchId,
  getPaymentByOrderId,
  getRequest,
  markWebhookProcessed,
  recordWebhookEvent,
  transitionRequest,
  updatePayment,
  type Payment,
} from "@reins/db";
import { captureApprovedOrder } from "./pay/strategies.ts";
import type { WebhookEvent, WebhookHeaders } from "./paypal/types.ts";
import { UNKNOWN_PREFIX, notifyChannels, publishRequest, type ReinsContext } from "./service.ts";

/** Events Reins subscribes to in the sandbox app (finalised in spike #34). */
export const SUBSCRIBED_EVENTS = [
  "CHECKOUT.ORDER.APPROVED",
  "PAYMENT.CAPTURE.COMPLETED",
  "PAYMENT.CAPTURE.DENIED",
  "PAYMENT.CAPTURE.DECLINED",
  "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
  "PAYMENT.PAYOUTS-ITEM.FAILED",
  "PAYMENT.PAYOUTS-ITEM.BLOCKED",
  "PAYMENT.PAYOUTS-ITEM.RETURNED",
  "PAYMENT.PAYOUTS-ITEM.DENIED",
  "PAYMENT.PAYOUTS-ITEM.UNCLAIMED",
] as const;

const HEADER_NAMES = [
  "paypal-auth-algo",
  "paypal-cert-url",
  "paypal-transmission-id",
  "paypal-transmission-sig",
  "paypal-transmission-time",
] as const;

export interface WebhookResult {
  status: number;
  body: { ok: boolean; duplicate?: boolean; outcome?: string; error?: string };
}

type HeaderSource = Headers | Record<string, string | undefined>;
const getHeader = (h: HeaderSource, name: string) =>
  h instanceof Headers ? h.get(name) : (h[name] ?? h[name.toLowerCase()] ?? undefined);

/**
 * POST /api/webhooks/paypal. Order matters:
 * 1. verify signature with PayPal (reject before touching the DB)
 * 2. record event id (PK) -> duplicates are acknowledged with 200 and skipped
 * 3. apply the state change, then mark processed. If step 3 throws we return 500 so PayPal retries,
 *    and the unprocessed row lets the retry run again.
 */
export async function handlePayPalWebhook(ctx: ReinsContext, headers: HeaderSource, rawBody: string): Promise<WebhookResult> {
  const h = {} as WebhookHeaders;
  for (const name of HEADER_NAMES) {
    const v = getHeader(headers, name);
    if (!v) return { status: 400, body: { ok: false, error: `Missing header ${name}` } };
    h[name] = v;
  }
  let event: WebhookEvent;
  try {
    event = JSON.parse(rawBody) as WebhookEvent;
  } catch {
    return { status: 400, body: { ok: false, error: "Body is not JSON" } };
  }
  if (!event?.id || !event.event_type) return { status: 400, body: { ok: false, error: "Not a PayPal event" } };
  const webhookId = ctx.config.paypalWebhookId;
  if (!webhookId) return { status: 503, body: { ok: false, error: "PAYPAL_WEBHOOK_ID not configured" } };

  let verification: "SUCCESS" | "FAILURE";
  try {
    verification = await ctx.paypal.verifyWebhookSignature(h, event, webhookId);
  } catch {
    return { status: 503, body: { ok: false, error: "Signature verification unavailable" } };
  }
  if (verification !== "SUCCESS") return { status: 401, body: { ok: false, error: "Invalid webhook signature" } };

  const seen = await recordWebhookEvent(ctx.db, {
    id: event.id,
    eventType: event.event_type,
    resourceId: typeof event.resource?.id === "string" ? event.resource.id : null,
  });
  if (seen === "duplicate") return { status: 200, body: { ok: true, duplicate: true } };

  try {
    const outcome = await applyEvent(ctx, event);
    await markWebhookProcessed(ctx.db, event.id, outcome);
    return { status: 200, body: { ok: true, outcome } };
  } catch (err) {
    return { status: 500, body: { ok: false, error: err instanceof Error ? err.message.slice(0, 200) : "processing failed" } };
  }
}

/**
 * Moves the request, then (M2) writes payment.status only when that transition succeeded, so a late DENIED event can
 * never mark the payment of a paid request as failed.
 */
async function finish(ctx: ReinsContext, payment: Payment, ok: boolean, from: Parameters<typeof transitionRequest>[2], patch: Parameters<typeof updatePayment>[2] = {}) {
  const r = await transitionRequest(ctx.db, payment.requestId, from, { status: ok ? "paid" : "failed" });
  if (!r) return "no_transition";
  await updatePayment(ctx.db, payment.id, { status: ok ? "completed" : "failed", ...patch });
  const view = await publishRequest(ctx, r);
  await notifyChannels(ctx, "resolved", view);
  return ok ? "paid" : "failed";
}

async function applyEvent(ctx: ReinsContext, event: WebhookEvent): Promise<string> {
  const res = event.resource ?? {};
  switch (event.event_type) {
    case "CHECKOUT.ORDER.APPROVED": {
      const orderId = String(res.id ?? "");
      const payment = await getPaymentByOrderId(ctx.db, orderId);
      if (!payment) return "unknown_order";
      const claimed = await transitionRequest(ctx.db, payment.requestId, ["awaiting_buyer"], { status: "paying" });
      if (!claimed) return "already_handled";
      await publishRequest(ctx, claimed);
      const result = await captureApprovedOrder(ctx.paypal, orderId, payment.requestId);
      if (result.status === "pending" || result.status === "unknown") {
        // still committed; PAYMENT.CAPTURE.* or the resolvePendingPayments sweeper settles it (H4/M3)
        if ((await getRequest(ctx.db, payment.requestId))?.status === "paying") {
          await updatePayment(ctx.db, payment.id, { status: "pending", captureId: result.captureId ?? null, error: result.status === "unknown" ? `${UNKNOWN_PREFIX}${result.error ?? ""}`.slice(0, 500) : null });
        }
        return result.status === "unknown" ? "capture_unknown" : "capture_pending";
      }
      return finish(ctx, payment, result.status === "completed", ["paying"], { captureId: result.captureId ?? null, error: result.error?.slice(0, 500) ?? null });
    }
    case "PAYMENT.CAPTURE.COMPLETED": {
      const related = (res.supplementary_data as { related_ids?: { order_id?: string } } | undefined)?.related_ids;
      const payment = related?.order_id ? await getPaymentByOrderId(ctx.db, related.order_id) : undefined;
      if (!payment) return "unknown_order";
      // M2: PayPal says the money moved. That is authoritative, so it also corrects a request we had given up on
      // (failed after a timeout, expired checkout).
      return finish(ctx, payment, true, ["paying", "awaiting_buyer", "failed", "expired"], { captureId: String(res.id ?? payment.captureId ?? "") || null, error: null });
    }
    case "PAYMENT.CAPTURE.DENIED":
    case "PAYMENT.CAPTURE.DECLINED": {
      const related = (res.supplementary_data as { related_ids?: { order_id?: string } } | undefined)?.related_ids;
      const payment = related?.order_id ? await getPaymentByOrderId(ctx.db, related.order_id) : undefined;
      if (!payment) return "unknown_order";
      return finish(ctx, payment, false, ["paying", "awaiting_buyer"], { error: event.event_type });
    }
    default: {
      if (event.event_type.startsWith("PAYMENT.PAYOUTS-ITEM.")) {
        const batchId = String(res.payout_batch_id ?? "");
        const payment = await getPaymentByBatchId(ctx.db, batchId);
        if (!payment) return "unknown_batch";
        const ok = event.event_type === "PAYMENT.PAYOUTS-ITEM.SUCCEEDED";
        const req = await getRequest(ctx.db, payment.requestId);
        if (!req) return "unknown_request";
        return finish(ctx, payment, ok, ok ? ["paying", "failed"] : ["paying"], {
          captureId: typeof res.transaction_id === "string" ? res.transaction_id : payment.captureId,
          error: ok ? null : event.event_type,
        });
      }
      return "ignored";
    }
  }
}
