import {
  PAYPAL_BASE_URL,
  PayPalApiError,
  type CreateOrderBody,
  type CreatePayoutBody,
  type Order,
  type PayPalClient,
  type PayPalEnv,
  type PayoutBatch,
  type WebhookHeaders,
} from "./types.ts";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpPayPalClientOptions {
  clientId: string;
  clientSecret: string;
  env?: PayPalEnv;
  fetch?: FetchLike;
  now?: () => number;
}

/** fetch-based PayPal REST client (no SDK). Secrets stay in memory; nothing is logged. */
export class HttpPayPalClient implements PayPalClient {
  private readonly base: string;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private token: { value: string; expiresAt: number } | null = null;
  private tokenPromise: Promise<string> | null = null;

  constructor(private readonly opts: HttpPayPalClientOptions) {
    this.base = PAYPAL_BASE_URL[opts.env ?? "sandbox"];
    this.fetchImpl = opts.fetch ?? ((i, init) => fetch(i, init));
    this.now = opts.now ?? Date.now;
  }

  async getAccessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > this.now()) return this.token.value;
    this.tokenPromise ??= this.fetchToken().finally(() => {
      this.tokenPromise = null;
    });
    return this.tokenPromise;
  }

  private async fetchToken(): Promise<string> {
    const basic = Buffer.from(`${this.opts.clientId}:${this.opts.clientSecret}`).toString("base64");
    const res = await this.fetchImpl(`${this.base}/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) throw await toError(res);
    const json = (await res.json()) as { access_token: string; expires_in: number };
    // refresh 60s before expiry
    this.token = { value: json.access_token, expiresAt: this.now() + Math.max(json.expires_in - 60, 0) * 1000 };
    return json.access_token;
  }

  /** Generic authenticated call (used by spike scripts for endpoints outside PayPalClient). */
  async call<T>(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
    const token = await this.getAccessToken();
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
        ...extraHeaders,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401) this.token = null;
    if (!res.ok) throw await toError(res);
    return (await res.json()) as T;
  }

  createOrder(body: CreateOrderBody, requestId: string): Promise<Order> {
    return this.call("POST", "/v2/checkout/orders", body, { "PayPal-Request-Id": requestId });
  }

  getOrder(orderId: string): Promise<Order> {
    return this.call("GET", `/v2/checkout/orders/${encodeURIComponent(orderId)}`);
  }

  captureOrder(orderId: string, requestId: string): Promise<Order> {
    return this.call("POST", `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {}, { "PayPal-Request-Id": requestId });
  }

  createPayout(body: CreatePayoutBody): Promise<PayoutBatch> {
    return this.call("POST", "/v1/payments/payouts", body);
  }

  async verifyWebhookSignature(headers: WebhookHeaders, event: unknown, webhookId: string): Promise<"SUCCESS" | "FAILURE"> {
    const json = await this.call<{ verification_status: "SUCCESS" | "FAILURE" }>(
      "POST",
      "/v1/notifications/verify-webhook-signature",
      {
        auth_algo: headers["paypal-auth-algo"],
        cert_url: headers["paypal-cert-url"],
        transmission_id: headers["paypal-transmission-id"],
        transmission_sig: headers["paypal-transmission-sig"],
        transmission_time: headers["paypal-transmission-time"],
        webhook_id: webhookId,
        webhook_event: event,
      },
    );
    return json.verification_status === "SUCCESS" ? "SUCCESS" : "FAILURE";
  }
}

async function toError(res: Response): Promise<PayPalApiError> {
  let body: { name?: string; message?: string; debug_id?: string; details?: Array<{ issue?: string }>; error_description?: string } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    /* non-JSON error body */
  }
  const issue = body.details?.[0]?.issue ?? body.name;
  return new PayPalApiError(
    res.status,
    body.debug_id ?? res.headers.get("paypal-debug-id") ?? undefined,
    issue,
    `PayPal ${res.status}${issue ? ` ${issue}` : ""}: ${body.message ?? body.error_description ?? res.statusText}`,
  );
}
