import { getPaymentByRequest, getRequest, insertDecision, listRequests, transitionRequest, updatePayment, type Payment, type PurchaseRequest } from "@reins/db";
import { PAYOUT_UNCLAIMED_NOTE, captureApprovedOrder, type StrategyResult } from "./pay/strategies.ts";
import { firstCapture } from "./paypal/types.ts";
import { ReinsError, UNKNOWN_PREFIX, executePayment, notifyChannels, publishRequest, requestViewOf, type ReinsContext } from "./service.ts";
import type { RequestView } from "./views.ts";

/**
 * H5 supervised checkout return/cancel and H4/M6 resolution of payments whose outcome is not known yet.
 *
 * Every path that moves money claims the request with the same compare-and-set as the CHECKOUT.ORDER.APPROVED webhook
 * (awaiting_buyer -> paying), so the buyer's return and the webhook can race safely: only one of them captures, and
 * the capture carries PayPal-Request-Id `reins-capture-<request id>` so even a retried capture is replayed by PayPal.
 */

export interface CheckoutOutcome {
  view: RequestView;
  /** What happened on this call (the page shows a matching sentence). */
  outcome: "paid" | "pending" | "failed" | "canceled" | "not_approved" | "unchanged";
}

async function load(ctx: ReinsContext, requestId: string): Promise<{ r: PurchaseRequest; payment: Payment | undefined }> {
  const r = await getRequest(ctx.db, requestId);
  if (!r) throw new ReinsError(404, "not_found", "Request not found");
  return { r, payment: await getPaymentByRequest(ctx.db, r.id) };
}

function checkToken(payment: Payment | undefined, token: string | null | undefined) {
  if (token && payment?.paypalOrderId && token !== payment.paypalOrderId) throw new ReinsError(409, "order_mismatch", "This PayPal order does not belong to the request");
}

/** Applies a capture result to a request already in `paying` (shared by return, webhook-style resolution and the sweeper). */
async function applyCapture(ctx: ReinsContext, payment: Payment, result: StrategyResult): Promise<CheckoutOutcome["outcome"]> {
  if (result.status === "pending" || result.status === "unknown") {
    // only while the request is still paying: a webhook may have settled it in the meantime
    if ((await getRequest(ctx.db, payment.requestId))?.status === "paying") {
      await updatePayment(ctx.db, payment.id, { status: "pending", captureId: result.captureId ?? payment.captureId, error: result.status === "unknown" ? `${UNKNOWN_PREFIX}${result.error ?? ""}`.slice(0, 500) : null });
    }
    return "pending";
  }
  const ok = result.status === "completed";
  const moved = await transitionRequest(ctx.db, payment.requestId, ["paying"], { status: ok ? "paid" : "failed" });
  if (!moved) return "unchanged";
  // M2: payment.status is written only after the request transition succeeded
  await updatePayment(ctx.db, payment.id, { status: ok ? "completed" : "failed", captureId: result.captureId ?? payment.captureId, error: result.error?.slice(0, 500) ?? null });
  await notifyChannels(ctx, "resolved", await publishRequest(ctx, moved));
  return ok ? "paid" : "failed";
}

/**
 * /pay/return?request=<id>&token=<order id>: the buyer approved the order on paypal.com and came back. Captures once
 * (idempotent), or just reports the status when the webhook got there first.
 */
