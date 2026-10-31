import { getAgent, getMandate, getPaymentByRequest, getRequest, listDecisions } from "@reins/db";
import { centsToValue } from "./money.ts";
import { displayId } from "./pay/strategies.ts";
import { ReinsError, type ReinsContext } from "./service.ts";
import { receiptUrl } from "./views.ts";

/** Feature S4: what the receipt page (/receipts/:id) shows. No vault id, no raw PayPal payloads, no agent free text beyond items. */
export interface Receipt {
  request_id: string;
  display_id: string;
  agent_name: string;
  merchant: string;
  items: string;
  amount: string;
  currency: string;
  paid_at: string;
  requested_at: string;
  /** How it was approved: "auto" (rules + auditor) or the human channel ("web", "telegram"). */
  approved_by: string;
  mandate_version: number | null;
  payment: {
    strategy: "vaulted" | "supervised" | "treasury";
    order_id: string | null;
    capture_id: string | null;
    payout_batch_id: string | null;
    reconciled: "unchecked" | "matched" | "mismatch";
  };
  receipt_url: string | null;
}

/** Receipt for a paid request; 404 for anything that has not been paid (nothing to show yet). */
export async function getReceipt(ctx: ReinsContext, requestId: string): Promise<Receipt> {
  const r = await getRequest(ctx.db, requestId);
  const payment = r ? await getPaymentByRequest(ctx.db, r.id) : undefined;
  if (!r || r.status !== "paid" || !payment) throw new ReinsError(404, "not_found", "No receipt: this request is not paid");
  const [agent, mandate, decisions] = await Promise.all([
    getAgent(ctx.db, r.agentId),
    r.mandateId ? getMandate(ctx.db, r.mandateId) : undefined,
    listDecisions(ctx.db, r.id),
  ]);
  const human = decisions.find((d) => d.stage === "human" && d.decision === "APPROVE");
  return {
    request_id: r.id,
    display_id: displayId(r.seq),
    agent_name: agent?.name ?? r.agentId,
    merchant: r.merchant,
    items: r.items,
    amount: centsToValue(payment.amountCents),
    currency: payment.currency,
    paid_at: new Date(payment.updatedAt).toISOString(),
    requested_at: new Date(r.createdAt).toISOString(),
    approved_by: human ? (human.actor ?? "human") : "auto",
    mandate_version: mandate?.version ?? null,
    payment: {
      strategy: payment.strategy,
      order_id: payment.paypalOrderId,
      capture_id: payment.captureId,
      payout_batch_id: payment.payoutBatchId,
      reconciled: payment.reconciled,
    },
    receipt_url: receiptUrl(ctx.config.publicBaseUrl, r.id),
  };
}
