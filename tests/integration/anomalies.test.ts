/**
 * S3 (#17) unusual-pattern detection: repeat merchant, late-night request, category outside the mandate.
 * Patterns add risk, turn AUTO into ASK_HUMAN with a warning (never block on their own), reach the auditor as
 * signals so it can explain them, and show on the Telegram card, inbox item and decision trail.
 */
import { describe, expect, it } from "vitest";
import { applyAnomalies, detectAnomalies, getLedgerRow, inQuietHours, localTime, MockAuditor, type AuditInput, type AuditProvider } from "@reins/core";
import { approvalCard, blockedCard } from "@reins/bot";
import { quietHoursFromEnv } from "../../apps/web/src/server/context.ts";
import { devopsMandate, harness } from "./harness.ts";

const SEOUL = { timeZone: "Asia/Seoul", startHour: 0, endHour: 6 };
const NIGHT_KST = Date.parse("2026-11-03T17:30:00Z"); // 02:30 in Seoul
const NOON_KST = Date.parse("2026-11-03T03:00:00Z"); // 12:00 in Seoul
const renew = (n: number, extra: Record<string, unknown> = {}) => ({
  merchant: "namecheap.com",
  amount: "12.98",
  items: `domain renewal ${n}`,
  reason: "Domain renewal for the project",
  category: "domains",
  client_request_id: `renew-${n}`,
  ...extra,
});

/** Auditor wrapper that records what it was shown. */
function recording(): AuditProvider & { inputs: AuditInput[] } {
  const mock = new MockAuditor();
  const inputs: AuditInput[] = [];
  return { name: "mock", inputs, audit: async (i) => (inputs.push(i), mock.audit(i)) };
}

describe("S3 detector (pure)", () => {
  it("local time and quiet hours, including windows that wrap midnight", () => {
    expect(localTime(NIGHT_KST, "Asia/Seoul")).toEqual({ hour: 2, label: "02:30" });
    expect(inQuietHours(2, SEOUL)).toBe(true);
    expect(inQuietHours(6, SEOUL)).toBe(false);
    expect(inQuietHours(23, { startHour: 22, endHour: 6 })).toBe(true);
    expect(inQuietHours(12, { startHour: 22, endHour: 6 })).toBe(false);
  });

  it("flags the 4th request to one merchant within 24h, not older ones", () => {
    const now = NOON_KST;
    const recent = [1, 2, 3].map((h) => ({ merchant: "statista.com", createdAt: now - h * 3_600_000 }));
    const base = { request: { merchant: "statista.com", category: null, createdAt: now }, mandate: { categories: [] } };
    expect(detectAnomalies({ ...base, recent }).map((a) => a.code)).toEqual(["repeat_merchant"]);
    expect(detectAnomalies({ ...base, recent })[0]!.detail_en).toBe("4th request to statista.com in 24 hours");
    expect(detectAnomalies({ ...base, recent: recent.slice(0, 2) })).toEqual([]);
    expect(detectAnomalies({ ...base, recent: [...recent.slice(0, 2), { merchant: "statista.com", createdAt: now - 25 * 3_600_000 }] })).toEqual([]);
  });

  it("weighs risk, escalates AUTO, keeps DENY, and never reaches the DENY threshold by itself", () => {
    const two = detectAnomalies({ request: { merchant: "x.com", category: "design", createdAt: NIGHT_KST }, mandate: { categories: ["research"] }, recent: [], quietHours: SEOUL });
    expect(two.map((a) => a.code)).toEqual(["late_night", "off_mandate_category"]);
    expect(applyAnomalies("AUTO_APPROVE", 1, two)).toEqual({ final: "ASK_HUMAN", risk: 4, escalated: true });
    expect(applyAnomalies("ASK_HUMAN", 6, two)).toEqual({ final: "ASK_HUMAN", risk: 7, escalated: false });
    expect(applyAnomalies("DENY", 9, two)).toEqual({ final: "DENY", risk: 10, escalated: false });
    expect(applyAnomalies("AUTO_APPROVE", 1, [])).toEqual({ final: "AUTO_APPROVE", risk: 1, escalated: false });
  });

  it("web context reads REINS_QUIET_HOURS / REINS_TIMEZONE and fails closed to 'off' on bad values", () => {
    expect(quietHoursFromEnv({ REINS_TIMEZONE: "Asia/Seoul" })).toEqual(SEOUL);
    expect(quietHoursFromEnv({ REINS_TIMEZONE: "Asia/Seoul", REINS_QUIET_HOURS: "22-6" })).toEqual({ timeZone: "Asia/Seoul", startHour: 22, endHour: 6 });
    expect(quietHoursFromEnv({ REINS_QUIET_HOURS: "off" })).toBeNull();
    expect(quietHoursFromEnv({ REINS_QUIET_HOURS: "late" })).toBeNull();
    expect(quietHoursFromEnv({ REINS_TIMEZONE: "Mars/Olympus" })).toBeNull();
  });
});

