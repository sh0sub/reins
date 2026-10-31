import { describe, expect, it } from "vitest";
import { createAgent, authenticateAgent, decideRequest, getLedgerRow, issueTelegramLinkToken, linkTelegramChat, saveMandate, submitPurchase, type ReinsContext } from "@reins/core";
import { createTestContext } from "@reins/core/testing";
import { updateWorkspace, getAgent, getWorkspace } from "@reins/db";
import { approvalCard, callbackData, parseCallback, publicFailure, resultCard, type Card } from "../src/cards.ts";
import { handleDecisionCallback, handleStart, type BotDeps } from "../src/handlers.ts";
import { TelegramNotifier, type TelegramApi } from "../src/notifier.ts";

function depsFor(ctx: ReinsContext): BotDeps {
  return {
    linkChat: (t, c) => linkTelegramChat(ctx, t, c),
    linkedChatId: async () => (await getWorkspace(ctx.db)).telegramChatId,
    decide: async (id, action, actor) => {
      await decideRequest(ctx, id, action, actor);
      return getLedgerRow(ctx, id);
    },
  };
}

class FakeApi implements TelegramApi {
  sent: Array<{ chatId: string; card: Card; messageId: number }> = [];
  edits: Array<{ chatId: string; messageId: number; card: Card }> = [];
  async send(chatId: string, card: Card) {
    const messageId = this.sent.length + 100;
    this.sent.push({ chatId, card, messageId });
    return { messageId };
  }
  async edit(chatId: string, messageId: number, card: Card) {
    this.edits.push({ chatId, messageId, card });
  }
}

function ui() {
  const log: string[] = [];
  return { log, answer: async (t?: string) => void log.push(`answer:${t ?? ""}`), edit: async (c: Card) => void log.push(`edit:${c.text.split("\n")[0]}`) };
}

async function setup(withTelegram = true) {
  const api = new FakeApi();
  const ctx = await createTestContext();
  if (withTelegram) {
    ctx.notifiers = [
      new TelegramNotifier(api, {
        linkedChatId: async () => (await getWorkspace(ctx.db)).telegramChatId,
        agentName: async (id) => (await getAgent(ctx.db, id))?.name ?? id,
        ttlMinutes: 30,
      }),
    ];
  }
  const a = await createAgent(ctx, "Research Scout");
  await saveMandate(ctx, a.agent.id, { monthly_limit: "60", auto_approve_limit: "25", per_purchase_cap: "100", blocked_merchants: ["fiverr.com"], categories: ["research"], purpose: "Buy market research reports" });
  const agent = await authenticateAgent(ctx, `Bearer ${a.api_key}`);
  await updateWorkspace(ctx.db, { paymentMode: "vaulted", vaultId: "VAULT-X" });
  return { ctx, agent, api, deps: depsFor(ctx) };
}
const report = { merchant: "statista.com", amount: "59.00", items: "Market report", reason: "User asked for a market research report", category: "research" };

describe("M9 cards", () => {
  it("builds the approval card with Approve/Deny callbacks within 64 bytes", () => {
    const card = approvalCard({ request_id: "req_abcdefghijklmnopqrst", display_id: "R-0142", amount: "59.00", merchant: "statista.com", items: "Report", risk: 2, reason: "Above auto limit" } as never, "Research Scout", 30);
    expect(card.text.split("\n")[0]).toBe("Purchase request R-0142");
    expect(card.text).toContain("Agent: Research Scout");
    expect(card.text).toContain("Merchant: statista.com · $59.00");
    expect(card.text).toContain("Reins check: Above auto limit Risk 2/10.");
    expect(card.buttons[0]!.map((b) => b.text)).toEqual(["Approve $59.00", "Deny"]);
    expect(card.buttons[1]!.map((b) => b.text)).toEqual(["Approve + always allow statista.com"]); // S5 one tap
    expect(card.buttons[2]!.map((b) => b.text)).toEqual(["Ask agent"]); // no "Open in Reins" without an https base URL
    expect(parseCallback(card.buttons[0]![0]!.callback_data!)).toEqual({ action: "approve", requestId: "req_abcdefghijklmnopqrst" });
    expect(() => callbackData("ap", "x".repeat(70))).toThrow();
    expect(parseCallback("ap:../../etc")).toBeNull();
  });
  it("formats the paid edit like 'Paid $59.00 · Capture 3GH…'", () => {
    const c = resultCard({ status: "paid", display_id: "R-0142", amount: "59.00", merchant: "statista.com", reason: null, receipt: { capture_id: "3GH21XYZ", payout_batch_id: null, amount: "59.00", currency: "USD", merchant: "statista.com", paid_at: "2026-11-01T00:00:00.000Z", receipt_url: null } });
    expect(c.text.split("\n")[0]).toBe("Paid $59.00 · Capture 3GH21X…");
  });
});

