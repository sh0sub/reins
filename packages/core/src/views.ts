import type { Decision, Mandate, Payment, PurchaseRequest } from "@reins/db";
import { centsToValue } from "./money.ts";
import { displayId } from "./pay/strategies.ts";

/** What agents (MCP) and the UI see for a request. Never includes vault ids or raw PayPal payloads. */
export interface RequestView {
  request_id: string;
  display_id: string;
  agent_id: string;
  status: PurchaseRequest["status"];
  decision: PurchaseRequest["finalDecision"];
  risk: number | null;
  reason: string | null;
  reason_ko: string | null;
  merchant: string;
  amount: string;
  currency: string;
  items: string;
  created_at: string;
  updated_at: string;
  receipt: { capture_id: string | null; payout_batch_id: string | null; amount: string; merchant: string } | null;
}

export function toRequestView(r: PurchaseRequest, payment?: Payment | null): RequestView {
  return {
    request_id: r.id,
    display_id: displayId(r.seq),
    agent_id: r.agentId,
    status: r.status,
    decision: r.finalDecision,
    risk: r.risk,
    reason: r.reasonEn,
    reason_ko: r.reasonKo,
    merchant: r.merchant,
    amount: centsToValue(r.amountCents),
    currency: r.currency,
    items: r.items,
    created_at: new Date(r.createdAt).toISOString(),
    updated_at: new Date(r.updatedAt).toISOString(),
    receipt:
      r.status === "paid" && payment
        ? { capture_id: payment.captureId, payout_batch_id: payment.payoutBatchId, amount: centsToValue(payment.amountCents), merchant: r.merchant }
        : null,
  };
}

/** Admin/ledger view: adds the decision trail and payment ids (still no vault id). */
export interface LedgerRow extends RequestView {
  agent_name: string;
  mandate_version: number | null;
  decisions: Array<Pick<Decision, "stage" | "decision" | "risk" | "reasonEn" | "reasonKo" | "details" | "actor"> & { created_at: string }>;
  payment: {
    strategy: Payment["strategy"];
    status: Payment["status"];
    order_id: string | null;
    capture_id: string | null;
    payout_batch_id: string | null;
    approve_url: string | null;
    reconciled: Payment["reconciled"];
    error: string | null;
  } | null;
}

export function toLedgerRow(
  r: PurchaseRequest,
  agentName: string,
  mandate: Mandate | undefined,
  decisions: Decision[],
  payment: Payment | undefined,
): LedgerRow {
  return {
    ...toRequestView(r, payment),
    agent_name: agentName,
    mandate_version: mandate?.version ?? null,
    decisions: decisions.map((d) => ({
      stage: d.stage,
      decision: d.decision,
      risk: d.risk,
      reasonEn: d.reasonEn,
      reasonKo: d.reasonKo,
      details: d.details,
      actor: d.actor,
      created_at: new Date(d.createdAt).toISOString(),
    })),
    payment: payment
      ? {
          strategy: payment.strategy,
          status: payment.status,
          order_id: payment.paypalOrderId,
          capture_id: payment.captureId,
          payout_batch_id: payment.payoutBatchId,
          approve_url: payment.approveUrl,
          reconciled: payment.reconciled,
          error: payment.error,
        }
      : null,
  };
}

export function mandateView(m: Mandate) {
  return {
    mandate_id: m.id,
    version: m.version,
    monthly_limit: centsToValue(m.monthlyLimitCents),
    auto_approve_limit: centsToValue(m.autoApproveLimitCents),
    per_purchase_cap: m.perTxCapCents == null ? null : centsToValue(m.perTxCapCents),
    currency: m.currency,
    allowed_merchants: m.allowedMerchants,
    blocked_merchants: m.blockedMerchants,
    categories: m.categories,
    purpose: m.purpose,
    valid_from: m.validFrom == null ? null : new Date(m.validFrom).toISOString(),
    valid_until: m.validUntil == null ? null : new Date(m.validUntil).toISOString(),
  };
}
