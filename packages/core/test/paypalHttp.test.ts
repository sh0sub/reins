import { describe, expect, it } from "vitest";
import { HttpPayPalClient } from "../src/paypal/http.ts";
import { PayPalApiError } from "../src/paypal/types.ts";

type Call = { url: string; init: RequestInit };
function fakeFetch(routes: Record<string, (c: Call) => Response>) {
  const calls: Call[] = [];
  const fn = async (url: string, init: RequestInit = {}) => {
    const c = { url, init };
    calls.push(c);
    const key = `${init.method ?? "GET"} ${new URL(url).pathname}`;
    const h = routes[key];
    if (!h) return new Response(JSON.stringify({ name: "NOT_FOUND" }), { status: 404 });
    return h(c);
  };
  return { fn, calls };
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const token = () => json({ access_token: "tok-1", expires_in: 32400, token_type: "Bearer" });

describe("M1 PayPal client (fetch stubbed)", () => {
  it("gets an OAuth token with Basic auth against the sandbox and caches it", async () => {
    const f = fakeFetch({ "POST /v1/oauth2/token": token, "GET /v2/checkout/orders/O1": () => json({ id: "O1", status: "CREATED" }) });
    const c = new HttpPayPalClient({ clientId: "id", clientSecret: "sec", fetch: f.fn });
    expect(await c.getAccessToken()).toBe("tok-1");
    await c.getOrder("O1");
    await c.getOrder("O1");
    const tokenCalls = f.calls.filter((x) => x.url.endsWith("/v1/oauth2/token"));
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0]!.url.startsWith("https://api-m.sandbox.paypal.com")).toBe(true);
    expect((tokenCalls[0]!.init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from("id:sec").toString("base64")}`);
    expect(tokenCalls[0]!.init.body).toBe("grant_type=client_credentials");
  });
  it("refreshes the token after expiry", async () => {
    let now = 0;
    const f = fakeFetch({ "POST /v1/oauth2/token": () => json({ access_token: "t", expires_in: 120 }) });
    const c = new HttpPayPalClient({ clientId: "id", clientSecret: "sec", fetch: f.fn, now: () => now });
    await c.getAccessToken();
    now = 61_000;
    await c.getAccessToken();
    expect(f.calls).toHaveLength(2);
  });
  it("surfaces PayPal errors with issue and debug id", async () => {
    const f = fakeFetch({ "POST /v1/oauth2/token": () => json({ error: "invalid_client", error_description: "Client Authentication failed" }, 401) });
    const c = new HttpPayPalClient({ clientId: "id", clientSecret: "bad", fetch: f.fn });
    await expect(c.getAccessToken()).rejects.toBeInstanceOf(PayPalApiError);
  });
  it("sends PayPal-Request-Id on create/capture and the verify-webhook-signature body", async () => {
    const f = fakeFetch({
      "POST /v1/oauth2/token": token,
      "POST /v2/checkout/orders": () => json({ id: "O2", status: "PAYER_ACTION_REQUIRED" }, 201),
      "POST /v2/checkout/orders/O2/capture": () => json({ id: "O2", status: "COMPLETED" }, 201),
      "POST /v1/notifications/verify-webhook-signature": () => json({ verification_status: "SUCCESS" }),
    });
    const c = new HttpPayPalClient({ clientId: "id", clientSecret: "sec", fetch: f.fn });
    await c.createOrder({ intent: "CAPTURE", purchase_units: [{ amount: { currency_code: "USD", value: "1.00" } }] }, "req-1");
    await c.captureOrder("O2", "cap-1");
    const headers = {
      "paypal-auth-algo": "SHA256withRSA", "paypal-cert-url": "https://cert", "paypal-transmission-id": "tid",
      "paypal-transmission-sig": "sig", "paypal-transmission-time": "2026-11-02T00:00:00Z",
    };
    expect(await c.verifyWebhookSignature(headers, { id: "WH-1" }, "WEBHOOK-ID")).toBe("SUCCESS");
    const create = f.calls.find((x) => x.url.endsWith("/v2/checkout/orders"))!;
    expect((create.init.headers as Record<string, string>)["PayPal-Request-Id"]).toBe("req-1");
    const verify = f.calls.find((x) => x.url.endsWith("verify-webhook-signature"))!;
    expect(JSON.parse(String(verify.init.body))).toEqual({
      auth_algo: "SHA256withRSA", cert_url: "https://cert", transmission_id: "tid", transmission_sig: "sig",
      transmission_time: "2026-11-02T00:00:00Z", webhook_id: "WEBHOOK-ID", webhook_event: { id: "WH-1" },
    });
  });
});
