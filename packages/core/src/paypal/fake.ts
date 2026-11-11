import { randomBytes } from "node:crypto";
import {
  firstCapture,
  PayPalApiError,
  type CreateOrderBody,
  type CreatePayoutBody,
  type Order,
  type PayPalClient,
  type PayoutBatch,
  type PayoutBatchDetail,
  type TransactionDetail,
  type TransactionSearchParams,
  type TransactionSearchResponse,
  type WebhookEvent,
  type WebhookHeaders,
} from "./types.ts";

const pid = (n = 17) => randomBytes(16).toString("hex").toUpperCase().slice(0, n);
/** Ids of simulated orders, captures and payouts: the UI shows them as SIM-… so they never pass for sandbox ids. */
const sim = (n = 13) => `SIM-${pid(n)}`;

/**
 * In-memory PayPal used by tests and PAYPAL_ENV=fake. Behaves like the sandbox for the flows Reins uses:
 * - vault_id orders complete immediately with a capture (matches the real sandbox, spike #28)
 * - other orders are CREATED with a payer-action link until `approveOrder()` simulates the buyer
 * - payouts return PENDING; `payoutWebhook()` builds the SUCCEEDED event
 */
export class FakePayPalClient implements PayPalClient {
  readonly orders = new Map<string, Order & { body: CreateOrderBody }>();
  readonly payouts = new Map<string, CreatePayoutBody>();
  readonly calls: string[] = [];
  readonly idempotency = new Map<string, Order>();
  /** Signature check result to return; tests flip this to "FAILURE". */
  verifyResult: "SUCCESS" | "FAILURE" = "SUCCESS";
  /** Set to make the next createOrder throw (simulated outage / decline). */
  failNextCreate: Error | null = null;

  async getAccessToken(): Promise<string> {
    this.calls.push("token");
    return "A21_FAKE_TOKEN";
  }

