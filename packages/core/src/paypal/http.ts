import {
  PAYPAL_BASE_URL,
  PayPalApiError,
  PayPalUnknownError,
  type CreateOrderBody,
  type CreatePayoutBody,
  type Order,
  type PayPalClient,
  type PayPalEnv,
  type PayoutBatch,
  type TransactionSearchParams,
  type TransactionSearchResponse,
  type WebhookHeaders,
} from "./types.ts";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpPayPalClientOptions {
  clientId: string;
  clientSecret: string;
  env?: PayPalEnv;
  fetch?: FetchLike;
  now?: () => number;
  /** H4 per-attempt timeout (default 15 s). */
  timeoutMs?: number;
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

  /**
   * H4: every PayPal call gets AbortSignal.timeout (15 s). A network error, timeout or 5xx is retried once with the same
   * request (same PayPal-Request-Id, so PayPal replays instead of paying twice); if that also fails the outcome is
   * unknown and PayPalUnknownError is thrown. 4xx answers are definite and returned as they are.
   */
  private async send(url: string, init: RequestInit): Promise<Response> {
    let last = "";
    let lastStatus: number | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000) });
        if (res.status < 400 || (attempt === 0 && res.status < 500)) return res;
        if (attempt === 1 && res.status < 500) {
          // the first attempt may have gone through (duplicate PayPal-Request-Id / sender_batch_id in flight): not definite
          const err = await toError(res);
          throw new PayPalUnknownError(`${err.message} (on retry after an unanswered attempt)`, res.status);
        }
        lastStatus = res.status;
        last = `PayPal ${res.status}`;
        if (attempt === 1) {
          const err = await toError(res);
          throw new PayPalUnknownError(`${err.message} (after one retry)`, res.status);
        }
      } catch (err) {
        if (err instanceof PayPalUnknownError) throw err;
        last = err instanceof Error ? (err.name === "TimeoutError" || err.name === "AbortError" ? "PayPal timeout" : `network error: ${err.message}`) : "network error";
        lastStatus = undefined;
      }
    }
    throw new PayPalUnknownError(`${last} (after one retry)`, lastStatus);
  }

  private async fetchToken(): Promise<string> {
    const basic = Buffer.from(`${this.opts.clientId}:${this.opts.clientSecret}`).toString("base64");
    const res = await this.send(`${this.base}/v1/oauth2/token`, {
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
    const res = await this.send(`${this.base}${path}`, {
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

  searchTransactions(p: TransactionSearchParams): Promise<TransactionSearchResponse> {
    const q = new URLSearchParams({
      start_date: p.startDate,
      end_date: p.endDate,
      fields: "transaction_info",
      page_size: String(p.pageSize ?? 500),
      page: String(p.page ?? 1),
    });
    return this.call("GET", `/v1/reporting/transactions?${q.toString()}`);
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
