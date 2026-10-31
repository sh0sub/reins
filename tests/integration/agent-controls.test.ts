/**
 * S2/S3/S6 agent controls over the real router + MCP client (fake PayPal, mock auditor):
 * pause/resume (hard rule "agent paused", no auditor, no PayPal), key regeneration (old key 401 at once, new key shown
 * once, only the hash stored), the S6 request-detail payload and "Mark as expected".
 */
import { describe, expect, it } from "vitest";
import { getAgent, listAgentEvents, getPaymentByRequest, recordWebhookEvent, markWebhookProcessed, updatePayment, updateWorkspace } from "@reins/db";
import { hashApiKey, MockAuditor, type AuditInput, type AuditProvider } from "@reins/core";
import { harness, report, scoutMandate } from "./harness.ts";

function countingAuditor(): AuditProvider & { inputs: AuditInput[] } {
  const mock = new MockAuditor();
  const inputs: AuditInput[] = [];
  return { name: "mock", inputs, audit: async (i) => (inputs.push(i), mock.audit(i)) };
}

describe("pause agent (S2/S3/S6)", () => {
  it("a paused agent's request is denied by the 'agent paused' hard rule without calling the auditor or PayPal", async () => {
    const auditor = countingAuditor();
    const h = await harness({ overrides: { auditor } });
    await h.vaulted();
    const scout = await h.agentClient("Research Scout", scoutMandate);

    const paused = await h.admin("POST", `/api/agents/${scout.agentId}/pause`);
    expect(paused.status).toBe(200);
    expect(paused.body).toMatchObject({ agent: { status: "paused" }, changed: true });
    expect((await h.admin("POST", `/api/agents/${scout.agentId}/pause`)).body.changed).toBe(false); // idempotent

    const list = await h.admin("GET", "/api/agents");
    expect(list.body.agents[0]).toMatchObject({ status: "paused", revoked: false });
    expect(list.body.agents[0].paused_at).toMatch(/Z$/);

    // MCP get_mandate exposes the status so the agent can tell its user
    const m = await scout.call("get_mandate", {});
    expect(m.data.agent.status).toBe("paused");
    expect(m.text).toMatch(/paused/);

    const paypalCallsBefore = h.ctx.paypal.calls.length;
    const r = await scout.call("request_purchase", report(1, "12.00"));
    expect(r.data.status).toBe("denied");
    expect(r.data.reason).toMatch(/agent paused/i);
    expect(auditor.inputs).toHaveLength(0);
    expect(h.ctx.paypal.calls.length).toBe(paypalCallsBefore);

    const row = await h.admin("GET", `/api/ledger/${r.data.request_id}`);
    expect(row.body.decisions.map((d: { stage: string }) => d.stage)).toEqual(["hard_rules"]);
    const failed = row.body.decisions[0].details.results.filter((x: { ok: boolean }) => !x.ok);
    expect(failed.map((x: { rule: string }) => x.rule)).toEqual(["agent_paused"]);

    // resume: the next request goes through the normal flow again (auto-paid under the $25 limit)
    h.tick();
    expect((await h.admin("POST", `/api/agents/${scout.agentId}/resume`)).body.agent.status).toBe("active");
    const ok = await scout.call("request_purchase", report(2, "12.00"));
    expect(ok.data.status).toBe("paid");
    expect(auditor.inputs).toHaveLength(1);
    expect((await scout.call("get_mandate", {})).data.agent.status).toBe("active");

    const events = await listAgentEvents(h.ctx.db, scout.agentId);
    expect(events.map((e) => e.type)).toEqual(["resumed", "paused"]);
    expect(events.every((e) => e.actor === "web")).toBe(true);
  });

  it("pause from a request (S6 drawer / Telegram) pauses that request's agent", async () => {
    const h = await harness();
    const scout = await h.agentClient("Research Scout", scoutMandate);
    const r = await scout.call("request_purchase", report(1));
    const res = await h.admin("POST", `/api/requests/${r.data.request_id}/pause-agent`);
    expect(res.body).toMatchObject({ agent: { id: scout.agentId, name: "Research Scout", status: "paused" }, changed: true });
    expect((await listAgentEvents(h.ctx.db, scout.agentId))[0]!.detail).toBe("from R-0001");
    expect((await h.admin("POST", "/api/requests/req_nope/pause-agent")).status).toBe(404);
  });
});