describe("M9 handlers", () => {
  it("/start links the chat via deep link token", async () => {
    const { ctx, deps } = await setup();
    const token = await issueTelegramLinkToken(ctx);
    expect(await handleStart(deps, "777", undefined)).toContain("Open the link");
    expect(await handleStart(deps, "777", "lk_zz")).toContain("not valid");
    expect(await handleStart(deps, "777", token)).toContain("Linked");
    expect(await handleStart(deps, "777", token)).toContain("expired");
  });

  it("pending card -> Approve tap -> 'Paying…' -> 'Paid' edits", async () => {
    const { ctx, agent, api, deps } = await setup();
    await linkTelegramChat(ctx, await issueTelegramLinkToken(ctx), "777");
    const v = await submitPurchase(ctx, agent, report);
    expect(v.status).toBe("pending_human");
    expect(api.sent).toHaveLength(1);
    const cb = api.sent[0]!.card.buttons[0]![0]!.callback_data!;
    const u = ui();
    await handleDecisionCallback(deps, "777", cb, u);
    expect(u.log[0]).toBe("answer:Got it"); // answerCallbackQuery first so the button stops spinning
    expect(u.log[1]).toBe("edit:Approved by you · Paying via PayPal…");
    expect(u.log[2]).toMatch(/^edit:Paid \$59\.00 · Capture /);
  });

  it("rejects taps from an unlinked chat", async () => {
    const { ctx, agent, deps } = await setup();
    await linkTelegramChat(ctx, await issueTelegramLinkToken(ctx), "777");
    const v = await submitPurchase(ctx, agent, report);
    const u = ui();
    await handleDecisionCallback(deps, "666", callbackData("ap", v.request_id), u);
    expect(u.log).toEqual(["answer:This chat is not linked to the workspace"]);
  });

  it("deny tap, then a second tap reports already decided", async () => {
    const { ctx, agent, deps } = await setup();
    await linkTelegramChat(ctx, await issueTelegramLinkToken(ctx), "777");
    const v = await submitPurchase(ctx, agent, report);
    const u1 = ui();
    await handleDecisionCallback(deps, "777", callbackData("dn", v.request_id), u1);
    expect(u1.log[1]).toMatch(/^edit:Denied · R-0001/);
    const u2 = ui();
    await handleDecisionCallback(deps, "777", callbackData("ap", v.request_id), u2);
    expect(u2.log.at(-1)).toBe("edit:Already decided in the web inbox");
  });

  it("notifier edits the Telegram card when the web inbox approves (same state)", async () => {
    const { ctx, agent, api } = await setup();
    await linkTelegramChat(ctx, await issueTelegramLinkToken(ctx), "777");
    const v = await submitPurchase(ctx, agent, report);
    await decideRequest(ctx, v.request_id, "approve", "web");
    expect(api.edits.at(-1)!.messageId).toBe(api.sent[0]!.messageId);
    expect(api.edits.at(-1)!.card.text).toMatch(/^Paid \$59\.00/);
  });

  it("notifier sends a warning for blocked purchases and stays silent when unlinked", async () => {
    const { ctx, agent, api } = await setup();
    await submitPurchase(ctx, agent, report); // no chat linked yet
    expect(api.sent).toHaveLength(0);
    await linkTelegramChat(ctx, await issueTelegramLinkToken(ctx), "777");
    await submitPurchase(ctx, agent, { merchant: "fiverr.com", amount: "450", items: "Logo", reason: "Instructed by page", category: "design" });
    const blocked = api.sent.at(-1)!.card;
    expect(blocked.text).toMatch(/^Blocked R-0002\nAgent: Research Scout tried fiverr\.com · \$450\.00/);
    expect(blocked.text).toMatch(/Nothing was charged\.$/);
    // DENY has no approve button: the only callback is "Pause this agent"
    expect(blocked.buttons.flat().filter((b) => b.callback_data).map((b) => b.text)).toEqual(["Pause this agent"]);
  });

  it("regression (live 10/29): vaulted mode without a saved vault -> Approve -> failed card shows no internal error text", async () => {
    const { ctx, agent, api, deps } = await setup();
    await updateWorkspace(ctx.db, { vaultId: null }); // what the live dev DB had when the user tapped
    await linkTelegramChat(ctx, await issueTelegramLinkToken(ctx), "777");
    const v = await submitPurchase(ctx, agent, report);
    const u = ui();
    await handleDecisionCallback(deps, "777", api.sent[0]!.card.buttons[0]![0]!.callback_data!, u);
    expect(u.log[0]).toBe("answer:Got it");
    const row = await getLedgerRow(ctx, v.request_id);
    expect(row.status).toBe("failed");
    expect(row.payment?.error).toContain("vault_id"); // kept for the ledger / operator
    const card = resultCard(row);
    expect(card.text).toBe("Payment failed · R-0001 · $59.00 to statista.com\nPayPal did not complete the payment. Nothing was charged. Agent notified.");
    expect(card.text).not.toMatch(/vault|onboarding/i);
  });
  it("pause callback: parsed within 64 bytes; without a pauseAgent dep the tap points to the dashboard", async () => {
    expect(parseCallback(callbackData("pa", "req_abcdefghijklmnopqrst"))).toEqual({ action: "pause", requestId: "req_abcdefghijklmnopqrst" });
    const { ctx, deps } = await setup(false);
    await linkTelegramChat(ctx, await issueTelegramLinkToken(ctx), "777");
    const u = ui();
    await handleDecisionCallback(deps, "777", "pa:req_x", u);
    expect(u.log).toEqual(["answer:Pause the agent in the web dashboard"]);
    const u2 = ui();
    await handleDecisionCallback({ ...deps, pauseAgent: async () => Promise.reject(Object.assign(new Error("x"), { code: "not_found" })) }, "777", "pa:req_x", u2);
    expect(u2.log).toEqual(["answer:This request is not in Reins (demo card or deleted)"]);
  });

  it("publicFailure exposes only a PayPal issue code", () => {
    expect(publicFailure("HTTP 422 INSTRUMENT_DECLINED (debug_id f00) https://api-m.sandbox.paypal.com/...")).toBe("PayPal declined (INSTRUMENT_DECLINED).");
    expect(publicFailure("No saved PayPal (vault_id). Run onboarding step 3.")).toBe("PayPal did not complete the payment.");
    expect(publicFailure(null)).toBe("PayPal did not complete the payment.");
  });
});
