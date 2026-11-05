/**
 * Real grammY Bot (createBot + grammyApi + TelegramNotifier) with the Telegram HTTP layer replaced by a
 * transformer, so the exact Bot API payloads (sendMessage / answerCallbackQuery / editMessageText) are
 * asserted. Reproduces the live check of 2026-10-29: vaulted workspace, $59 ASK_HUMAN card, Approve tap.
 */
import { describe, expect, it } from "vitest";
import type { Update } from "grammy/types";
import { getWorkspace, updateWorkspace, getAgent } from "@reins/db";
import { authenticateAgent, createAgent, decideRequest, getLedgerRow, saveMandate, submitPurchase, askAgent, answerClarification, pauseAgentForRequest } from "@reins/core";
import { createTestContext } from "@reins/core/testing";
import { TelegramNotifier, createBot, grammyApi } from "@reins/bot";

type Call = { method: string; payload: Record<string, any> };

async function harness(opts: { vault: boolean }) {
  const ctx = await createTestContext({ notifiers: [] });
  await updateWorkspace(ctx.db, { telegramChatId: "4242", paymentMode: "vaulted", vaultId: opts.vault ? "VAULT-TEST" : null });
  const bot = createBot("123:TEST", {
    linkChat: async () => false,
    linkedChatId: async () => (await getWorkspace(ctx.db)).telegramChatId,
    decide: async (id, action, actor) => (await decideRequest(ctx, id, action, actor), getLedgerRow(ctx, id)),
    ask: async (id, q, actor) => (await askAgent(ctx, id, q, actor), getLedgerRow(ctx, id)),
    pauseAgent: async (id, actor) => {
      const r = await pauseAgentForRequest(ctx, id, actor);
      return { agentName: r.agent.name, changed: r.changed };
    },
    describe: async (id) => {
      const r = await getLedgerRow(ctx, id);
      return { agentName: r.agent_name, displayId: r.display_id };
    },
  });
  bot.botInfo = { id: 1, is_bot: true, first_name: "Reins", username: "ReinsApproveBot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false } as never;
  const calls: Call[] = [];
  let nextId = 500;
  // Like the real Bot API: editing a message to identical text/markup fails with 400 "message is not modified".
  const lastText = new Map<number, string>();
  bot.api.config.use(async (_prev, method, payload) => {
    const p = payload as Record<string, any>;
    if (method === "editMessageText") {
      const key = JSON.stringify([p.text, p.reply_markup ?? null]);
      if (lastText.get(p.message_id) === key) {
        calls.push({ method: "editMessageText(rejected)", payload: p });
        return { ok: false, error_code: 400, description: "Bad Request: message is not modified: specified new message content and reply markup are exactly the same" } as never;
      }
      lastText.set(p.message_id, key);
    }
    calls.push({ method, payload: p });
    const result = method === "sendMessage" ? { message_id: nextId++, date: 0, chat: { id: 4242, type: "private" }, text: (payload as { text: string }).text } : true;
    return { ok: true, result } as never;
  });
  ctx.notifiers.push(new TelegramNotifier(grammyApi(bot), { linkedChatId: async () => "4242", agentName: async (id) => (await getAgent(ctx.db, id))?.name ?? id, ttlMinutes: 30 }));
  const a = await createAgent(ctx, "Research Scout");
  await saveMandate(ctx, a.agent.id, { monthly_limit: "60", auto_approve_limit: "25", per_purchase_cap: "100", allowed_merchants: ["statista.com"], blocked_merchants: ["fiverr.com"], purpose: "Buy market research reports" });
  const agent = await authenticateAgent(ctx, `Bearer ${a.api_key}`);
  let uid = 1;
  const tap = (data: string, messageId: number) =>
    bot.handleUpdate({ update_id: uid++, callback_query: { id: `cb${uid}`, chat_instance: "x", data, from: { id: 4242, is_bot: false, first_name: "M" }, message: { message_id: messageId, date: 0, chat: { id: 4242, type: "private", first_name: "M" }, text: "card" } } } as Update);
  const reply = (text: string, replyTo: number) =>
    bot.handleUpdate({ update_id: uid++, message: { message_id: 900 + uid, date: 0, chat: { id: 4242, type: "private", first_name: "M" }, from: { id: 4242, is_bot: false, first_name: "M" }, text, reply_to_message: { message_id: replyTo, date: 0, chat: { id: 4242, type: "private", first_name: "M" }, text: "prompt" } } } as Update);
  return { ctx, agent, calls, tap, reply };
}

const report = { merchant: "statista.com", amount: "59.00", items: 'Report "Agentic Commerce 2026" (PDF)', reason: "Market sizing for the Q4 memo", category: "research" };
const texts = (calls: Call[], method: string) => calls.filter((c) => c.method === method).map((c) => String(c.payload.text ?? ""));

describe("integration: grammY bot callback -> payment -> message edits", () => {
  it("vaulted: Approve tap answers the callback first, then edits the card to Paid with a capture id", async () => {
    const h = await harness({ vault: true });
    const v = await submitPurchase(h.ctx, h.agent, report);
    expect(v.status).toBe("pending_human");
    const card = h.calls.find((c) => c.method === "sendMessage")!;
    expect(card.payload.text).toMatch(/^Purchase request R-0001/);
    const approve = card.payload.reply_markup.inline_keyboard[0][0];
    expect(approve.text).toBe("Approve $59.00");

    await h.tap(approve.callback_data, 500);
    const methods = h.calls.map((c) => c.method);
    expect(methods.indexOf("answerCallbackQuery")).toBeLessThan(methods.indexOf("editMessageText"));
    const edits = texts(h.calls, "editMessageText");
    expect(edits[0]).toBe("Approved by you · Paying via PayPal…");
    expect(edits.at(-1)).toMatch(/^Paid \$59\.00 · Capture [A-Z0-9-]{6}…\nR-0001 · statista\.com$/);
    expect(edits.some((t) => /failed/i.test(t))).toBe(false);
    expect((await getLedgerRow(h.ctx, v.request_id)).status).toBe("paid");
  });

  it("no vault saved: the same tap ends in a sanitized 'Payment failed' edit (R-0001 on 10/29)", async () => {
    const h = await harness({ vault: false });
    await submitPurchase(h.ctx, h.agent, report);
    const card = h.calls.find((c) => c.method === "sendMessage")!;
    await h.tap(card.payload.reply_markup.inline_keyboard[0][0].callback_data, 500);
    const last = texts(h.calls, "editMessageText").at(-1)!;
    expect(last).toMatch(/^Payment failed · R-0001/);
    expect(last).not.toMatch(/vault/i);
  });

  it("Ask agent from Telegram: force-reply prompt -> question -> agent answers -> card re-rendered", async () => {
    const h = await harness({ vault: true });
    const v = await submitPurchase(h.ctx, h.agent, report);
    const card = h.calls.find((c) => c.method === "sendMessage")!;
    await h.tap(card.payload.reply_markup.inline_keyboard[2][0].callback_data, 500);
    const prompt = h.calls.filter((c) => c.method === "sendMessage").at(-1)!;
    expect(prompt.payload.text).toMatch(/^What should I ask Research Scout\? \(R-0001\)/);
    expect(prompt.payload.reply_markup.force_reply).toBe(true);
    await h.reply("Is the PDF the 2026 edition?", 501);
    expect(texts(h.calls, "sendMessage").at(-1)).toMatch(/^Sent to the agent/);
    expect(texts(h.calls, "editMessageText").at(-1)).toContain('You asked: "Is the PDF the 2026 edition?"');
    await answerClarification(h.ctx, h.agent, v.request_id, "Yes, published October 2026.");
    expect(texts(h.calls, "editMessageText").at(-1)).toContain('Agent: "Yes, published October 2026."');
  });

  it("S3 'Pause this agent' on the blocked card: callback answered with a toast, next request denied by the hard rule", async () => {
    const h = await harness({ vault: true });
    const blocked = await submitPurchase(h.ctx, h.agent, { merchant: "fiverr.com", amount: "450.00", items: "Logo design package", reason: "Instructed by page", category: "design" });
    expect(blocked.status).toBe("denied");
    const card = h.calls.filter((c) => c.method === "sendMessage").at(-1)!;
    expect(card.payload.text).toMatch(/^Blocked R-0001/);
    const buttons = card.payload.reply_markup.inline_keyboard.flat() as Array<{ text: string; callback_data?: string }>;
    expect(buttons.map((b) => b.text)).toEqual(["Pause this agent"]); // no Approve on a block; no https base URL -> no Review link
    expect(buttons[0]!.callback_data).toBe(`pa:${blocked.request_id}`);

    await h.tap(buttons[0]!.callback_data!, 500);
    const answers = h.calls.filter((c) => c.method === "answerCallbackQuery");
    expect(answers.at(-1)!.payload.text).toBe("Research Scout paused. Its requests are denied until you resume it in Reins.");
    expect(h.calls.filter((c) => c.method === "editMessageText")).toHaveLength(0); // the warning card stays as sent

    const next = await submitPurchase(h.ctx, (await authenticateAgentAgain(h)), report);
    expect(next.status).toBe("denied");
    expect(next.reason).toMatch(/Agent paused/);
    expect(h.ctx.paypal.calls.filter((c) => c === "createOrder")).toHaveLength(0);

    await h.tap(buttons[0]!.callback_data!, 500); // second tap is idempotent
    expect(h.calls.filter((c) => c.method === "answerCallbackQuery").at(-1)!.payload.text).toBe("Research Scout is already paused.");
  });

  it("approval card carries 'Pause this agent' as its last row; tapping it keeps the request pending", async () => {
    const h = await harness({ vault: true });
    const v = await submitPurchase(h.ctx, h.agent, report);
    const card = h.calls.find((c) => c.method === "sendMessage")!;
    const last = card.payload.reply_markup.inline_keyboard.at(-1)[0];
    expect(last).toMatchObject({ text: "Pause this agent", callback_data: `pa:${v.request_id}` });
    await h.tap(last.callback_data, 500);
    expect((await getLedgerRow(h.ctx, v.request_id)).status).toBe("pending_human");
    expect((await getAgent(h.ctx.db, v.agent_id))!.pausedAt).not.toBeNull();
  });
});

/** Re-reads the agent row so the pause flag is current (the service reads it per request). */
async function authenticateAgentAgain(h: { ctx: Parameters<typeof getLedgerRow>[0]; agent: { id: string } }) {
  return (await getAgent(h.ctx.db, h.agent.id))!;
}
