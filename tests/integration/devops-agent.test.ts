/**
 * S6 (#20) demo agent B: the DevOps cron agent checks the infra cost sheet and pays small due bills through the
 * Reins MCP tools. Runs in-process over an in-memory MCP transport (the CLI uses the stdio server instead).
 */
import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { loadBills, nextDue, runDevOpsCheck, type InfraBill } from "../../agents/devops/devops-agent.ts";
import { devopsMandate, harness } from "./harness.ts";

const NOV_1 = Date.parse("2026-11-01T00:30:00Z");
const bills: InfraBill[] = [
  { merchant: "render.com", item: "Render Starter web service (monthly)", amount: "7.00", due_day: 1, category: "hosting" },
  { merchant: "vercel.com", item: "Vercel Pro seat (monthly)", amount: "20.00", due_day: 2, category: "hosting" },
  { merchant: "render.com", item: "Render Postgres Pro (monthly)", amount: "55.00", due_day: 3, category: "hosting" },
  { merchant: "aws.amazon.com", item: "S3 storage", amount: "3.10", due_day: 1, category: "hosting" },
  { merchant: "anthropic.com", item: "Claude API credits top-up", amount: "25.00", due_day: 20, category: "api-credits" },
];

describe("S6 DevOps cron agent", () => {
  it("next due date: this month within a 2-day grace, otherwise next month", () => {
    expect(nextDue({ due_day: 3 }, NOV_1).toISOString().slice(0, 10)).toBe("2026-11-03");
    expect(nextDue({ due_day: 30 }, Date.parse("2026-11-01T10:00:00Z")).toISOString().slice(0, 10)).toBe("2026-11-30");
    expect(nextDue({ due_day: 1 }, Date.parse("2026-11-02T10:00:00Z")).toISOString().slice(0, 10)).toBe("2026-11-01");
    expect(nextDue({ due_day: 1 }, Date.parse("2026-11-05T10:00:00Z")).toISOString().slice(0, 10)).toBe("2026-12-01");
  });

  it("daily run pays the small due bills automatically, leaves big / off-mandate / not-due ones, and a rerun pays nothing twice", async () => {
    const h = await harness({ start: NOV_1 });
    await h.vaulted();
    const agent = await h.agentClient("Claude Code - DevOps", devopsMandate);

    const report = await runDevOpsCheck({ call: agent.call, bills, now: NOV_1 });
    expect(report.due).toBe(4);
    const by = (m: string, amount: string) => report.outcomes.find((o) => o.bill.merchant === m && o.bill.amount === amount)!;
    expect(by("render.com", "7.00")).toMatchObject({ action: "requested", status: "paid", due: "2026-11-01" });
    expect(by("vercel.com", "20.00")).toMatchObject({ action: "requested", status: "paid" });
    expect(by("render.com", "55.00")).toMatchObject({ action: "skipped", why: "$55.00 is above my $30.00 auto-approve limit; left for you" });
    expect(by("aws.amazon.com", "3.10")).toMatchObject({ action: "skipped", why: "aws.amazon.com is not in my mandate" });
    expect(report.outcomes.some((o) => o.bill.merchant === "anthropic.com")).toBe(false); // due on the 20th
    expect(report.lines[0]).toBe("Infra cost check: 4 of 5 bills due in the next 3 days ($85.10).");
    expect(report.lines.join("\n")).toContain("- render.com $7.00 (due 2026-11-01): Paid $7.00 to render.com");

    const ledger = await h.admin("GET", "/api/ledger");
    expect(ledger.body.rows.map((r: { merchant: string; status: string; decision: string }) => `${r.merchant}:${r.status}:${r.decision}`).sort()).toEqual(["render.com:paid:AUTO_APPROVE", "vercel.com:paid:AUTO_APPROVE"]);

    // the cron fires again later the same day: same idempotency keys, no new orders
    h.tick(60);
    const orders = h.ctx.paypal.calls.filter((c) => c === "createOrder").length;
    const again = await runDevOpsCheck({ call: agent.call, bills, now: h.now() });
    expect(again.outcomes.filter((o) => o.action === "requested").map((o) => (o as { status: string }).status)).toEqual(["paid", "paid"]);
    expect(h.ctx.paypal.calls.filter((c) => c === "createOrder").length).toBe(orders);
    expect((await h.admin("GET", "/api/ledger")).body.rows).toHaveLength(2);
  });

  it("--ask sends the big bill for human approval; a merchant rule (S5) lets it auto-pay next month", async () => {
    const h = await harness({ start: NOV_1 });
    await h.vaulted();
    const agent = await h.agentClient("Claude Code - DevOps", devopsMandate);
    const big = bills.filter((b) => b.amount === "55.00");
    const first = await runDevOpsCheck({ call: agent.call, bills: big, now: NOV_1, askAboveLimit: true });
    const o = first.outcomes[0] as { action: string; status: string; request_id: string };
    expect(o).toMatchObject({ action: "requested", status: "pending_human" });

    await h.admin("POST", `/api/requests/${o.request_id}/decision`, { action: "approve", allow_merchant: true });
    const dec1 = Date.parse("2026-12-01T00:30:00Z");
    const next = await runDevOpsCheck({ call: agent.call, bills: big, now: dec1 });
    expect(next.outcomes[0]).toMatchObject({ action: "requested", status: "paid", due: "2026-12-03" });
  });

  it("omits categories the mandate does not know (avoids an off-mandate pattern flag) and reports a missing mandate", async () => {
    const h = await harness({ start: NOV_1 });
    await h.vaulted();
    const agent = await h.agentClient("Claude Code - DevOps", { ...devopsMandate, categories: ["infrastructure"] });
    const r = await runDevOpsCheck({ call: agent.call, bills: bills.slice(0, 1), now: NOV_1 });
    expect(r.outcomes[0]).toMatchObject({ action: "requested", status: "paid" });

    const fail = await runDevOpsCheck({ call: async () => ({ text: "Reins error - no_mandate: No mandate configured", data: undefined, isError: true }), bills, now: NOV_1 });
    expect(fail.lines).toEqual(["Could not read the Reins mandate: Reins error - no_mandate: No mandate configured"]);
  });

  it("ships a valid demo cost sheet", () => {
    const sheet = loadBills(resolve(import.meta.dirname, "../../agents/devops/infra-costs.json"));
    expect(sheet.length).toBeGreaterThanOrEqual(3);
    expect(sheet.every((b) => b.due_day >= 1 && b.due_day <= 28)).toBe(true);
  });
});