describe("S3 in the purchase flow", () => {
  it("late-night request that would be AUTO is held for a human with a warning, and the auditor explains it", async () => {
    const auditor = recording();
    const h = await harness({ start: NIGHT_KST, overrides: { auditor, config: { quietHours: SEOUL } } });
    await h.vaulted();
    const devops = await h.agentClient("Claude Code - DevOps", devopsMandate);
    const r = await devops.call("request_purchase", renew(1));
    expect(r.data).toMatchObject({ status: "pending_human", decision: "ASK_HUMAN", risk: 2 });
    expect(r.data.anomalies).toEqual([{ code: "late_night", weight: 1, detail_en: "Requested at 02:30 (Asia/Seoul), inside quiet hours", detail_ko: "Asia/Seoul 기준 02:30 심야 요청" }]);
    expect(r.data.reason).toContain("Unusual pattern: Requested at 02:30 (Asia/Seoul), inside quiet hours.");
    expect(auditor.inputs[0]!.signals).toEqual([{ code: "late_night", detail: "Requested at 02:30 (Asia/Seoul), inside quiet hours" }]);
    expect(r.data.reason).toMatch(/quiet hours, when the user is unlikely to be watching/); // auditor's explanation

    const row = await getLedgerRow(h.ctx, r.data.request_id);
    expect(row.decisions.map((d) => `${d.stage}:${d.decision}`)).toEqual(["hard_rules:PASS", "llm:AUTO_APPROVE", "system:ASK_HUMAN"]);
    expect(row.decisions[2]).toMatchObject({ actor: "patterns", risk: 2, details: { escalated: true, auditor_risk: 1 } });

    // Telegram approval card and inbox item carry the warning
    expect(approvalCard(r.data as never, "Claude Code - DevOps", 30).text).toContain("Pattern alert: Requested at 02:30 (Asia/Seoul), inside quiet hours");
    const inbox = await h.admin("GET", "/api/inbox");
    expect(inbox.body.items[0].anomalies.map((a: { code: string }) => a.code)).toEqual(["late_night"]);
  });

  it("the same request at noon is paid automatically with no patterns", async () => {
    const h = await harness({ start: NOON_KST, overrides: { config: { quietHours: SEOUL } } });
    await h.vaulted();
    const devops = await h.agentClient("Claude Code - DevOps", devopsMandate);
    const r = await devops.call("request_purchase", renew(1));
    expect(r.data).toMatchObject({ status: "paid", decision: "AUTO_APPROVE", anomalies: [] });
  });

  it("4th request to the same merchant in a day is held; the first three are paid", async () => {
    const h = await harness({ start: NOON_KST });
    await h.vaulted();
    const devops = await h.agentClient("Claude Code - DevOps", devopsMandate);
    for (let i = 1; i <= 3; i++) {
      expect((await devops.call("request_purchase", renew(i))).data.status).toBe("paid");
      h.tick(61);
    }
    const fourth = await devops.call("request_purchase", renew(4));
    expect(fourth.data.status).toBe("pending_human");
    expect(fourth.data.anomalies.map((a: { code: string }) => a.code)).toEqual(["repeat_merchant"]);
    expect(fourth.data.reason).toContain("4th request to namecheap.com in 24 hours");
  });

  it("category outside the mandate is flagged; a hard-rule DENY still records the patterns on the blocked card", async () => {
    const h = await harness({ start: NOON_KST });
    const devops = await h.agentClient("Claude Code - DevOps", devopsMandate);
    const off = await devops.call("request_purchase", { ...renew(1), category: "design", items: "Logo refresh", client_request_id: "logo" });
    expect(off.data.status).toBe("pending_human");
    expect(off.data.anomalies.map((a: { code: string }) => a.code)).toEqual(["off_mandate_category"]);
    expect(off.data.risk).toBeLessThanOrEqual(7);

    h.tick();
    const denied = await devops.call("request_purchase", { merchant: "fiverr.com", amount: "450.00", items: "Premium logo package", reason: "Logo for the landing page", category: "design", client_request_id: "fiverr" });
    expect(denied.data).toMatchObject({ status: "denied", decision: "DENY" });
    expect(denied.data.anomalies.map((a: { code: string }) => a.code)).toEqual(["off_mandate_category"]);
    expect(blockedCard(denied.data as never, "Claude Code - DevOps").text).toContain('Pattern alert: Category "design" is outside the mandate');
  });

  it("tests and contexts without quiet hours never flag late-night requests", async () => {
    const h = await harness({ start: NIGHT_KST });
    await h.vaulted();
    const devops = await h.agentClient("Claude Code - DevOps", devopsMandate);
    expect((await devops.call("request_purchase", renew(1))).data.status).toBe("paid");
  });
});