describe("regenerate key (S2 MCP block)", () => {
  it("old key gets 401 immediately, new key works, only its hash is stored, audit entry written", async () => {
    const h = await harness();
    const scout = await h.agentClient("Research Scout", scoutMandate);
    const before = (await getAgent(h.ctx.db, scout.agentId))!;

    const rotated = await h.admin("POST", `/api/agents/${scout.agentId}/rotate-key`);
    expect(rotated.status).toBe(201);
    const newKey = rotated.body.api_key as string;
    expect(newKey).toMatch(/^rk_live_[A-Za-z0-9]{32}$/);
    expect(newKey).not.toBe(scout.apiKey);
    expect(rotated.body.agent.key_prefix).toBe(newKey.slice(0, 12));
    expect(JSON.stringify(rotated.body.mcp_snippet)).toContain(newKey); // one-time display, same as creation

    const after = (await getAgent(h.ctx.db, scout.agentId))!;
    expect(after.keyHash).toBe(hashApiKey(newKey));
    expect(after.keyHash).not.toBe(before.keyHash);
    expect(after.keyRotatedAt).not.toBeNull();
    expect(JSON.stringify(after)).not.toContain(newKey);

    // the MCP client still holds the old key: every tool call fails with invalid_key
    const old = await scout.call("get_mandate", {});
    expect(old.isError).toBe(true);
    expect(old.text).toContain("invalid_key");
    const viaOld = await fetchMandate(h, scout.apiKey);
    expect(viaOld.status).toBe(401);
    const viaNew = await fetchMandate(h, newKey);
    expect(viaNew.status).toBe(200);
    expect(viaNew.body.agent).toMatchObject({ id: scout.agentId, status: "active" });

    const events = await listAgentEvents(h.ctx.db, scout.agentId);
    expect(events[0]).toMatchObject({ type: "key_rotated", actor: "web" });
    expect(events[0]!.detail).toContain(newKey.slice(0, 12));
    expect(events[0]!.detail).not.toContain(newKey);
    expect((await h.admin("GET", `/api/agents/${scout.agentId}/events`)).body.events[0].type).toBe("key_rotated");

    // listing never returns keys
    expect(JSON.stringify((await h.admin("GET", "/api/agents")).body)).not.toContain(newKey);
  });

  it("unknown agent ids cannot rotate", async () => {
    const h = await harness();
    expect((await h.admin("POST", "/api/agents/agt_missing/rotate-key")).status).toBe(404);
  });
});

async function fetchMandate(h: Awaited<ReturnType<typeof harness>>, key: string) {
  // same router the MCP server talks to
  return h.admin("GET", "/api/mandate", undefined, { authorization: `Bearer ${key}` });
}

