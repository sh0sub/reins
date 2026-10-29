/**
 * Minimal PayPal REST surface Reins uses. Shapes follow developer.paypal.com (Orders v2, Payouts v1,
 * Webhooks v1). Fields marked "(미확인)" must be confirmed against the sandbox in spikes #27/#28/#33/#34.
 */

export type PayPalEnv = "sandbox" | "live";

export const PAYPAL_BASE_URL: Record<PayPalEnv, string> = {
  sandbox: "https://api-m.sandbox.paypal.com",
  live: "https://api-m.paypal.com",
};

export interface Money {
  currency_code: string;
  value: string;
}

export interface Link {
  href: string;
  rel: string;
  method?: string;
}

export interface Capture {
  id: string;
  status: "COMPLETED" | "DECLINED" | "PARTIALLY_REFUNDED" | "PENDING" | "REFUNDED" | "FAILED";
  amount?: Money;
}

export interface Order {
  id: string;
  status: "CREATED" | "SAVED" | "APPROVED" | "VOIDED" | "COMPLETED" | "PAYER_ACTION_REQUIRED";
  links?: Link[];
  purchase_units?: Array<{
    reference_id?: string;
    custom_id?: string;
    amount?: Money;
    payments?: { captures?: Capture[] };
  }>;
  payment_source?: {
    paypal?: {
      email_address?: string;
      /** Present after a store_in_vault order completes. (미확인: exact path in sandbox) */
      attributes?: { vault?: { id?: string; status?: string; customer?: { id?: string } } };
    };
  };
}

export interface CreateOrderBody {
  intent: "CAPTURE" | "AUTHORIZE";
  purchase_units: Array<{
    reference_id?: string;
    custom_id?: string;
    description?: string;
    amount: Money;
    payee?: { email_address?: string; merchant_id?: string };
  }>;
  payment_source?: {
    paypal: {
      vault_id?: string;
      /** (미확인) plan.md asks to measure MERCHANT/UNSCHEDULED/SUBSEQUENT on PayPal wallet vault_id orders. */
      stored_credential?: { payment_initiator: "MERCHANT" | "CUSTOMER"; payment_type?: string; usage?: string };
      experience_context?: {
        return_url?: string;
        cancel_url?: string;
        user_action?: "PAY_NOW" | "CONTINUE";
        shipping_preference?: "NO_SHIPPING" | "GET_FROM_FILE" | "SET_PROVIDED_ADDRESS";
        brand_name?: string;
      };
      attributes?: {
        vault?: { store_in_vault: "ON_SUCCESS"; usage_type: "MERCHANT" | "PLATFORM"; customer_type?: "CONSUMER" | "BUSINESS" };
      };
    };
  };
}

export interface CreatePayoutBody {
  sender_batch_header: { sender_batch_id: string; email_subject?: string; email_message?: string; recipient_type?: "EMAIL" };
  items: Array<{
    recipient_type: "EMAIL";
    amount: { value: string; currency: string };
    receiver: string;
    note?: string;
    sender_item_id?: string;
  }>;
}

export interface PayoutBatch {
  batch_header: { payout_batch_id: string; batch_status: string; sender_batch_header?: { sender_batch_id: string } };
  links?: Link[];
}

/** Headers PayPal sends with each webhook delivery (lower-cased). */
export interface WebhookHeaders {
  "paypal-auth-algo": string;
  "paypal-cert-url": string;
  "paypal-transmission-id": string;
  "paypal-transmission-sig": string;
  "paypal-transmission-time": string;
}

export interface WebhookEvent {
  id: string;
  event_type: string;
  resource_type?: string;
  resource: Record<string, unknown> & { id?: string };
  create_time?: string;
  summary?: string;
}

/** GET /v1/reporting/transactions (Transaction Search). Max 31-day window; data lags up to ~3 hours. */
export interface TransactionSearchParams {
  startDate: string;
  endDate: string;
  page?: number;
  pageSize?: number;
}
export interface TransactionDetail {
  transaction_info: {
    transaction_id: string;
    paypal_reference_id?: string;
    transaction_event_code?: string;
    /** S = success, P = pending, D = denied, V = reversed */
    transaction_status?: string;
    transaction_amount?: Money;
    custom_field?: string;
    transaction_initiation_date?: string;
  };
}
export interface TransactionSearchResponse {
  transaction_details: TransactionDetail[];
  total_items?: number;
  total_pages?: number;
  page?: number;
}

export interface PayPalClient {
  /** OAuth2 client_credentials token (cached until shortly before expiry). Used by M1 Verify. */
  getAccessToken(): Promise<string>;
  createOrder(body: CreateOrderBody, requestId: string): Promise<Order>;
  getOrder(orderId: string): Promise<Order>;
  captureOrder(orderId: string, requestId: string): Promise<Order>;
  createPayout(body: CreatePayoutBody): Promise<PayoutBatch>;
  /** POST /v1/notifications/verify-webhook-signature -> verification_status */
  verifyWebhookSignature(headers: WebhookHeaders, event: unknown, webhookId: string): Promise<"SUCCESS" | "FAILURE">;
  /** GET /v1/reporting/transactions (M11 nightly reconciliation). */
  searchTransactions(params: TransactionSearchParams): Promise<TransactionSearchResponse>;
}

export class PayPalApiError extends Error {
  constructor(
    readonly status: number,
    readonly debugId: string | undefined,
    readonly issue: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "PayPalApiError";
  }
}

export function findLink(order: { links?: Link[] }, ...rels: string[]): string | undefined {
  for (const rel of rels) {
    const l = order.links?.find((x) => x.rel === rel);
    if (l) return l.href;
  }
  return undefined;
}

export function firstCapture(order: Order): Capture | undefined {
  return order.purchase_units?.[0]?.payments?.captures?.[0];
}
