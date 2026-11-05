/** S1 overview dashboard: aggregation against the seeded demo DB, and the AI weekly summary fallback/caching. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, migrateDb, type ReinsDb } from "@reins/db";
import {
  ClaudeWeeklySummarizer,
  buildWeeklySummaryInput,
  formatUsd,
  getOverview,
  getWeeklySummary,
  isoWeekStartUtc,
  templateSummary,
  type MessagesParseClient,
  type WeeklySummarizer,
  type WeeklySummaryInput,
} from "@reins/core";
import { createTestContext } from "@reins/core/testing";
import { createRouter } from "../../apps/web/src/server/router.ts";
import { seedDemo } from "../../scripts/seed.ts";

const dir = mkdtempSync(join(tmpdir(), "reins-overview-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let db: ReinsDb;
beforeAll(async () => {
  db = createDb(`file:${join(dir, "seed.db")}`);
  await migrateDb(db);
  await seedDemo(db);
});

describe("S1 overview aggregation (seeded demo)", () => {
  it("shows the plan's flow C numbers, per-agent caps, categories and the fiverr block", async () => {
    const o = await getOverview(await createTestContext({ db }));
    expect(`This month ${formatUsd(o.totals.spent_cents)} of ${formatUsd(o.totals.limit_cents)} across ${o.totals.agents} agents`).toBe("This month $117.97 of $410.00 across 3 agents");
    expect(o.totals.pct).toBe(29);
    expect(o.agents.map((a) => [a.name, formatUsd(a.spent_cents), formatUsd(a.limit_cents!)])).toEqual([
      ["Claude Code – DevOps", "$94.95", "$150.00"],
      ["Research Scout", "$9.00", "$100.00"],
      ["Desk Restock Bot", "$14.02", "$160.00"],
    ]);
    expect(o.agents.map((a) => a.pct)).toEqual([63, 9, 9]);
    // the seed pauses one agent: the headline must say so instead of claiming everything is fine
    expect(o.status.level).toBe("warn");
    expect(o.status.message).toMatch(/is paused$/);

    // plan flow C: 24 requests this month, Auto 19 (incl. the declined card) · Human 4 (1 pending) · Blocked 1
    expect(o.decisions).toEqual({ total: 24, auto: 19, human: 4, blocked: 1, pending: 1 });
    expect(o.approvals_saved).toBe(20);

    // S2 "Money protected": every figure derives from the ledger above, the only assumption is 30 s per approval
    expect(o.protection).toMatchObject({ exposure_cents: 41000, exposure_agents: 3, blocked_cents: 45000, blocked_count: 1, auto_paid: 19, requests: 24, minutes_saved: 10, seconds_per_approval: 30, demo_data: true });
    expect(o.protection.blocked_top).toMatchObject({ display_id: "R-0143", merchant: "fiverr.com", amount_cents: 45000 });
    expect(o.protection.blocked_top!.rules_failed).toBe(3);

    expect(o.categories).toEqual([
      { category: "infrastructure", cents: 9495 },
      { category: "office", cents: 1402 },
      { category: "research", cents: 900 },
    ]);
    expect(o.categories.reduce((s, c) => s + c.cents, 0)).toBe(o.totals.spent_cents);

    expect(o.recent).toHaveLength(8);
    expect(o.recent[0]).toMatchObject({ merchant: "fiverr.com", display_id: "R-0143" });
    expect(o.recent[1]).toMatchObject({ merchant: "statista.com", status: "pending_human", display_id: "R-0142" });
    const fiverr = o.recent.find((r) => r.merchant === "fiverr.com")!;
    expect(fiverr).toMatchObject({ amount_cents: 45000, outcome: "blocked", via: "hard rules", agent_name: "Research Scout" });
    expect(o.recent.find((r) => r.merchant === "vercel.com" && r.status === "paid")).toMatchObject({ outcome: "human", via: "approved via telegram", status: "paid" });
  });

  it("is served by GET /api/overview", async () => {
    const ctx = await createTestContext({ db });
    const res = await createRouter(async () => ctx)(new Request("http://localhost/api/overview"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { totals: { spent_cents: number } };
    expect(body.totals.spent_cents).toBe(11797);
  });

  it("period toggle: last 30 days widens spend, decisions and categories; caps and status stay month to date", async () => {
    const ctx = await createTestContext({ db });
    const month = await getOverview(ctx);
    const rolling = await getOverview(ctx, "30d");
    expect(month.period.kind).toBe("month");
    expect(rolling.period.kind).toBe("30d");
    expect(Date.parse(rolling.period.now) - Date.parse(rolling.period.start)).toBe(30 * 86_400_000);
    expect(rolling.period.month_start).toBe(month.period.month_start);
    // monthly caps and the status chip do not depend on the toggle
    expect(rolling.agents).toEqual(month.agents);
    expect(rolling.totals.limit_cents).toBe(month.totals.limit_cents);
    expect(rolling.status).toEqual(month.status);
    // totals, categories and decisions all count from the same start, so they stay consistent with each other
    expect(rolling.categories.reduce((s, c) => s + c.cents, 0)).toBe(rolling.totals.spent_cents);
    // (a month longer than 30 days can lose its first days in the rolling window, so only sanity-check the totals)
    expect(rolling.decisions.total).toBeGreaterThan(0);
    expect(rolling.decisions.total).toBeLessThanOrEqual(24);

    const res = await createRouter(async () => ctx)(new Request("http://localhost/api/overview?period=30d"));
    expect(((await res.json()) as { period: { kind: string } }).period.kind).toBe("30d");
    const bad = await createRouter(async () => ctx)(new Request("http://localhost/api/overview?period=year"));
    expect(((await bad.json()) as { period: { kind: string } }).period.kind).toBe("month");
  });

  it("ledger rows carry the request category for the donut -> ledger filter", async () => {
    const ctx = await createTestContext({ db });
    const res = await createRouter(async () => ctx)(new Request("http://localhost/api/ledger?limit=500"));
    const rows = ((await res.json()) as { rows: Array<{ category: string | null; status: string; amount: string; created_at: string }> }).rows;
    const o = await getOverview(ctx);
    const since = Date.parse(o.period.start);
    const research = rows.filter((r) => r.category === "research" && Date.parse(r.created_at) >= since && ["approved", "awaiting_buyer", "paying", "paid"].includes(r.status));
    expect(Math.round(research.reduce((s, r) => s + Number(r.amount), 0) * 100)).toBe(o.categories.find((c) => c.category === "research")!.cents);
  });

  it("empty workspace: zeros, no agents, no feed", async () => {
    const o = await getOverview(await createTestContext());
    expect(o.totals).toEqual({ spent_cents: 0, limit_cents: 0, agents: 0, pct: 0 });
    expect(o.recent).toEqual([]);
    expect(o.categories).toEqual([]);
    expect(o.status.message).toBe("No agents yet");
  });
});

describe("S1 AI weekly summary", () => {
  it("weeks start on Monday UTC", () => {
    expect(new Date(isoWeekStartUtc(Date.UTC(2026, 9, 31, 15))).toISOString()).toBe("2026-10-26T00:00:00.000Z");
    expect(new Date(isoWeekStartUtc(Date.UTC(2026, 9, 26, 0, 5))).toISOString()).toBe("2026-10-26T00:00:00.000Z");
    expect(new Date(isoWeekStartUtc(Date.UTC(2026, 10, 1, 23))).toISOString()).toBe("2026-10-26T00:00:00.000Z");
  });

  it("feeds the model aggregates only: no ids, keys, emails or agent free text", async () => {
    const { input, action } = await buildWeeklySummaryInput(await createTestContext({ db }));
    const text = JSON.stringify(input);
    expect(text).not.toMatch(/rk_|FAKE-|agt_|req_|@|vault|Instructed by page/i);
    expect(input.blocked_this_month[0]).toMatchObject({ merchant: "fiverr.com", amount: "450.00", stage: "hard_rules", suspected_prompt_injection: true, agent: "Research Scout" });
    expect(action).toMatchObject({ merchant: "fiverr.com", agent_name: "Research Scout", cap_failed: true });
  });

  it("without Claude uses the labelled template and names the fiverr injection", async () => {
    const s = await getWeeklySummary(await createTestContext({ db }));
    expect(s).toMatchObject({ source: "template", provider: "template", fallback_reason: "Claude is off" });
    expect(s.warning).toMatch(/One request was blocked \(fiverr\.com, \$450\.00\) and looked like prompt injection/);
    expect(s.warning).toMatch(/Research Scout/);
    // the first story a judge sees: a real week of spending, not "Quiet week so far".
    // On the 1st of a month that is not a Monday the ISO week began last month and the seed only has the month's first
    // hours (see the "any day" seed test), so the week figures equal the month figures that day.
    const now = new Date();
    if (now.getUTCDate() !== 1 || now.getUTCDay() === 1) {
      expect(s.summary).toMatch(/^This week your agents spent \$84\.98 across 6 purchases\. Claude Code – DevOps is closest to its cap at 63%\./);
      expect(s.stats).toMatchObject({ week_spent_cents: 8498, week_purchases: 6 });
    }
    expect(s.action).toMatchObject({ display_id: "R-0143", merchant: "fiverr.com" });
  });

  it("Claude error or bad output falls back to the template, and the success path is cached", async () => {
    let calls = 0;
    const failing: WeeklySummarizer = { name: "claude:test", summarize: async () => { calls++; throw new Error("overloaded"); } };
    const ctx = await createTestContext({ db });
    ctx.summarizer = failing;
    const s = await getWeeklySummary(ctx);
    expect(s).toMatchObject({ source: "template", fallback_reason: "Claude was unavailable" });
    expect(s.summary.length).toBeGreaterThan(10);

    const ok: WeeklySummarizer = { name: "claude:test-ok", summarize: async () => { calls++; return { summary: "Quiet week.", warning: null }; } };
    ctx.summarizer = ok;
    calls = 0;
    const a = await getWeeklySummary(ctx);
    const b = await getWeeklySummary(ctx);
    expect(a).toMatchObject({ source: "claude", provider: "claude:test-ok", summary: "Quiet week." });
    expect(b.generated_at).toBe(a.generated_at);
    expect(calls).toBe(1);

    const garbage: WeeklySummarizer = { name: "claude:garbage", summarize: async () => ({ summary: "", warning: null }) };
    ctx.summarizer = garbage;
    expect((await getWeeklySummary(ctx)).source).toBe("template");
  });

  it("ClaudeWeeklySummarizer sends the pinned model and structured output, and treats refusal as failure", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const stub = (out: unknown): MessagesParseClient =>
      ({ messages: { parse: async (body: Record<string, unknown>) => { seen.push(body); return out; } } }) as unknown as MessagesParseClient;
    const input = (await buildWeeklySummaryInput(await createTestContext({ db }))).input;
    const s = new ClaudeWeeklySummarizer({ client: stub({ stop_reason: "end_turn", parsed_output: { summary: "ok", warning: null } }) });
    expect(await s.summarize(input)).toEqual({ summary: "ok", warning: null });
    expect(seen[0]).toMatchObject({ model: "claude-opus-5-5" });
    const refused = new ClaudeWeeklySummarizer({ client: stub({ stop_reason: "refusal", parsed_output: null }) });
    await expect(refused.summarize(input)).rejects.toThrow(/refused/);
  });

  it("template covers a quiet week and a near-cap agent", () => {
    const base: WeeklySummaryInput = {
      week_start: "2026-10-26", week_end: "2026-11-01",
      week: { spent: "0.00", purchases: 0, requests: 0, needed_human: 0, blocked: 0 },
      month: { spent: "90.00", limit: "100.00", purchases: 3 },
      agents: [{ name: "Scout", month_spent: "90.00", monthly_limit: "100.00", cap_used_pct: 90, week_spent: "0.00" }],
      top_merchants_week: [], blocked_this_month: [],
    };
    const t = templateSummary(base);
    expect(t.summary).toBe("Quiet week so far: no purchases. This month your agents spent $90.00 of $100.00 across 3 purchases. Scout is closest to its cap at 90%.");
    expect(t.warning).toMatch(/Scout has used 90%/);
  });
});
