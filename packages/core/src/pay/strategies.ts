import { centsToValue } from "../money.ts";
import { PayPalUnknownError, findLink, firstCapture, type CreateOrderBody, type PayPalClient } from "../paypal/types.ts";

export type PaymentMode = "vaulted" | "supervised" | "treasury";

export interface PayableRequest {
  id: string;
  seq: number;
  merchant: string;
  amountCents: number;
  currency: string;
  items: string;
}

export interface PaymentEnv {
  paypal: PayPalClient;
  publicBaseUrl: string;
  /** Required for vaulted mode. */
  vaultId?: string | null;
  /** Required for treasury mode: who receives the payout (sandbox personal/business email). */
  treasuryPayeeEmail?: string | null;
  /** Adds stored_credential{MERCHANT, UNSCHEDULED, SUBSEQUENT} to vault orders. Optional: spike #28 confirmed a vault_id-only reorder also COMPLETES. */
  vaultStoredCredential?: boolean;
}

export interface StrategyResult {
  /** "unknown" (H4): PayPal did not answer definitively; keep the request committed and ask again (resolvePendingPayments). */
  status: "completed" | "awaiting_buyer" | "pending" | "failed" | "unknown";
  orderId?: string;
  captureId?: string;
  payoutBatchId?: string;
  approveUrl?: string;
  error?: string;
}

export interface PaymentStrategy {
  readonly mode: PaymentMode;
  execute(req: PayableRequest, env: PaymentEnv): Promise<StrategyResult>;
}

export const displayId = (seq: number) => `R-${String(seq).padStart(4, "0")}`;

function purchaseUnit(req: PayableRequest): CreateOrderBody["purchase_units"][number] {
  return {
    reference_id: req.id,
    custom_id: req.id, // used by nightly Transaction Search reconciliation
    description: `${displayId(req.seq)} ${req.merchant}: ${req.items}`.slice(0, 127),
    amount: { currency_code: req.currency, value: centsToValue(req.amountCents) },
  };
}

async function guard(fn: () => Promise<StrategyResult>): Promise<StrategyResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof PayPalUnknownError) return { status: "unknown", error: err.message };
    return { status: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}

/** Automatic mode: order with the saved vault_id, captured without the buyer present. */
export const vaultedStrategy: PaymentStrategy = {
  mode: "vaulted",
  execute: (req, env) =>
    guard(async () => {
      if (!env.vaultId) return { status: "failed", error: "No saved PayPal (vault_id). Run onboarding step 3." };
      const body: CreateOrderBody = {
        intent: "CAPTURE",
        purchase_units: [purchaseUnit(req)],
        payment_source: {
          paypal: {
            vault_id: env.vaultId,
            ...(env.vaultStoredCredential
              ? { stored_credential: { payment_initiator: "MERCHANT", payment_type: "UNSCHEDULED", usage: "SUBSEQUENT" } }
              : {}),
          },
        },
      };
      let order = await env.paypal.createOrder(body, `reins-create-${req.id}`);
      // Sandbox returns COMPLETED directly for vault_id orders (spike #28); the capture call is a fallback for CREATED/APPROVED.
      if (order.status !== "COMPLETED") order = await env.paypal.captureOrder(order.id, `reins-capture-${req.id}`);
      const cap = firstCapture(order);
      // M3: a PENDING capture (e.g. under review at PayPal) is not a failure: the money may still move, so it stays committed
      if (cap?.status === "PENDING") return { status: "pending", orderId: order.id, captureId: cap.id };
      if (order.status !== "COMPLETED" || !cap || cap.status !== "COMPLETED") {
        return { status: "failed", orderId: order.id, error: `Capture not completed (order ${order.status}, capture ${cap?.status ?? "none"})` };
      }
      return { status: "completed", orderId: order.id, captureId: cap.id };
    }),
};