export async function returnFromCheckout(ctx: ReinsContext, requestId: string, token?: string | null): Promise<CheckoutOutcome> {
  const { r, payment } = await load(ctx, requestId);
  checkToken(payment, token);
  if (r.status === "paying" && payment) {
    // the webhook (or an earlier return) is capturing right now: only read PayPal, never capture or re-run from here
    const outcome = await resolvePayment(ctx, r, payment, { readOnly: true });
    return { view: await requestViewOf(ctx, (await getRequest(ctx.db, r.id))!), outcome };
  }
  if (r.status !== "awaiting_buyer" || !payment?.paypalOrderId) return { view: await requestViewOf(ctx, r), outcome: "unchanged" };
  const order = await ctx.paypal.getOrder(payment.paypalOrderId).catch(() => null);
  if (order && order.status !== "APPROVED" && order.status !== "COMPLETED") return { view: await requestViewOf(ctx, r), outcome: "not_approved" };
  const claimed = await transitionRequest(ctx.db, r.id, ["awaiting_buyer"], { status: "paying" });
  if (!claimed) return { view: await requestViewOf(ctx, (await getRequest(ctx.db, r.id))!), outcome: "unchanged" };
  await publishRequest(ctx, claimed);
  const outcome = await applyCapture(ctx, payment, await captureApprovedOrder(ctx.paypal, payment.paypalOrderId, r.id));
  return { view: await requestViewOf(ctx, (await getRequest(ctx.db, r.id))!), outcome };
}

/**
 * /pay/cancel?request=<id>&token=<order id>: the buyer backed out on paypal.com. The request moves to failed and stops
 * counting as committed spend. Needs the order token PayPal appends, so a bare request id cannot cancel someone's order.
 */
export async function cancelCheckout(ctx: ReinsContext, requestId: string, token?: string | null): Promise<CheckoutOutcome> {
  const { r, payment } = await load(ctx, requestId);
  checkToken(payment, token);
  if (r.status !== "awaiting_buyer" || !token) return { view: await requestViewOf(ctx, r), outcome: "unchanged" };
  const failed = await transitionRequest(ctx.db, r.id, ["awaiting_buyer"], {
    status: "failed",
    reasonEn: `Buyer canceled the PayPal checkout. ${r.reasonEn ?? ""}`.trim(),
  });
  if (!failed) return { view: await requestViewOf(ctx, (await getRequest(ctx.db, r.id))!), outcome: "unchanged" };
  if (payment) await updatePayment(ctx.db, payment.id, { status: "failed", error: "canceled_by_buyer" });
  await insertDecision(ctx.db, { requestId: r.id, stage: "system", decision: "EXPIRE", risk: null, reasonEn: "Buyer canceled the PayPal checkout; nothing was charged", reasonKo: "구매자가 PayPal 결제를 취소함", details: { canceled: true }, actor: "paypal" });
  const view = await publishRequest(ctx, failed);
  await notifyChannels(ctx, "resolved", view);
  return { view, outcome: "canceled" };
}

/**
 * H4/M6: asks PayPal again about a request stuck in `paying`.
 * - supervised order with an id: GET order -> COMPLETED is paid, APPROVED is captured (same PayPal-Request-Id)
 * - no payment row (crash between claim and PayPal) or an "unknown" vaulted/supervised create: re-run the strategy,
 *   which is idempotent through `reins-create-<id>` / `reins-capture-<id>`
 * - treasury payout: GET the batch (read only, never re-sent): SUCCESS is paid, a definite failure is failed, UNCLAIMED
 *   stays committed with a note (PayPal holds the money for the payee); the payout webhook settles it the same way
 * - PENDING captures wait for their webhook
 */
