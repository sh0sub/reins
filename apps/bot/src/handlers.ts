import type { LedgerRow } from "@reins/core";
import { parseCallback, resultCard, type Card } from "./cards.ts";

/** Everything the bot needs from Reins. Implemented by apps/web (core service) and by fakes in tests. */
export interface BotDeps {
  linkChat(token: string, chatId: string): Promise<boolean>;
  linkedChatId(): Promise<string | null>;
  decide(requestId: string, action: "approve" | "deny", actor: string): Promise<LedgerRow>;
  /** S2 Ask agent from Telegram. Optional so older wiring keeps working. */
  ask?(requestId: string, question: string, actor: string): Promise<LedgerRow>;
  /** Agent display name for the "What should I ask …?" prompt. */
  describe?(requestId: string): Promise<{ agentName: string; displayId: string } | null>;
}

/** Minimal surface of a callback-query context (grammY adapter or test double). */
export interface CallbackUi {
  answer(text?: string): Promise<void>;
  edit(card: Card): Promise<void>;
  /** Sends a force-reply prompt; returns its message id so the reply can be matched. */
  prompt?(text: string): Promise<number>;
}

/** /start lk_xxxx deep link (flow A-5). */
export async function handleStart(deps: BotDeps, chatId: string, payload: string | undefined): Promise<string> {
  if (!payload) return "Open the link from the Reins dashboard (Setup > Telegram) to connect this chat.";
  if (!/^lk_[0-9a-f]{6,32}$/.test(payload)) return "That link is not valid. Create a new one in the Reins dashboard.";
  const ok = await deps.linkChat(payload, chatId);
  return ok
    ? "Linked to your Reins workspace. Approval requests will appear here."
    : "That link has expired or was already used. Create a new one in the Reins dashboard.";
}

function errorText(err: unknown): string {
  const code = (err as { code?: string }).code;
  if (code === "expired") return "This request expired";
  if (code === "already_decided") return "Already decided in the web inbox";
  if (code === "not_found") return "This request is not in Reins (demo card or deleted)";
  if (code === "question_open") return "Still waiting for the agent's answer";
  return "Could not process, try the web inbox";
}

/**
 * Approve/Deny button: "Paying…" edit first, then the final result (flow B-6). Ask agent opens a force-reply
 * prompt; the reply is handled by handleAskReply. Returns the prompt message id for ask, else undefined.
 */
export async function handleDecisionCallback(deps: BotDeps, chatId: string, data: string, ui: CallbackUi): Promise<{ askPrompt?: { messageId: number; requestId: string } } | void> {
  const parsed = parseCallback(data);
  if (!parsed) return ui.answer("Unknown action");
  const linked = await deps.linkedChatId();
  if (!linked || linked !== chatId) return ui.answer("This chat is not linked to the workspace");

  if (parsed.action === "ask") {
    if (!deps.ask || !ui.prompt) return ui.answer("Ask agent is available in the web inbox");
    const info = (await deps.describe?.(parsed.requestId)) ?? null;
    const messageId = await ui.prompt(`What should I ask ${info?.agentName ?? "the agent"}? (${info?.displayId ?? "request"})\nReply to this message.`);
    await ui.answer("Got it");
    return { askPrompt: { messageId, requestId: parsed.requestId } };
  }

  await ui.answer("Got it"); // answerCallbackQuery right away (S3); duplicate taps are idempotent in core
  if (parsed.action === "approve") await safeEdit(ui, { text: "Approved by you · Paying via PayPal…", buttons: [] });
  let row: LedgerRow;
  try {
    row = await deps.decide(parsed.requestId, parsed.action, "telegram");
  } catch (err) {
    await safeEdit(ui, { text: errorText(err), buttons: [] });
    return;
  }
  // The notifier usually edited this same message to the result already (inside decide). Editing again to the
  // identical text makes Telegram answer 400 "message is not modified"; that is success, not a failure.
  await safeEdit(ui, resultCard(row));
}

/** True for Telegram's 400 "message is not modified" (edit with identical content). */
export function isNotModified(err: unknown): boolean {
  return /message is not modified/i.test(String((err as { description?: string })?.description ?? (err as Error)?.message ?? err));
}

async function safeEdit(ui: CallbackUi, card: Card): Promise<void> {
  try {
    await ui.edit(card);
  } catch (err) {
    if (!isNotModified(err)) throw err;
  }
}

/** Reply to the "What should I ask …?" prompt: forwards the question to the agent (S2). */
export async function handleAskReply(deps: BotDeps, chatId: string, requestId: string, text: string): Promise<string> {
  const linked = await deps.linkedChatId();
  if (!linked || linked !== chatId) return "This chat is not linked to the workspace";
  if (!deps.ask) return "Ask agent is available in the web inbox";
  try {
    const row = await deps.ask(requestId, text, "telegram");
    return `Sent to the agent. The ${row.display_id} card updates when it answers.`;
  } catch (err) {
    return errorText(err);
  }
}
