import type { LedgerRow } from "@reins/core";
import { parseCallback, resultCard, type Card } from "./cards.ts";

/** Everything the bot needs from Reins. Implemented by apps/web (core service) and by fakes in tests. */
export interface BotDeps {
  linkChat(token: string, chatId: string): Promise<boolean>;
  linkedChatId(): Promise<string | null>;
  decide(requestId: string, action: "approve" | "deny", actor: string): Promise<LedgerRow>;
}

/** Minimal surface of a callback-query context (grammY adapter or test double). */
export interface CallbackUi {
  answer(text?: string): Promise<void>;
  edit(card: Card): Promise<void>;
}

/** /start lk_xxxx deep link (flow A-5). */
export async function handleStart(deps: BotDeps, chatId: string, payload: string | undefined): Promise<string> {
  if (!payload) return "Open the link from the Reins dashboard (Settings > Telegram) to connect this chat.";
  if (!/^lk_[0-9a-f]{6,32}$/.test(payload)) return "That link is not valid. Create a new one in the Reins dashboard.";
  const ok = await deps.linkChat(payload, chatId);
  return ok
    ? "Linked to your Reins workspace. Approval requests will appear here."
    : "That link has expired or was already used. Create a new one in the Reins dashboard.";
}

/** Approve/Deny button: "Paying…" edit first, then the final result (flow B-6). */
export async function handleDecisionCallback(deps: BotDeps, chatId: string, data: string, ui: CallbackUi): Promise<void> {
  const parsed = parseCallback(data);
  if (!parsed) return ui.answer("Unknown action");
  const linked = await deps.linkedChatId();
  if (!linked || linked !== chatId) return ui.answer("This chat is not linked to the workspace");

  if (parsed.action === "approve") await ui.edit({ text: "Paying…", buttons: [] });
  try {
    const row = await deps.decide(parsed.requestId, parsed.action, "telegram");
    await ui.edit(resultCard(row));
    await ui.answer(parsed.action === "approve" ? "Approved" : "Denied");
  } catch (err) {
    const code = (err as { code?: string }).code;
    const msg =
      code === "expired" ? "This request expired" : code === "already_decided" ? "Already decided in the web inbox" : "Could not process, try the web inbox";
    await ui.edit({ text: msg, buttons: [] });
    await ui.answer(msg);
  }
}
