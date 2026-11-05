import { getWorkspace } from "@reins/db";
import { playgroundEnabled, type ReinsContext } from "@reins/core";

/** Shown for the offline fake PayPal (sandbox merchant lookalike, not a real account). */
export const DEMO_MERCHANT_EMAIL = "sb-merchant-demo@business.example.com";

/** What GET /api/workspace returns; also used to server-render /setup so the first paint is never empty. */
export async function workspaceView(ctx: ReinsContext) {
  const ws = await getWorkspace(ctx.db);
  // vault id and link token never leave the server
  return {
    name: ws.name,
    paypal_env: ws.paypalEnv,
    // offline fake PayPal has no real merchant; show the demo sandbox address so the badge reads like the live one
    merchant_email: ws.merchantEmail ?? (ws.connectedAt && ws.paypalEnv === "fake" ? DEMO_MERCHANT_EMAIL : null),
    payment_mode: ws.paymentMode,
    has_vault: Boolean(ws.vaultId),
    telegram_linked: Boolean(ws.telegramChatId),
    try_enabled: playgroundEnabled(),
    public_demo: process.env.REINS_PUBLIC_DEMO === "1",
    telegram_bot: process.env.TELEGRAM_BOT_USERNAME ?? "ReinsApproveBot",
    connected_at: ws.connectedAt ? new Date(ws.connectedAt).toISOString() : null,
  };
}
