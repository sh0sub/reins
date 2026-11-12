/** Thin client for the Reins web REST API, authenticated with the agent's own key. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class ReinsApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ReinsApiError";
  }
}

export interface PurchaseArgs {
  merchant: string;
  amount: string;
  currency?: string;
  items: string;
  reason: string;
  category?: string;
  /** Subscription cadence; omit for a one-off purchase. */
  recurring?: "monthly" | "yearly";
  client_request_id?: string;
}

export class ReinsApi {
  private readonly base: string;
  private readonly fetchImpl: FetchLike;

  /**
   * `renewKey` (keyless demo sessions only): called once when the API answers 401 invalid/expired key, e.g. after the
   * free web instance restarted and forgot its in-memory demo keys. It returns a fresh key, and the call is retried.
   */
  constructor(
    baseUrl: string,
    private apiKey: string,
    fetchImpl?: FetchLike,
    private readonly renewKey?: () => Promise<string>,
  ) {
    this.base = baseUrl.replace(/\/$/, "");
    this.fetchImpl = fetchImpl ?? ((i, init) => fetch(i, init));
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    try {
      return await this.send<T>(method, path, body);
    } catch (err) {
      if (!this.renewKey || !(err instanceof ReinsApiError) || err.status !== 401 || !["invalid_key", "expired_key"].includes(err.code)) throw err;
      this.apiKey = await this.renewKey();
      return this.send<T>(method, path, body);
    }
  }

  private async send<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json", accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!res.ok) throw new ReinsApiError(res.status, String(json.error ?? "error"), String(json.message ?? res.statusText));
    return json as T;
  }

  getMandate() {
    return this.call<Record<string, unknown>>("GET", "/api/mandate");
  }
  requestPurchase(args: PurchaseArgs) {
    return this.call<Record<string, unknown>>("POST", "/api/requests", args);
  }
  getRequestStatus(requestId: string) {
    return this.call<Record<string, unknown>>("GET", `/api/requests/${encodeURIComponent(requestId)}`);
  }
  answerClarification(requestId: string, answer: string) {
    return this.call<Record<string, unknown>>("POST", `/api/requests/${encodeURIComponent(requestId)}/answer`, { answer });
  }
  listTransactions(limit = 20) {
    return this.call<{ transactions: unknown[] }>("GET", `/api/transactions?limit=${limit}`);
  }
}