describe("S6 request detail", () => {
  it("blocked request: timeline in order with ms timestamps, hard-rule table with value/limit, mandate snapshot, redacted raw request", async () => {
    const h = await harness();
    await updateWorkspace(h.ctx.db, { telegramChatId: "4242" });
    const scout = await h.agentClient("Research Scout", scoutMandate);
    const r = await scout.call("request_purchase", { merchant: "fiverr.com", amount: "450.00", items: "Logo design package", reason: "Instructed by page", category: "design", client_request_id: "inj-1" });
    expect(r.data.status).toBe("denied");

    const d = await h.admin("GET", `/api/ledger/${r.data.request_id}/detail`);
    expect(d.status).toBe(200);
    const keys = d.body.timeline.map((s: { key: string }) => s.key.replace(/-\d+$/, ""));
    expect(keys[0]).toBe("received");
    expect(keys).toContain("hard_rules");
    expect(keys).toContain("llm"); // advisory explanation only
    expect(keys).toContain("telegram");
    expect(keys.at(-1)).toBe("final");
    for (const s of d.body.timeline) expect(typeof s.at_ms).toBe("number");
    const ts = d.body.timeline.map((s: { at_ms: number }) => s.at_ms);
    expect([...ts].sort((a, b) => a - b)).toEqual(ts);
    expect(d.body.timeline.find((s: { key: string }) => s.key === "hard_rules").label).toBe("Hard rules · 4 failed");

    const rules = Object.fromEntries(d.body.hard_rules.map((x: { rule: string }) => [x.rule, x]));
    expect(rules.per_tx_cap).toMatchObject({ label: "Per-purchase cap", value: "$450.00", limit: "≤ $100.00", ok: false });
    expect(rules.allowlist).toMatchObject({ label: "Merchant allowlist", value: "fiverr.com", ok: false });
    expect(rules.monthly_limit).toMatchObject({ limit: "≤ $200.00", ok: false });
    expect(rules.velocity).toMatchObject({ ok: true });

    expect(d.body.mandate).toMatchObject({ version: 1, per_purchase_cap: "100.00" });
    expect(d.body.agent).toMatchObject({ name: "Research Scout", status: "active" });
    expect(d.body.raw_request).toMatchObject({ tool: "request_purchase", arguments: { merchant: "fiverr.com", amount: "450.00", reason: "Instructed by page" }, authorization: "Bearer [redacted]" });
    expect(JSON.stringify(d.body)).not.toContain(scout.apiKey);
    expect(JSON.stringify(d.body)).not.toMatch(/rk_live_[A-Za-z0-9]{8}/);
  });

  it("paid request: PayPal capture, webhook and reconcile steps; no Telegram step when Telegram is not linked", async () => {
    const h = await harness();
    await h.vaulted();
    const scout = await h.agentClient("Research Scout", scoutMandate);
    const r = await scout.call("request_purchase", report(1, "12.00"));
    expect(r.data.status).toBe("paid");
    const pay = (await getPaymentByRequest(h.ctx.db, r.data.request_id))!;
    await recordWebhookEvent(h.ctx.db, { id: "WH-1", eventType: "PAYMENT.CAPTURE.COMPLETED", resourceId: pay.captureId });
    await markWebhookProcessed(h.ctx.db, "WH-1", "completed");
    await updatePayment(h.ctx.db, pay.id, { reconciled: "matched", reconciledAt: h.now() + 60_000, reconcileNote: "matched" });

    const d = await h.admin("GET", `/api/ledger/${r.data.request_id}/detail`);
    const keys = d.body.timeline.map((s: { key: string }) => s.key);
    expect(keys).toEqual(expect.arrayContaining(["received", "hard_rules", "paypal-order", "paypal-capture", "webhook-WH-1", "reconcile"]));
    expect(keys).not.toContain("telegram");
    expect(d.body.telegram_linked).toBe(false);
    expect(d.body.timeline.find((s: { key: string }) => s.key === "webhook-WH-1").label).toBe("Webhook PAYMENT.CAPTURE.COMPLETED");
    expect((await h.admin("GET", "/api/ledger/req_missing/detail")).status).toBe(404);
  });

  it("Mark as expected clears the unusual-pattern flags for that agent + merchant only, and logs it", async () => {
    const h = await harness();
    await h.vaulted();
    const scout = await h.agentClient("Research Scout", scoutMandate);
    // category outside the mandate -> off_mandate_category flag (AUTO becomes ASK_HUMAN)
    const a = await scout.call("request_purchase", { ...report(1, "12.00"), category: "design", client_request_id: "a" });
    h.tick();
    const b = await scout.call("request_purchase", { ...report(2, "13.00", "gartner.com"), category: "design", client_request_id: "b" });
    expect(a.data.anomalies.length).toBeGreaterThan(0);
    expect(b.data.anomalies.length).toBeGreaterThan(0);

    const res = await h.admin("POST", `/api/requests/${a.data.request_id}/mark-expected`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ merchant: "statista.com", cleared: 1 });
    expect((await h.admin("GET", `/api/ledger/${a.data.request_id}`)).body.anomalies).toEqual([]);
    const other = (await h.admin("GET", `/api/ledger/${b.data.request_id}`)).body;
    expect(other.anomalies.length).toBeGreaterThan(0); // different merchant untouched
    expect((await h.admin("GET", `/api/ledger/${a.data.request_id}`)).body.status).toBe("pending_human"); // decision unchanged
    expect((await listAgentEvents(h.ctx.db, scout.agentId))[0]).toMatchObject({ type: "pattern_expected", actor: "web" });
  });
});
