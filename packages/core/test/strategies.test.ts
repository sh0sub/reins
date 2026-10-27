import { describe, expect, it } from "vitest";
import { FakePayPalClient } from "../src/paypal/fake.ts";
import { captureApprovedOrder, supervisedStrategy, treasuryStrategy, vaultedStrategy } from "../src/pay/strategies.ts";

const req = { id: "req_1", seq: 142, merchant: "statista.com", amountCents: 5900, currency: "USD", items: "Market report" };

describe("M8 vaulted (automatic) strategy", () => {
  it("orders with vault_id and returns the capture", async () => {
    const pp = new FakePayPalClient();
    const r = await vaultedStrategy.execute(req, { paypal: pp, publicBaseUrl: "http://x", vaultId: "VAULT-1" });
    expect(r.status).toBe("completed");
    expect(r.captureId).toBeTruthy();
    const body = pp.orders.get(r.orderId!)!.body;
    expect(body.payment_source?.paypal.vault_id).toBe("VAULT-1");
    expect(body.purchase_units[0]).toMatchObject({ custom_id: "req_1", amount: { currency_code: "USD", value: "59.00" } });
    expect(body.purchase_units[0]!.description).toContain("R-0142");
    expect(body.payment_source?.paypal.stored_credential).toBeUndefined();
  });
  it("adds stored_credential MERCHANT/UNSCHEDULED/SUBSEQUENT when enabled", async () => {
    const pp = new FakePayPalClient();
    const r = await vaultedStrategy.execute(req, { paypal: pp, publicBaseUrl: "http://x", vaultId: "V", vaultStoredCredential: true });
    expect(pp.orders.get(r.orderId!)!.body.payment_source?.paypal.stored_credential).toEqual({ payment_initiator: "MERCHANT", payment_type: "UNSCHEDULED", usage: "SUBSEQUENT" });
  });
  it("fails cleanly without a vault id or when PayPal errors", async () => {
    const pp = new FakePayPalClient();
    expect((await vaultedStrategy.execute(req, { paypal: pp, publicBaseUrl: "x" })).status).toBe("failed");
    pp.failNextCreate = new Error("PayPal 422 PAYEE_ACCOUNT_RESTRICTED");
    const r = await vaultedStrategy.execute(req, { paypal: pp, publicBaseUrl: "x", vaultId: "V" });
    expect(r).toMatchObject({ status: "failed", error: "PayPal 422 PAYEE_ACCOUNT_RESTRICTED" });
  });
});

describe("M7 supervised strategy", () => {
  it("creates a CAPTURE order with return/cancel urls and returns the approval link", async () => {
    const pp = new FakePayPalClient();
    const r = await supervisedStrategy.execute(req, { paypal: pp, publicBaseUrl: "https://reins.example/" });
    expect(r.status).toBe("awaiting_buyer");
    expect(r.approveUrl).toContain("sandbox.paypal.com");
    const body = pp.orders.get(r.orderId!)!.body;
    expect(body.intent).toBe("CAPTURE");
    expect(body.payment_source?.paypal.experience_context?.return_url).toBe("https://reins.example/pay/return?request=req_1");
  });
  it("captures after buyer approval; refuses before", async () => {
    const pp = new FakePayPalClient();
    const r = await supervisedStrategy.execute(req, { paypal: pp, publicBaseUrl: "x" });
    expect((await captureApprovedOrder(pp, r.orderId!, req.id)).status).toBe("failed");
    pp.approveOrder(r.orderId!);
    const cap = await captureApprovedOrder(pp, r.orderId!, req.id);
    expect(cap.status).toBe("completed");
    expect(cap.captureId).toBeTruthy();
  });
});

describe("M8' treasury strategy", () => {
  it("creates a payout to the configured payee and stays pending", async () => {
    const pp = new FakePayPalClient();
    const r = await treasuryStrategy.execute(req, { paypal: pp, publicBaseUrl: "x", treasuryPayeeEmail: "m@biz.example.com" });
    expect(r.status).toBe("pending");
    const body = pp.payouts.get(r.payoutBatchId!)!;
    expect(body.sender_batch_header.sender_batch_id).toBe("reins-req_1");
    expect(body.items[0]).toMatchObject({ receiver: "m@biz.example.com", amount: { value: "59.00", currency: "USD" }, sender_item_id: "req_1" });
  });
});
