import type { Notifier, RequestView } from "@reins/core";
import { approvalCard, blockedCard, resultCard, type Card } from "./cards.ts";

/** The two Bot API calls the notifier needs (grammY `bot.api` adapter or a fake). */
export interface TelegramApi {
  send(chatId: string, card: Card): Promise<{ messageId: number }>;
  edit(chatId: string, messageId: number, card: Card): Promise<void>;
}

export interface NotifierDeps {
  linkedChatId(): Promise<string | null>;
  agentName(agentId: string): Promise<string>;
  ttlMinutes: number;
  /** Month-to-date spend for the budget line (optional). */
  budget?(agentId: string): Promise<{ monthSpentCents: number; monthlyLimitCents: number | null } | null>;
  /** Public https base URL for "Open in Reins" / "Review in Reins" buttons. */
  webBaseUrl?: string;
}

/**
 * Sends an approval card on pending_human and edits the same message when the request resolves (approved in
 * the web inbox, expired, paid) or when a question is asked/answered. Message ids live in memory; after a
 * restart a new message is sent instead.
 */
export class TelegramNotifier implements Notifier {
  readonly name = "telegram";
  private readonly messages = new Map<string, { chatId: string; messageId: number }>();

  constructor(
    private readonly api: TelegramApi,
    private readonly deps: NotifierDeps,
  ) {}

  private async card(view: RequestView): Promise<Card> {
    // budget is measured before this purchase is committed, so the card can say "left … after this"
    return approvalCard(view, await this.deps.agentName(view.agent_id), {
      ttlMinutes: this.deps.ttlMinutes,
      budget: (await this.deps.budget?.(view.agent_id)) ?? null,
      webBaseUrl: this.deps.webBaseUrl,
    });
  }

  async pendingHuman(view: RequestView): Promise<void> {
    const chatId = await this.deps.linkedChatId();
    if (!chatId) return;
    const { messageId } = await this.api.send(chatId, await this.card(view));
    this.messages.set(view.request_id, { chatId, messageId });
  }

  /** Question asked or answered: re-render the pending card in place. */
  async updated(view: RequestView): Promise<void> {
    const msg = this.messages.get(view.request_id);
    if (!msg || view.status !== "pending_human") return;
    await this.api.edit(msg.chatId, msg.messageId, await this.card(view));
  }

  async resolved(view: RequestView): Promise<void> {
    const msg = this.messages.get(view.request_id);
    if (msg) {
      await this.api.edit(msg.chatId, msg.messageId, resultCard(view));
      if (!["paying", "approved", "awaiting_buyer"].includes(view.status)) this.messages.delete(view.request_id);
      return;
    }
    // Hard-rule / auditor denials never had a card: send a warning without approve buttons (flow B-8).
    if (view.status === "denied" && view.decision === "DENY") {
      const chatId = await this.deps.linkedChatId();
      if (chatId) await this.api.send(chatId, blockedCard(view, await this.deps.agentName(view.agent_id), this.deps.webBaseUrl));
    }
  }
}
