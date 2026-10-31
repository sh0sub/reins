import type { Decision, Mandate, Payment, PurchaseRequest, RequestAnomaly, RequestMessage } from "@reins/db";
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
  /** The agent's own justification as submitted (shown to the human; never fed back as the decision reason). */
  agent_reason: string;
  created_at: string;
  updated_at: string;
  /** S4: returned to the agent once paid. receipt_url opens the Reins receipt page (dashboard login applies). */
  receipt: {
    capture_id: string | null;
    payout_batch_id: string | null;
    amount: string;
    currency: string;
    merchant: string;
    paid_at: string;
    receipt_url: string | null;
  } | null;
  /** S3 unusual patterns flagged in code (empty when none). */
  anomalies: RequestAnomaly[];
  /** S2 Ask agent: true while the human's latest question has no agent answer yet. */
  needs_clarification: boolean;
  /** Latest question/answer pair, or null when nobody asked. */
  clarification: {
    question: string;
    asked_at: string;
    answer: string | null;
    /** S2: one-line AI summary of a long answer (null for short answers). */
    answer_summary: string | null;
    answered_at: string | null;
  } | null;
}

export function latestClarification(messages: RequestMessage[] = []): RequestView["clarification"] {
  let q: RequestMessage | undefined;
  let a: RequestMessage | undefined;
  for (const m of messages) {
    if (m.role === "human") {
      q = m;
      a = undefined;
    } else if (q) a = m;
  }
  if (!q) return null;
  return {
    question: q.body,
    asked_at: new Date(q.createdAt).toISOString(),
    answer: a?.body ?? null,
    answer_summary: a?.summary ?? null,
    answered_at: a ? new Date(a.createdAt).toISOString() : null,
  };
}

/** Absolute receipt page URL for a request, e.g. https://reins.app/receipts/req_... */
export function receiptUrl(baseUrl: string | undefined, requestId: string): string | null {
  return baseUrl ? `${baseUrl.replace(/\/$/, "")}/receipts/${requestId}` : null;
}

export function toRequestView(r: PurchaseRequest, payment?: Payment | null, messages: RequestMessage[] = [], baseUrl?: string): RequestView {
  const clarification = latestClarification(messages);
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
    agent_reason: r.reason,
    created_at: new Date(r.createdAt).toISOString(),
    updated_at: new Date(r.updatedAt).toISOString(),
    receipt:
      r.status === "paid" && payment
        ? {
            capture_id: payment.captureId,
            payout_batch_id: payment.payoutBatchId,
            amount: centsToValue(payment.amountCents),
            currency: payment.currency,
            merchant: r.merchant,
            paid_at: new Date(payment.updatedAt).toISOString(),
            receipt_url: receiptUrl(baseUrl, r.id),
          }
        : null,
    anomalies: r.anomalies ?? [],
    needs_clarification: r.status === "pending_human" && clarification != null && clarification.answer == null,
    clarification,
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
    reconciled_at: string | null;
    reconcile_note: string | null;
    error: string | null;
  } | null;
  messages: Array<{ role: RequestMessage["role"]; body: string; actor: string | null; created_at: string }>;
}

export function toLedgerRow(
  r: PurchaseRequest,
  agentName: string,
  mandate: Mandate | undefined,
  decisions: Decision[],
  payment: Payment | undefined,
  messages: RequestMessage[] = [],
  baseUrl?: string,
): LedgerRow {
  return {
    ...toRequestView(r, payment, messages, baseUrl),
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
          reconciled_at: payment.reconciledAt == null ? null : new Date(payment.reconciledAt).toISOString(),
          reconcile_note: payment.reconcileNote ?? null,
          error: payment.error,
        }
      : null,
    messages: messages.map((m) => ({ role: m.role, body: m.body, actor: m.actor, created_at: new Date(m.createdAt).toISOString() })),
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
    /** S5 merchant rules: merchant -> auto-approve limit ("59.00"). */
    merchant_auto_limits: Object.fromEntries(Object.entries(m.merchantAutoLimits ?? {}).map(([k, v]) => [k, centsToValue(v)])),
    purpose: m.purpose,
    valid_from: m.validFrom == null ? null : new Date(m.validFrom).toISOString(),
    valid_until: m.validUntil == null ? null : new Date(m.validUntil).toISOString(),
  };
}
