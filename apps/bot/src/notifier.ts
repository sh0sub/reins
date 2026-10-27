import type { Notifier, RequestView } from "@reins/core";
import { approvalCard, resultCard, type Card } from "./cards.ts";

/** The two Bot API calls the notifier needs (grammY `bot.api` adapter or a fake). */
export interface TelegramApi {
  send(chatId: string, card: Card): Promise<{ messageId: number }>;
  edit(chatId: string, messageId: number, card: Card): Promise<void>;
}

export interface NotifierDeps {
  linkedChatId(): Promise<string | null>;
  agentName(agentId: string): Promise<string>;
  ttlMinutes: number;
}

/**
 * Sends an approval card on pending_human and edits the same message when the request resolves (approved in
 * the web inbox, expired, paid). Message ids live in memory; after a restart a new message is sent instead.
 */
export class TelegramNotifier implements Notifier {
  readonly name = "telegram";
  private readonly messages = new Map<string, { chatId: string; messageId: number }>();

  constructor(
    private readonly api: TelegramApi,
    private readonly deps: NotifierDeps,
  ) {}

  async pendingHuman(view: RequestView): Promise<void> {
    const chatId = await this.deps.linkedChatId();
    if (!chatId) return;
    const card = approvalCard(view, await this.deps.agentName(view.agent_id), this.deps.ttlMinutes);
    const { messageId } = await this.api.send(chatId, card);
    this.messages.set(view.request_id, { chatId, messageId });
  }

  async resolved(view: RequestView): Promise<void> {
    const msg = this.messages.get(view.request_id);
    if (msg) {
      await this.api.edit(msg.chatId, msg.messageId, resultCard(view));
      if (!["paying", "approved", "awaiting_buyer"].includes(view.status)) this.messages.delete(view.request_id);
      return;
    }
    // Hard-rule / auditor denials never had a card: send a short warning (flow B-8).
    if (view.status === "denied" && view.decision === "DENY") {
      const chatId = await this.deps.linkedChatId();
      if (chatId) await this.api.send(chatId, { text: `Blocked · ${view.display_id} · $${view.amount} to ${view.merchant}\n${view.reason ?? ""}`.trim(), buttons: [] });
    }
  }
}
