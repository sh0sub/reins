/** M13 demo seed: counts, the plan's flow C dashboard line, outcome mix, idempotency and the non-seed guard. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createDb, getWorkspace, insertAgent, listAgents, listDecisions, listRequests, migrateDb, getPaymentByRequest, type ReinsDb } from "@reins/db";
import { displayId, formatUsd, getWeeklySummary, generateApiKey, getLedger, getRequestDetail, listAgentSummaries } from "@reins/core";
import { createTestContext } from "@reins/core/testing";
import { SEED_KEY_PREFIX, SeedRefusal, dashboardTotals, seedDemo, seedIfEmpty } from "../../scripts/seed.ts";

const dir = mkdtempSync(join(tmpdir(), "reins-seed-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function tempDb(name: string): Promise<ReinsDb> {
  const db = createDb(`file:${join(dir, name)}`);
  await migrateDb(db);
  return db;
}

describe("M13 seed", () => {
  it("creates 3 agents, 3 mandates, 24 requests and the plan's dashboard numbers", async () => {
    const db = await tempDb("a.db");
    const r = await seedDemo(db);
    expect(r).toMatchObject({ agents: 3, mandates: 3, requests: 24, replaced: 0 });

    const ctx = await createTestContext({ db });
    const summaries = await listAgentSummaries(ctx);
    expect(summaries).toHaveLength(3);
    // Research Scout: v1 created with the agent, v2 (+huggingface.co, snapshot for R-0143), v3 blocks fiverr.com
    expect(Object.fromEntries(summaries.map((s) => [s.name, s.mandate_version]))).toEqual({ "Claude Code – DevOps": 1, "Research Scout": 3, "Desk Restock Bot": 1 });

    // same query as the dashboard: per-agent month spend + active mandate limits
    const totals = await dashboardTotals(db);
    expect(`This month ${formatUsd(totals.spentCents)} of ${formatUsd(totals.limitCents)} across ${totals.agents} agents`).toBe("This month $117.97 of $410.00 across 3 agents");
    expect(summaries.reduce((s, a) => s + a.month_spent_cents, 0)).toBe(11797);
    expect(summaries.reduce((s, a) => s + (a.monthly_limit_cents ?? 0), 0)).toBe(41000);
  });

  it("connects the demo merchant only when asked (public demo), keeping local seeds unconnected", async () => {
    const plain = await tempDb("ws-plain.db");
    await seedDemo(plain);
    expect((await getWorkspace(plain)).connectedAt).toBeNull();

    const pub = await tempDb("ws-public.db");
    await seedIfEmpty(pub, { connectDemoMerchant: true });
    const ws = await getWorkspace(pub);
    expect(ws.connectedAt).not.toBeNull();
    expect(ws).toMatchObject({ paypalEnv: "fake", merchantEmail: "sb-merchant-demo@business.example.com" });
  });

  it("covers every decision outcome, last month and this month, with consistent trails", async () => {
    const db = await tempDb("b.db");
    await seedDemo(db);
    const rows = await listRequests(db, { limit: 100 });
    expect(rows).toHaveLength(24);
    const by = (s: string) => rows.filter((x) => x.status === s).length;
    expect(by("paid")).toBeGreaterThanOrEqual(10);
    expect(by("pending_human")).toBe(1);
    expect(by("expired")).toBe(1);
    expect(by("failed")).toBe(1);
    expect(by("denied")).toBe(2); // fiverr (hard rules) + the rejected lamp
    expect(by("paid")).toBe(19); // 18 auto + the approved $59
    // all 24 requests are this month (plan: "This month ... 24 requests")
    expect(new Set(rows.map((x) => new Date(x.createdAt).getUTCMonth())).size).toBe(1);
    expect(rows.every((x) => x.createdAt <= Date.now())).toBe(true);

    const ledger = await getLedger(await createTestContext({ db }), { limit: 100 });
    const stages = (id: string) => ledger.find((l) => l.request_id === id)!.decisions.map((d) => `${d.stage}:${d.decision}`);
    const kinds = new Set<string>();
    for (const r of rows) {
      const trail = stages(r.id).join(",");
      if (r.status === "denied" && trail.startsWith("hard_rules:DENY")) kinds.add("hard");
      else if (r.status === "denied" && trail.includes("human:DENY")) kinds.add("human_rejected");
      else if (r.status === "denied" && trail.includes("llm:DENY")) kinds.add("auditor");
      else if (r.status === "paid" && trail.includes("human:APPROVE")) kinds.add("human_approved");
      else if (r.status === "paid" && trail.includes("llm:AUTO_APPROVE")) kinds.add("auto");
      if (r.status === "paid") {
        const p = await getPaymentByRequest(db, r.id);
        expect(p).toMatchObject({ status: "completed", amountCents: r.amountCents });
        expect(p!.captureId).toMatch(/^FAKE-CAPTURE-/);
      }
      expect((await listDecisions(db, r.id)).length).toBeGreaterThan(0);
    }
    expect([...kinds].sort()).toEqual(["auto", "hard", "human_approved", "human_rejected"]);

    // video act 3: fiverr $450 blocked by 3 failing hard rules with an explanation
    const fiverr = rows.find((x) => x.merchant === "fiverr.com")!;
    expect(fiverr.amountCents).toBe(45000);
    expect(ledger.find((l) => l.request_id === fiverr.id)!.decisions[0]!.details).toMatchObject({ results: expect.any(Array) });
    expect(fiverr.reasonEn).toMatch(/prompt injection/);
    expect(displayId(fiverr.seq)).toBe("R-0143"); // the plan's R-0143, and the pending approval is R-0142
    expect(displayId(rows.find((x) => x.status === "pending_human")!.seq)).toBe("R-0142");
    // S6 "Model: Claude · 412 tokens · 1.9 s"
    const fiverrDetail = await getRequestDetail(await createTestContext({ db }), fiverr.id);
    expect(fiverrDetail.auditor).toMatchObject({ provider: expect.stringMatching(/^claude:/), tokens: 412, latency_ms: 1900 });
    expect(fiverrDetail.mandate!.version).toBe(2); // v2 was the snapshot when R-0143 was blocked
    // video flow B: the pending card R-0142 is Research Scout, statista.com, $59 "Agentic Commerce 2026"
    const pending = rows.find((x) => x.status === "pending_human")!;
    expect(pending).toMatchObject({ merchant: "statista.com", amountCents: 5900, items: 'Report "Agentic Commerce 2026" (PDF)' });
    expect(rows.filter((x) => x.merchant === "statista.com" && x.amountCents === 5900)).toHaveLength(1);
    // the human-approved $59 this week is DevOps' Vercel seat
    const approved = rows.find((x) => x.merchant === "vercel.com" && x.amountCents === 5900)!;
    expect(approved.status).toBe("paid");
  });

  it("is re-runnable, and refuses a DB with non-seed data unless --force", async () => {
    const db = await tempDb("c.db");
    await seedDemo(db);
    const again = await seedDemo(db);
    expect(again).toMatchObject({ agents: 3, requests: 24, replaced: 3 });
    expect(await listAgents(db)).toHaveLength(3);
    expect(await listRequests(db, { limit: 100 })).toHaveLength(24);

    const k = generateApiKey();
    await insertAgent(db, { name: "Real agent", keyHash: k.hash, keyPrefix: k.displayPrefix });
    await expect(seedDemo(db)).rejects.toBeInstanceOf(SeedRefusal);
    expect(await listAgents(db)).toHaveLength(4);

    await seedDemo(db, { force: true });
    const names = (await listAgents(db)).map((a) => a.name);
    expect(names).toContain("Real agent");
    expect(names).toHaveLength(4);
    expect((await listAgents(db)).filter((a) => a.keyPrefix.startsWith(SEED_KEY_PREFIX))).toHaveLength(3);
  });

  it("#38 first-boot --if-empty: seeds an empty DB once, then never touches it again (seed rows or real data)", async () => {
    const db = await tempDb("d.db");
    const first = await seedIfEmpty(db);
    expect(first).toMatchObject({ agents: 3, mandates: 3, requests: 24, replaced: 0 });
    const totals = await dashboardTotals(db);
    expect(`${formatUsd(totals.spentCents)} of ${formatUsd(totals.limitCents)}`).toBe("$117.97 of $410.00");
    const ids = (await listAgents(db)).map((a) => a.id);

    expect(await seedIfEmpty(db)).toBeNull(); // restart / redeploy: no re-seed
    expect((await listAgents(db)).map((a) => a.id)).toEqual(ids);

    const real = await tempDb("e.db");
    const k = generateApiKey();
    await insertAgent(real, { name: "Real agent", keyHash: k.hash, keyPrefix: k.displayPrefix });
    expect(await seedIfEmpty(real)).toBeNull();
    expect(await listRequests(real, { limit: 10 })).toHaveLength(0);
  });

  it("S7 first story holds on any day: $84.98 over 6 purchases this ISO week, 24 requests, no hard-rule mismatch", async () => {
    // mid-week, Monday morning (little room), the 13th (judging time) and the first day of a month
    for (const iso of ["2026-11-11T12:00:00Z", "2026-11-09T06:00:00Z", "2026-11-13T09:00:00Z", "2026-12-01T10:00:00Z"]) {
      const now = Date.parse(iso);
      const db = await tempDb(`now-${iso.slice(0, 10)}.db`);
      const r = await seedDemo(db, { now });
      expect(r).toMatchObject({ requests: 24, thisMonthSpentCents: 11797 });
      const s = await getWeeklySummary(await createTestContext({ db, now: () => now }));
      if (iso.startsWith("2026-12-01")) continue; // the week began in November: Dec 1 only has the month's first hours
      expect(s.stats, iso).toMatchObject({ week_spent_cents: 8498, week_purchases: 6 });
    }
  });
});
