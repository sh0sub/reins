/**
 * S2 (#16) Ask agent: the question/answer round trip already existed (checkpoint.test.ts, telegram-bot.test.ts);
 * this covers the remaining acceptance item, the AI summary of the agent's answer on the card.
 */
import { describe, expect, it } from "vitest";
import { getWorkspace, updateWorkspace } from "@reins/db";
import { ClaudeAnswerSummarizer, summarizeAnswer, templateAnswerSummary, type MessagesParseClient } from "@reins/core";
import { TelegramNotifier, type Card, type TelegramApi } from "@reins/bot";
import { harness, report, scoutMandate } from "./harness.ts";

const LONG =
  "The Q4 memo needs a market size for agentic commerce by Friday, and statista.com is the only source with 2026 figures. " +
  "The free summary stops at 2024, so the $59 single report is the cheapest option; the annual plan would be $199.";

const stub = (out: string | Error): MessagesParseClient =>
  ({ messages: { parse: async () => (out instanceof Error ? Promise.reject(out) : { stop_reason: "end_turn", parsed_output: { summary: out } }) } }) as unknown as MessagesParseClient;

describe("S2 ask agent: AI answer summary", () => {
  it("long answer over MCP gets a one-line summary on the Telegram card and in the inbox; the full answer is kept", async () => {
    const h = await harness({ overrides: { answerSummarizer: new ClaudeAnswerSummarizer({ client: stub("Needs 2026 market size for Friday's memo; $59 report is cheapest, annual plan $199.") }) } });
    const api: TelegramApi & { sent: Card[]; edits: Card[] } = {
      sent: [],
      edits: [],
      async send(_c, card) {
        this.sent.push(card);
        return { messageId: 1 };
      },
      async edit(_c, _m, card) {
        this.edits.push(card);
      },
    };
    await updateWorkspace(h.ctx.db, { telegramChatId: "4242" });
    h.ctx.notifiers.push(new TelegramNotifier(api, { linkedChatId: async () => (await getWorkspace(h.ctx.db)).telegramChatId, agentName: async () => "Research Scout", ttlMinutes: 30 }));
    const scout = await h.agentClient("Research Scout", scoutMandate);
    const r = await scout.call("request_purchase", report(1));

    await h.admin("POST", `/api/requests/${r.data.request_id}/ask`, { question: "Why this report and not the free summary?" });
    const asked = await scout.call("get_request_status", { request_id: r.data.request_id });
    expect(asked.data.needs_clarification).toBe(true);

    const answered = await scout.call("get_request_status", { request_id: r.data.request_id, answer: LONG });
    expect(answered.data.clarification).toMatchObject({ answer: LONG, answer_summary: "Needs 2026 market size for Friday's memo; $59 report is cheapest, annual plan $199." });
    expect(api.edits.at(-1)!.text).toContain(`Agent (summary): "Needs 2026 market size for Friday's memo; $59 report is cheapest, annual plan $199."`);
    expect(api.edits.at(-1)!.text).not.toContain("The free summary stops at 2024");

    const inbox = await h.admin("GET", "/api/inbox");
    expect(inbox.body.items[0].clarification.answer_summary).toMatch(/^Needs 2026 market size/);
    expect(inbox.body.items[0].messages.map((m: { role: string }) => m.role)).toEqual(["human", "agent"]);
  });

  it("short answers are shown as is (no summary); Telegram card quotes the answer", async () => {
    const h = await harness();
    const scout = await h.agentClient("Research Scout", scoutMandate);
    const r = await scout.call("request_purchase", report(1));
    await h.admin("POST", `/api/requests/${r.data.request_id}/ask`, { question: "Which report?" });
    const a = await scout.call("get_request_status", { request_id: r.data.request_id, answer: "Agentic Commerce 2026, PDF." });
    expect(a.data.clarification).toMatchObject({ answer: "Agentic Commerce 2026, PDF.", answer_summary: null });
  });

  it("summary falls back to the first sentence without Claude or when Claude fails, and is capped", async () => {
    const input = { question: "Why?", answer: LONG };
    expect(await summarizeAnswer(undefined, input)).toEqual({ summary: templateAnswerSummary(LONG), source: "template" });
    expect(templateAnswerSummary(LONG)).toBe("The Q4 memo needs a market size for agentic commerce by Friday, and statista.com is the only source with 2026 figures.");
    expect((await summarizeAnswer(new ClaudeAnswerSummarizer({ client: stub(new Error("timeout")) }), input))!.source).toBe("template");
    const long = await summarizeAnswer(new ClaudeAnswerSummarizer({ client: stub("x".repeat(200)) }), input);
    expect(long!.summary.length).toBeLessThanOrEqual(160);
    expect(await summarizeAnswer(undefined, { question: "q", answer: "short" })).toBeNull();
  });
});