async function resolvePayment(ctx: ReinsContext, r: PurchaseRequest, payment: Payment | undefined, opts: { readOnly?: boolean } = {}): Promise<CheckoutOutcome["outcome"]> {
  const unknown = payment?.error?.startsWith(UNKNOWN_PREFIX) ?? false;
  if (opts.readOnly && (!payment || !payment.paypalOrderId)) return "pending";
  // treasury: an unknown payout is never re-sent (a second batch could pay twice, and a refused duplicate
  // sender_batch_id would read as a failure); it stays committed until the payout webhook or a person settles it
  if (!payment || (unknown && !payment.paypalOrderId && payment.strategy !== "treasury")) {
    const v = await executePayment(ctx, r);
    return v.status === "paid" ? "paid" : v.status === "failed" ? "failed" : "pending";
  }
  if (payment.strategy === "treasury") return opts.readOnly ? "pending" : resolvePayout(ctx, payment);
  if (!payment.paypalOrderId) return "pending";
  const order = await ctx.paypal.getOrder(payment.paypalOrderId).catch(() => null);
  if (!order) return "pending";
  const cap = firstCapture(order);
  if (order.status === "COMPLETED" && cap?.status === "COMPLETED") return applyCapture(ctx, payment, { status: "completed", orderId: order.id, captureId: cap.id });
  if (order.status === "APPROVED") return opts.readOnly ? "pending" : applyCapture(ctx, payment, await captureApprovedOrder(ctx.paypal, payment.paypalOrderId, r.id));
  if (cap && (cap.status === "DECLINED" || cap.status === "FAILED")) return applyCapture(ctx, payment, { status: "failed", orderId: order.id, error: `Capture ${cap.status}` });
  return "pending";
}

/** Payout item states that mean the money did not reach the payee and will not (PayPal Payouts transaction_status). */
const PAYOUT_FAILED = new Set(["FAILED", "DENIED", "BLOCKED", "RETURNED", "REFUNDED", "REVERSED"]);

/** An unclaimed payout can wait 30 days: ask PayPal about it at most this often. */
const UNCLAIMED_RECHECK_MS = 60 * 60_000;

async function resolvePayout(ctx: ReinsContext, payment: Payment): Promise<CheckoutOutcome["outcome"]> {
  if (!payment.payoutBatchId || !ctx.paypal.getPayout) return "pending";
  if (payment.error === PAYOUT_UNCLAIMED_NOTE && ctx.now() - payment.updatedAt < UNCLAIMED_RECHECK_MS) return "pending";
  const batch = await ctx.paypal.getPayout(payment.payoutBatchId).catch(() => null);
  const item = batch?.items?.[0];
  const s = item?.transaction_status ?? "";
  if (s === "SUCCESS") return applyCapture(ctx, payment, { status: "completed", captureId: item?.transaction_id ?? undefined });
  if (PAYOUT_FAILED.has(s)) return applyCapture(ctx, payment, { status: "failed", error: `Payout ${s}` });
  // the whole batch was refused (for example not enough balance): no item ever pays
  const batchStatus = batch?.batch_header?.batch_status ?? "";
  if (!s && (batchStatus === "DENIED" || batchStatus === "CANCELED")) return applyCapture(ctx, payment, { status: "failed", error: `Payout batch ${batchStatus}` });
  if (s === "UNCLAIMED" && (await getRequest(ctx.db, payment.requestId))?.status === "paying") {
    // also stamps updated_at, which spaces out the next look (UNCLAIMED_RECHECK_MS)
    await updatePayment(ctx.db, payment.id, { status: "pending", error: PAYOUT_UNCLAIMED_NOTE });
  }
  return "pending";
}

/** M6 sweeper: `paying` requests older than `minAgeMs` get one more look at PayPal. Run on the expiry interval. */
const sweeping = new WeakSet<object>();

export async function resolvePendingPayments(ctx: ReinsContext, minAgeMs = 2 * 60_000): Promise<number> {
  // one sweep per database at a time (PayPal calls can take 30 s, longer than the sweep interval)
  if (sweeping.has(ctx.db)) return 0;
  sweeping.add(ctx.db);
  try {
    const paying = await listRequests(ctx.db, { status: ["paying"], limit: 100 });
    let n = 0;
    for (const r of paying) {
      if (ctx.now() - r.updatedAt < minAgeMs) continue;
      const outcome = await resolvePayment(ctx, r, await getPaymentByRequest(ctx.db, r.id)).catch(() => "pending" as const);
      if (outcome !== "pending" && outcome !== "unchanged") n++;
    }
    return n;
  } finally {
    sweeping.delete(ctx.db);
  }
}
