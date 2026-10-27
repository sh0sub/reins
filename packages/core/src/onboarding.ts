import { getWorkspace, updateWorkspace, type Workspace } from "@reins/db";
import { randomBytes } from "node:crypto";
import { findLink, type PayPalClient } from "./paypal/types.ts";
import type { PaymentMode } from "./pay/strategies.ts";
import { ReinsError, type ReinsContext } from "./service.ts";

/**
 * M1: verify sandbox credentials with POST /v1/oauth2/token. The secret itself is never written to the DB
 * (plan.md security note: secrets live in environment variables); only the connection state is stored.
 */
export async function connectPayPal(
  ctx: ReinsContext,
  client: PayPalClient,
  opts: { env: "sandbox" | "fake"; merchantEmail?: string | null },
): Promise<Workspace> {
  try {
    await client.getAccessToken();
  } catch (err) {
    throw new ReinsError(400, "paypal_auth_failed", `PayPal rejected the credentials: ${err instanceof Error ? err.message : "unknown error"}`);
  }
  return updateWorkspace(ctx.db, {
    paypalEnv: opts.env,
    merchantEmail: opts.merchantEmail ?? null,
    connectedAt: ctx.now(),
  });
}

export async function setPaymentMode(ctx: ReinsContext, mode: PaymentMode): Promise<Workspace> {
  const ws = await getWorkspace(ctx.db);
  if (mode === "vaulted" && !ws.vaultId) throw new ReinsError(409, "no_vault", "Save a PayPal for automatic payments first");
  return updateWorkspace(ctx.db, { paymentMode: mode });
}

/** M8 onboarding step 3: $0.01 order with store_in_vault=ON_SUCCESS. Returns the buyer approval link. */
export async function startVaultSetup(ctx: ReinsContext): Promise<{ orderId: string; approveUrl: string }> {
  const base = ctx.config.publicBaseUrl.replace(/\/$/, "");
  const order = await ctx.paypal.createOrder(
    {
      intent: "CAPTURE",
      purchase_units: [{ reference_id: "reins-vault-setup", description: "Reins: save PayPal for automatic payments", amount: { currency_code: "USD", value: "0.01" } }],
      payment_source: {
        paypal: {
          experience_context: {
            return_url: `${base}/onboarding/vault/return`,
            cancel_url: `${base}/onboarding/vault/cancel`,
            user_action: "PAY_NOW",
            shipping_preference: "NO_SHIPPING",
            brand_name: "Reins",
          },
          attributes: { vault: { store_in_vault: "ON_SUCCESS", usage_type: "MERCHANT", customer_type: "CONSUMER" } },
        },
      },
    },
    `reins-vault-setup-${randomBytes(6).toString("hex")}`,
  );
  const approveUrl = findLink(order, "payer-action", "approve");
  if (!approveUrl) throw new ReinsError(502, "paypal_no_link", "PayPal returned no approval link");
  return { orderId: order.id, approveUrl };
}

/** After the buyer approves: capture and store the vault id. (미확인: vault id path, spike #27) */
export async function completeVaultSetup(ctx: ReinsContext, orderId: string): Promise<Workspace> {
  const order = await ctx.paypal.captureOrder(orderId, `reins-vault-capture-${orderId}`);
  const vaultId = order.payment_source?.paypal?.attributes?.vault?.id;
  if (order.status !== "COMPLETED" || !vaultId) {
    throw new ReinsError(502, "vault_failed", `Vault not created (order ${order.status}). Use supervised or treasury mode.`);
  }
  return updateWorkspace(ctx.db, { vaultId, paymentMode: "vaulted" });
}

/** M9 deep link token for t.me/<bot>?start=lk_<token> */
export async function issueTelegramLinkToken(ctx: ReinsContext): Promise<string> {
  const token = `lk_${randomBytes(6).toString("hex")}`;
  await updateWorkspace(ctx.db, { telegramLinkToken: token });
  return token;
}

export async function linkTelegramChat(ctx: ReinsContext, token: string, chatId: string): Promise<boolean> {
  const ws = await getWorkspace(ctx.db);
  if (!ws.telegramLinkToken || ws.telegramLinkToken !== token) return false;
  await updateWorkspace(ctx.db, { telegramChatId: chatId, telegramLinkToken: null });
  return true;
}
