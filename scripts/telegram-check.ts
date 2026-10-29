/**
 * #9 M9 real-bot check. Run: pnpm spike scripts/telegram-check.ts
 * 1. getMe  2. getWebhookInfo  3. getUpdates (looks for the user's /start; does not confirm/consume updates)
 * 4. saves the chat id to .local/telegram-chat-id.txt (never printed)  5. sends one demo approval card.
 * Pass --no-send to skip step 5. The chat id, token and message contents are never logged.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { setDefaultAutoSelectFamily } from "node:net";
import { resolve } from "node:path";
import { Bot } from "grammy";
import { approvalCard, keyboard } from "@reins/bot";
import type { RequestView } from "@reins/core";
import { ROOT, requireEnv } from "./spikes/lib.ts";

// This Mac has a broken IPv6 route to api.telegram.org: Node's happy-eyeballs times out (ETIMEDOUT) while
// curl -4 works. Plain sequential connect (IPv4 first from DNS) fixes it. Same as NODE_OPTIONS=--no-network-family-autoselection.
setDefaultAutoSelectFamily(false);

const CHAT_FILE = resolve(ROOT, ".local/telegram-chat-id.txt");

async function main() {
  const { TELEGRAM_BOT_TOKEN } = requireEnv("TELEGRAM_BOT_TOKEN");
  const bot = new Bot(TELEGRAM_BOT_TOKEN);

  const me = await bot.api.getMe();
  console.log(`getMe: OK @${me.username} (can_join_groups=${me.can_join_groups})`);

  const wh = await bot.api.getWebhookInfo();
  console.log(`getWebhookInfo: webhook ${wh.url ? "SET (getUpdates is blocked while a webhook is set)" : "not set"}, pending_update_count=${wh.pending_update_count}`);

  let chatId: number | undefined;
  if (!wh.url) {
    const updates = await bot.api.getUpdates({ timeout: 0, allowed_updates: ["message"] });
    const starts = updates.filter((u) => u.message?.text?.startsWith("/start") && u.message.chat.type === "private");
    console.log(`getUpdates: ${updates.length} update(s), ${starts.length} /start message(s)`);
    chatId = starts.at(-1)?.message?.chat.id;
  }
  if (chatId === undefined && existsSync(CHAT_FILE)) {
    chatId = Number(readFileSync(CHAT_FILE, "utf8").trim()) || undefined;
    if (chatId !== undefined) console.log("chat id: reusing .local/telegram-chat-id.txt");
  }
  if (chatId === undefined) {
    console.log(`BLOCKED: no /start found. Open https://t.me/${me.username} and press Start, then rerun.`);
    process.exitCode = 3;
    return;
  }
  mkdirSync(resolve(ROOT, ".local"), { recursive: true });
  writeFileSync(CHAT_FILE, `${chatId}\n`);
  chmodSync(CHAT_FILE, 0o600);
  console.log("chat id: saved to .local/telegram-chat-id.txt (not printed)");

  if (process.argv.includes("--no-send")) return;
  const demo = {
    request_id: "req_demo_check",
    display_id: "R-DEMO",
    agent_id: "agt_demo",
    status: "pending_human",
    decision: "ASK_HUMAN",
    risk: 2,
    reason: "Consistent with the market research mandate; above the $25 auto-approve limit.",
    reason_ko: null,
    merchant: "statista.com",
    amount: "59.00",
    currency: "USD",
    items: 'Report "Agentic Commerce 2026" (PDF)',
    agent_reason: "Market sizing for the Q4 memo (task #31)",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    receipt: null,
    needs_clarification: false,
    clarification: null,
  } satisfies RequestView;
  const card = approvalCard(demo, "Research Scout", { ttlMinutes: 30, budget: { monthSpentCents: 1900, monthlyLimitCents: 6000 } });
  card.text = `[Reins connectivity check — buttons are inactive]\n${card.text}`;
  const msg = await bot.api.sendMessage(chatId, card.text, { reply_markup: keyboard(card) });
  console.log(`sendMessage: OK message_id=${msg.message_id}, ${card.buttons.flat().length} buttons`);
}

main().catch((err) => {
  console.error(`telegram-check failed: ${err instanceof Error ? err.message.replace(/bot\d+:[\w-]+/g, "bot<redacted>") : "error"}`);
  process.exitCode = 1;
});
