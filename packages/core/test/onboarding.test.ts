import { describe, expect, it } from "vitest";
import { getWorkspace } from "@reins/db";
import { createTestContext } from "../src/testing.ts";
import { completeVaultSetup, connectPayPal, issueTelegramLinkToken, linkTelegramChat, setPaymentMode, startVaultSetup } from "../src/onboarding.ts";
import { FakePayPalClient } from "../src/paypal/fake.ts";

describe("M1 connect PayPal (token verify, no secret persisted)", () => {
  it("stores connection state when the token call succeeds", async () => {
    const ctx = await createTestContext();
    const ws = await connectPayPal(ctx, new FakePayPalClient(), { env: "sandbox", merchantEmail: "sb-merchant-47xk@business.example.com" });
    expect(ws.connectedAt).toBeTruthy();
    expect(ws.merchantEmail).toContain("sb-merchant");
    expect(JSON.stringify(ws).toLowerCase()).not.toContain("secret");
  });
  it("returns 400 when PayPal rejects the credentials", async () => {
    const ctx = await createTestContext();
    const bad = new FakePayPalClient();
    bad.getAccessToken = async () => {
      throw new Error("PayPal 401 invalid_client");
    };
    await expect(connectPayPal(ctx, bad, { env: "sandbox" })).rejects.toMatchObject({ status: 400, code: "paypal_auth_failed" });
  });
});

describe("M8 onboarding: save PayPal for automatic payments", () => {
  it("creates a $0.01 store_in_vault order, then stores the vault id and switches to vaulted", async () => {
    const ctx = await createTestContext();
    await expect(setPaymentMode(ctx, "vaulted")).rejects.toMatchObject({ code: "no_vault" });
    const { orderId, approveUrl } = await startVaultSetup(ctx);
    expect(approveUrl).toContain("paypal.com");
    const body = ctx.paypal.orders.get(orderId)!.body;
    expect(body.purchase_units[0]!.amount.value).toBe("0.01");
    expect(body.payment_source?.paypal.attributes?.vault).toEqual({ store_in_vault: "ON_SUCCESS", usage_type: "MERCHANT", customer_type: "CONSUMER" });
    ctx.paypal.approveOrder(orderId);
    const ws = await completeVaultSetup(ctx, orderId);
    expect(ws.vaultId).toMatch(/^VAULT-/);
    expect(ws.paymentMode).toBe("vaulted");
  });
  it("fails clearly when no vault id comes back (Treasury fallback path)", async () => {
    const ctx = await createTestContext();
    const order = await ctx.paypal.createOrder({ intent: "CAPTURE", purchase_units: [{ amount: { currency_code: "USD", value: "0.01" } }] }, "r");
    ctx.paypal.approveOrder(order.id);
    await expect(completeVaultSetup(ctx, order.id)).rejects.toMatchObject({ code: "vault_failed" });
    expect((await setPaymentMode(ctx, "treasury")).paymentMode).toBe("treasury");
  });
});

describe("M9 Telegram deep-link token", () => {
  it("links a chat once with the issued token", async () => {
    const ctx = await createTestContext();
    const token = await issueTelegramLinkToken(ctx);
    expect(token).toMatch(/^lk_[0-9a-f]{12}$/);
    expect(await linkTelegramChat(ctx, "lk_wrong", "1")).toBe(false);
    expect(await linkTelegramChat(ctx, token, "12345")).toBe(true);
    expect(await linkTelegramChat(ctx, token, "999")).toBe(false);
    expect((await getWorkspace(ctx.db)).telegramChatId).toBe("12345");
  });
});