  async createOrder(body: CreateOrderBody, requestId: string): Promise<Order> {
    this.calls.push("createOrder");
    if (this.failNextCreate) {
      const e = this.failNextCreate;
      this.failNextCreate = null;
      throw e;
    }
    const prior = this.idempotency.get(`create:${requestId}`);
    if (prior) return structuredClone(prior);
    const id = sim();
    const unit = body.purchase_units[0]!;
    const vaultId = body.payment_source?.paypal.vault_id;
    const order: Order & { body: CreateOrderBody } = vaultId
      ? {
          id,
          status: "COMPLETED",
          body,
          purchase_units: [{ ...unit, payments: { captures: [{ id: sim(), status: "COMPLETED", amount: unit.amount }] } }],
          links: [{ rel: "self", href: `https://api-m.sandbox.paypal.com/v2/checkout/orders/${id}` }],
        }
      : {
          id,
          status: body.payment_source ? "PAYER_ACTION_REQUIRED" : "CREATED",
          body,
          purchase_units: [{ ...unit }],
          links: [
            { rel: "self", href: `https://api-m.sandbox.paypal.com/v2/checkout/orders/${id}` },
            { rel: body.payment_source ? "payer-action" : "approve", href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` },
          ],
        };
    this.orders.set(id, order);
    this.idempotency.set(`create:${requestId}`, order);
    return structuredClone(order);
  }

  async getOrder(orderId: string): Promise<Order> {
    this.calls.push("getOrder");
    const o = this.orders.get(orderId);
    if (!o) throw new Error(`Fake order ${orderId} not found`);
    return structuredClone(o);
  }

  /** Simulates the buyer approving the order on paypal.com. */
  approveOrder(orderId: string): void {
    const o = this.orders.get(orderId);
    if (!o) throw new Error(`Fake order ${orderId} not found`);
    o.status = "APPROVED";
  }

  async captureOrder(orderId: string, requestId: string): Promise<Order> {
    this.calls.push("captureOrder");
    const prior = this.idempotency.get(`capture:${requestId}`);
    if (prior) return structuredClone(prior);
    const o = this.orders.get(orderId);
    if (!o) throw new Error(`Fake order ${orderId} not found`);
    if (o.status === "COMPLETED") return structuredClone(o);
    if (o.status !== "APPROVED") throw new Error("ORDER_NOT_APPROVED");
    o.status = "COMPLETED";
    const unit = o.purchase_units![0]!;
    unit.payments = { captures: [{ id: sim(), status: "COMPLETED", amount: unit.amount }] };
    if (o.body.payment_source?.paypal.attributes?.vault) {
      o.payment_source = {
        paypal: { email_address: "buyer@personal.example.com", attributes: { vault: { id: `VAULT-${pid(10)}`, status: "VAULTED" } } },
      };
    }
    this.idempotency.set(`capture:${requestId}`, o);
    return structuredClone(o);
  }

  async createPayout(body: CreatePayoutBody): Promise<PayoutBatch> {
    this.calls.push("createPayout");
    const id = sim();
    this.payouts.set(id, body);
    return { batch_header: { payout_batch_id: id, batch_status: "PENDING", sender_batch_header: body.sender_batch_header } };
  }

  /** Item status getPayout reports per batch id (tests set it); a batch not listed here is still PENDING. */
  readonly payoutItemStatus = new Map<string, string>();

  async getPayout(batchId: string): Promise<PayoutBatchDetail> {
    this.calls.push("getPayout");
    if (!this.payouts.has(batchId)) throw new PayPalApiError(404, undefined, "INVALID_RESOURCE_ID", "Payout batch not found");
    const status = this.payoutItemStatus.get(batchId) ?? "PENDING";
    return {
      batch_header: { payout_batch_id: batchId, batch_status: status === "SUCCESS" ? "SUCCESS" : "PENDING" },
      items: [{ payout_item_id: `${batchId}-1`, transaction_id: status === "SUCCESS" ? `${batchId}-TXN` : undefined, transaction_status: status }],
    };
  }

  /** Extra rows tests inject (e.g. an amount mismatch); merged with captures from completed orders. */
  readonly extraTransactions: TransactionDetail[] = [];
  /** Set to make the next searchTransactions throw (e.g. HTTP 429). */
  failNextSearch: Error | null = null;

  async searchTransactions(p: TransactionSearchParams): Promise<TransactionSearchResponse> {
    this.calls.push("searchTransactions");
    if (this.failNextSearch) {
      const e = this.failNextSearch;
      this.failNextSearch = null;
      throw e;
    }
    const rows: TransactionDetail[] = [];
    for (const o of this.orders.values()) {
      const cap = firstCapture(o);
      if (o.status !== "COMPLETED" || !cap) continue;
      const unit = o.purchase_units?.[0];
      rows.push({ transaction_info: { transaction_id: cap.id, transaction_event_code: "T0006", transaction_status: "S", transaction_amount: unit?.amount, custom_field: unit?.custom_id } });
    }
    rows.push(...this.extraTransactions);
    void p;
    return { transaction_details: rows, total_items: rows.length, total_pages: 1, page: 1 };
  }

  async verifyWebhookSignature(_h: WebhookHeaders, _e: unknown, _id: string): Promise<"SUCCESS" | "FAILURE"> {
    this.calls.push("verifyWebhookSignature");
    return this.verifyResult;
  }

  // ---------- helpers to build webhook deliveries ----------

  static headers(): WebhookHeaders {
    return {
      "paypal-auth-algo": "SHA256withRSA",
      "paypal-cert-url": "https://api-m.sandbox.paypal.com/v1/notifications/certs/CERT-fake",
      "paypal-transmission-id": `tx-${pid(8)}`,
      "paypal-transmission-sig": "fake-signature",
      "paypal-transmission-time": new Date().toISOString(),
    };
  }

  orderApprovedEvent(orderId: string): WebhookEvent {
    return { id: `WH-${pid()}`, event_type: "CHECKOUT.ORDER.APPROVED", resource_type: "checkout-order", resource: { id: orderId, status: "APPROVED" } };
  }

  captureCompletedEvent(orderId: string): WebhookEvent {
    const o = this.orders.get(orderId);
    const cap = o ? firstCapture(o) : undefined;
    return {
      id: `WH-${pid()}`,
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource_type: "capture",
      resource: {
        id: cap?.id ?? pid(),
        status: "COMPLETED",
        supplementary_data: { related_ids: { order_id: orderId } },
      },
    };
  }

  payoutItemEvent(batchId: string, status: "SUCCEEDED" | "FAILED" | "UNCLAIMED" | "RETURNED" = "SUCCEEDED"): WebhookEvent {
    return {
      id: `WH-${pid()}`,
      event_type: `PAYMENT.PAYOUTS-ITEM.${status}`,
      resource_type: "payouts_item",
      resource: { payout_item_id: pid(13), payout_batch_id: batchId, transaction_id: pid(), transaction_status: status === "SUCCEEDED" ? "SUCCESS" : status },
    };
  }
}
