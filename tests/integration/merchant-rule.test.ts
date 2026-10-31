/**
 * S5 (#19) "Approve + always allow this merchant": one tap approves the pending request and saves a new mandate
 * version whose merchant rule auto-approves that merchant up to the approved amount. Web inbox route, Telegram
 * button, rule sentence (template / Claude stub), and the guard rails that must not move.
 */
import { describe, expect, it } from "vitest";
import { getActiveMandate, getWorkspace, listMandateVersions } from "@reins/db";
import { approveAndAllowMerchant, ClaudeRuleWriter, getLedgerRow, templateRuleSentence, writeRuleSentence, type MessagesParseClient } from "@reins/core";
import { TelegramNotifier, approvalCard, handleDecisionCallback, parseCallback, type Card, type TelegramApi } from "@reins/bot";
import { harness, report, scoutMandate } from "./harness.ts";

describe("S5 approve + always allow this merchant", () => {
  it("web inbox: one tap pays, saves mandate v2 with a statista.com rule, and the next $59 report is paid automatically", async () => {
    const h = await harness();
    await h.vaulted();
    const scout = await h.agentClient("Research Scout", scoutMandate);

    const first = await scout.call("request_purchase", report(1));
    expect(first.data).toMatchObject({ status: "pending_human", decision: "ASK_HUMAN" });

    const tap = await h.admin("POST", `/api/requests/${first.data.request_id}/decision`, { action: "approve", allow_merchant: true });
    expect(tap.status).toBe(200);
    expect(tap.body.status).toBe("paid");
    expect(tap.body.rule).toMatchObject({ merchant: "statista.com", limit: "59.00", mandate_version: 2, source: "template" });
    expect(tap.body.rule.sentence).toBe("Research Scout can now buy from statista.com up to $59.00 without asking you (mandate v2); other merchants still ask above $25.00.");
    const human = tap.body.decisions.find((d: { stage: string }) => d.stage === "human");
    expect(human).toMatchObject({ decision: "APPROVE", actor: "web", details: { merchant_rule: { merchant: "statista.com", limit: "59.00" } } });

    // the agent sees the rule in its mandate; everything else is unchanged
    const m = await scout.call("get_mandate", {});
    expect(m.data.mandate).toMatchObject({ version: 2, auto_approve_limit: "25.00", monthly_limit: "200.00", per_purchase_cap: "100.00", merchant_auto_limits: { "statista.com": "59.00" } });
    expect(m.data.mandate.allowed_merchants).toEqual(["statista.com", "gartner.com"]);

    h.tick();
    const second = await scout.call("request_purchase", report(2));
    expect(second.data).toMatchObject({ status: "paid", decision: "AUTO_APPROVE" });
    const row = await getLedgerRow(h.ctx, second.data.request_id);
    expect(row.decisions.find((d) => d.stage === "llm")?.details).toMatchObject({ merchant_auto_limit: "59.00" });

    // above the rule's amount, and other merchants, still ask
    h.tick();
    expect((await scout.call("request_purchase", report(3, "59.01"))).data.status).toBe("pending_human");
    h.tick();
    expect((await scout.call("request_purchase", report(4, "59.00", "gartner.com"))).data.status).toBe("pending_human");
  });

  it("does not touch the mandate when the request was already decided; deny + allow is rejected", async () => {
    const h = await harness();
    const scout = await h.agentClient("Research Scout", scoutMandate);
    const r = await scout.call("request_purchase", report(1));
    await h.admin("POST", `/api/requests/${r.data.request_id}/decision`, { action: "deny" });
    const again = await h.admin("POST", `/api/requests/${r.data.request_id}/decision`, { action: "approve", allow_merchant: true });
    expect(again).toMatchObject({ status: 409, body: { error: "already_decided" } });
    expect(await listMandateVersions(h.ctx.db, scout.agentId)).toHaveLength(1);

    expect((await h.admin("POST", `/api/requests/${r.data.request_id}/decision`, { action: "deny", allow_merchant: true })).status).toBe(400);
  });

  it("never lowers an existing rule and keeps the limit within the monthly cap", async () => {
    const h = await harness();
    const scout = await h.agentClient("Research Scout", { ...scoutMandate, merchant_auto_limits: { "statista.com": "80.00" } });
    const r = await scout.call("request_purchase", report(1, "90.00"));
    expect(r.data.status).toBe("pending_human");
    const { rule } = await approveAndAllowMerchant(h.ctx, r.data.request_id, "web");
    expect(rule.limit).toBe("90.00");
    h.tick();
    const r2 = await scout.call("request_purchase", report(2, "30.00"));
    expect(r2.data.status).not.toBe("pending_human");
    expect((await getActiveMandate(h.ctx.db, scout.agentId))!.merchantAutoLimits).toEqual({ "statista.com": 9000 });
  });

  it("mandate editor round trip: merchant_auto_limits validated, saved, and removable", async () => {
    const h = await harness();
    const scout = await h.agentClient("Research Scout", scoutMandate);
    const bad = await h.admin("POST", `/api/agents/${scout.agentId}/mandates`, { ...scoutMandate, merchant_auto_limits: { "statista.com": "500.00" } });
    expect(bad.status).toBe(400);
    const ok = await h.admin("POST", `/api/agents/${scout.agentId}/mandates`, { ...scoutMandate, merchant_auto_limits: { "https://www.Statista.com/": "40" } });
    expect(ok.body.mandate.merchant_auto_limits).toEqual({ "statista.com": "40.00" });
    const removed = await h.admin("POST", `/api/agents/${scout.agentId}/mandates`, scoutMandate);
    expect(removed.body.mandate.merchant_auto_limits).toEqual({});
  });

  it("Telegram: the card has the one-tap button; tapping it pays and edits the card with the rule", async () => {
    const h = await harness();
    await h.vaulted();
    const api: TelegramApi & { sent: Card[]; edits: Card[] } = {
      sent: [],
      edits: [],
      async send(_c, card) {
        this.sent.push(card);
        return { messageId: this.sent.length };
      },
      async edit(_c, _m, card) {
        this.edits.push(card);
      },
    };
    const { updateWorkspace } = await import("@reins/db");
    await updateWorkspace(h.ctx.db, { telegramChatId: "4242" });
    h.ctx.notifiers.push(new TelegramNotifier(api, { linkedChatId: async () => (await getWorkspace(h.ctx.db)).telegramChatId, agentName: async () => "Research Scout", ttlMinutes: 30 }));
    const scout = await h.agentClient("Research Scout", scoutMandate);
    const r = await scout.call("request_purchase", report(1));

    const card = api.sent[0]!;
    expect(card.buttons.map((row) => row.map((b) => b.text))).toEqual([["Approve $59.00", "Deny"], ["Approve + always allow statista.com"], ["Ask agent"]]);
    const data = card.buttons[1]![0]!.callback_data!;
    expect(parseCallback(data)).toEqual({ action: "approve_allow", requestId: r.data.request_id });

    const log: string[] = [];
    const deps = {
      linkChat: async () => false,
      linkedChatId: async () => "4242",
      decide: async () => {
        throw new Error("not used");
      },
      approveAllow: async (id: string, actor: string) => {
        const { rule } = await approveAndAllowMerchant(h.ctx, id, actor);
        return { row: await getLedgerRow(h.ctx, id), rule };
      },
    };
    await handleDecisionCallback(deps, "4242", data, { answer: async (t) => void log.push(`answer:${t}`), edit: async (c) => void log.push(`edit:${c.text}`) });
    expect(log[0]).toBe("answer:Got it");
    expect(log[1]).toBe("edit:Approved by you · Saving the merchant rule and paying via PayPal…");
    expect(log[2]).toMatch(/^edit:Paid \$59\.00 · Capture .+\nR-\d{4} · statista\.com\nRule added: Research Scout can now buy from statista\.com up to \$59\.00/);
    const human = (await getLedgerRow(h.ctx, r.data.request_id)).decisions.find((d) => d.stage === "human");
    expect(human?.actor).toBe("telegram");

    // a second tap on the same card is refused without changing the mandate again
    log.length = 0;
    await handleDecisionCallback(deps, "4242", data, { answer: async (t) => void log.push(`answer:${t}`), edit: async (c) => void log.push(`edit:${c.text}`) });
    expect(log.at(-1)).toBe("edit:Already decided in the web inbox");
    expect(await listMandateVersions(h.ctx.db, scout.agentId)).toHaveLength(2);
  });

  it("older bot wiring without approveAllow answers with a pointer to the web inbox", async () => {
    const card = approvalCard({ request_id: "req_abcdefghijklmnopqrst", display_id: "R-0001", merchant: "statista.com", amount: "59.00" } as never, "Scout", 30);
    const log: string[] = [];
    await handleDecisionCallback({ linkChat: async () => false, linkedChatId: async () => "1", decide: async () => ({}) as never }, "1", card.buttons[1]![0]!.callback_data!, {
      answer: async (t) => void log.push(String(t)),
      edit: async () => void log.push("edit"),
    });
    expect(log).toEqual(["Approve + always allow is available in the web inbox"]);
  });

  it("rule sentence: Claude when faithful to the facts, template when the model drifts or fails", async () => {
    const facts = { agent: "Research Scout", merchant: "statista.com", limitCents: 5900, baseAutoLimitCents: 2500, mandateVersion: 2 };
    const stub = (sentence: string | Error): MessagesParseClient =>
      ({ messages: { parse: async () => (sentence instanceof Error ? Promise.reject(sentence) : { stop_reason: "end_turn", parsed_output: { sentence } }) } }) as unknown as MessagesParseClient;

    const good = await writeRuleSentence(new ClaudeRuleWriter({ client: stub("From now on, Research Scout pays statista.com up to $59.00 on its own (v2); other shops still ask above $25.00.") }), facts);
    expect(good.source).toMatch(/^claude:/);
    expect(good.sentence).toContain("statista.com");

    const drift = await writeRuleSentence(new ClaudeRuleWriter({ client: stub("Research Scout may now buy anything up to $500.") }), facts);
    expect(drift).toEqual({ sentence: templateRuleSentence(facts), source: "template" });
    expect((await writeRuleSentence(new ClaudeRuleWriter({ client: stub(new Error("529")) }), facts)).source).toBe("template");
    expect((await writeRuleSentence(undefined, facts)).source).toBe("template");
  });
});