/** Supervised mode: create an order and hand back the approval link; capture happens on CHECKOUT.ORDER.APPROVED. */
export const supervisedStrategy: PaymentStrategy = {
  mode: "supervised",
  execute: (req, env) =>
    guard(async () => {
      const base = env.publicBaseUrl.replace(/\/$/, "");
      const order = await env.paypal.createOrder(
        {
          intent: "CAPTURE",
          purchase_units: [purchaseUnit(req)],
          payment_source: {
            paypal: {
              experience_context: {
                return_url: `${base}/pay/return?request=${encodeURIComponent(req.id)}`,
                cancel_url: `${base}/pay/cancel?request=${encodeURIComponent(req.id)}`,
                user_action: "PAY_NOW",
                shipping_preference: "NO_SHIPPING",
                brand_name: "Reins",
              },
            },
          },
        },
        `reins-create-${req.id}`,
      );
      const approveUrl = findLink(order, "payer-action", "approve");
      if (!approveUrl) return { status: "failed", orderId: order.id, error: "PayPal returned no approval link" };
      return { status: "awaiting_buyer", orderId: order.id, approveUrl };
    }),
};

/**
 * A payout PayPal sent but the payee has not claimed yet (sandbox: the address has no PayPal account). The request stays
 * committed, not failed: PayPal returns the money after 30 days (PAYMENT.PAYOUTS-ITEM.RETURNED then fails it).
 */
export const PAYOUT_UNCLAIMED_NOTE = "unclaimed: PayPal sent the payout, the payee has not claimed it yet (returned after 30 days if never claimed)";

/** Treasury fallback (M8'): pay the merchant from the prefunded business balance via Payouts. */
export const treasuryStrategy: PaymentStrategy = {
  mode: "treasury",
  execute: (req, env) =>
    guard(async () => {
      if (!env.treasuryPayeeEmail) return { status: "failed", error: "TREASURY_PAYEE_EMAIL is not configured" };
      const batch = await env.paypal.createPayout({
        sender_batch_header: {
          sender_batch_id: `reins-${req.id}`,
          email_subject: `Payment from Reins ${displayId(req.seq)}`,
          recipient_type: "EMAIL",
        },
        items: [
          {
            recipient_type: "EMAIL",
            amount: { value: centsToValue(req.amountCents), currency: req.currency },
            receiver: env.treasuryPayeeEmail,
            note: `${req.merchant}: ${req.items}`.slice(0, 4000),
            sender_item_id: req.id,
          },
        ],
      });
      return { status: "pending", payoutBatchId: batch.batch_header.payout_batch_id };
    }),
};

/**
 * The mode that can really pay: treasury without a payee address (TREASURY_PAYEE_EMAIL) would fail every payment, so it
 * falls back to supervised checkout instead. Callers log the fallback.
 */
export function usablePaymentMode(mode: PaymentMode, treasuryPayeeEmail: string | null | undefined): PaymentMode {
  return mode === "treasury" && !treasuryPayeeEmail?.trim() ? "supervised" : mode;
}

export const STRATEGIES: Record<PaymentMode, PaymentStrategy> = {
  vaulted: vaultedStrategy,
  supervised: supervisedStrategy,
  treasury: treasuryStrategy,
};

/** Capture an approved supervised order (called from the CHECKOUT.ORDER.APPROVED webhook). */
export async function captureApprovedOrder(
  paypal: PayPalClient,
  orderId: string,
  requestId: string,
): Promise<StrategyResult> {
  return guard(async () => {
    const order = await paypal.captureOrder(orderId, `reins-capture-${requestId}`);
    const cap = firstCapture(order);
    if (order.status === "COMPLETED" && cap?.status === "COMPLETED") return { status: "completed", orderId, captureId: cap.id };
    if (cap?.status === "PENDING") return { status: "pending", orderId, captureId: cap.id };
    return { status: "failed", orderId, error: `Capture ${cap?.status ?? "missing"} (order ${order.status})` };
  });
}
