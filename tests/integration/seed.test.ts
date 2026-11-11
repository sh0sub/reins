/**
 * Demo seed: it replays the recorded real sandbox run (scripts/demo/fixtures/real-sandbox-run.json) and invents nothing.
 * No FAKE ids, no fabricated "matched", no Claude attribution the run did not record, no human clicks, no Q&A thread.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createDb, getWorkspace, insertAgent, updateWorkspace, listAgents, listDecisions, listRequests, migrateDb, getPaymentByRequest, type ReinsDb } from "@reins/db";
import { decideRequest, displayId, formatUsd, generateApiKey, getLedger, getRequestDetail, getReceipt, listAgentSummaries, reconcileNow } from "@reins/core";
import { createTestContext } from "@reins/core/testing";
import { FIXTURE_PATH, SEED_KEY_PREFIX, SeedRefusal, dashboardTotals, loadFixture, seedDemo, seedIfEmpty, seedPaymentMode } from "../../scripts/seed.ts";

const dir = mkdtempSync(join(tmpdir(), "reins-seed-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function tempDb(name: string): Promise<ReinsDb> {
  const db = createDb(`file:${join(dir, name)}`);
  await migrateDb(db);
  return db;
}

const run = loadFixture();
const paidCents = run.requests.filter((r) => r.status === "paid").reduce((s, r) => s + r.amount_cents, 0);
const recordedLlm = run.requests.flatMap((r) => r.decisions.filter((d) => d.stage === "llm"));

describe("the committed fixture is a real recorded run, safe to publish", () => {
  const text = readFileSync(FIXTURE_PATH, "utf8");

  it("has no e-mail address, key, token, vault id or simulated id", () => {
    expect(text).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    expect(text).not.toMatch(/rk_(live|demo)_|access_token|Bearer |VAULT-|FAKE-|SIM-/);
  });

  it("every payment carries real PayPal sandbox ids (payout batch + transaction), none invented", () => {
    const pays = run.requests.flatMap((r) => (r.payment ? [r.payment] : []));
    expect(pays.length).toBeGreaterThan(0);
    for (const p of pays) {
      expect(p.strategy).toBe("treasury");
      expect(p.payout_batch_id).toMatch(/^[A-Z0-9]{13}$/);
      if (p.status === "completed") expect(p.capture_id).toMatch(/^[A-Z0-9]{17}$/);
      // "matched" only when Transaction Search really returned it, with the transaction id in the note
      if (p.reconciled === "matched") expect(p.reconcile_note).toContain(p.capture_id);
    }
  });

  it("every auditor decision was made by the Claude model it names (tokens and latency recorded), none by a stand-in", () => {
    expect(recordedLlm.length).toBeGreaterThanOrEqual(10);
    for (const d of recordedLlm) {
      expect(d.actor).toMatch(/^claude:claude-/);
      expect(d.details).toMatchObject({ provider: d.actor, failed: false, tokens: expect.any(Number), latency_ms: expect.any(Number) });
    }
    expect(run.requests.every((r) => r.decisions.every((d) => d.stage !== "human"))).toBe(true);
  });

  it("keeps the story beats: $12.98 paid without a human, $59 waits for one, $450 injection denied by the hard rules", () => {
    const by = (m: string, c: number) => run.requests.find((r) => r.merchant === m && r.amount_cents === c)!;
    expect(by("namecheap.com", 1298).status).toBe("paid");
    expect(by("statista.com", 5900)).toMatchObject({ status: "pending_human", final_decision: "ASK_HUMAN", display_id: "R-0142" });
    const fiverr = by("fiverr.com", 45000);
    expect(fiverr).toMatchObject({ status: "denied", final_decision: "DENY", display_id: "R-0143" });
    expect(fiverr.decisions[0]).toMatchObject({ stage: "hard_rules", decision: "DENY" });
  });
});

describe("seed replays the recorded run", () => {
  it("3 agents with their mandates; the ledger is the recorded rows with the recorded ids, decisions and actors", async () => {
    const db = await tempDb("a.db");
    const now = Date.parse("2026-11-12T15:00:00Z");
    const r = await seedDemo(db, { now });
    expect(r).toMatchObject({ agents: 3, mandates: 3, requests: run.requests.length, replaced: 0, thisMonthSpentCents: paidCents, thisMonthLimitCents: 41000 });

    const ctx = await createTestContext({ db, now: () => now });
    const summaries = await listAgentSummaries(ctx);
    // Research Scout: v1, v2 (+huggingface.co) during the run, v3 (blocks fiverr.com) configured after it
    expect(Object.fromEntries(summaries.map((s) => [s.name, s.mandate_version]))).toEqual({ "Claude Code – DevOps": 1, "Research Scout": 3, "Desk Restock Bot": 1 });
    const totals = await dashboardTotals(db, now);
    expect(`This month ${formatUsd(totals.spentCents)} of ${formatUsd(totals.limitCents)} across ${totals.agents} agents`).toBe(`This month ${formatUsd(paidCents)} of $410.00 across 3 agents`);

    const rows = await listRequests(db, { limit: 100 });
    const ledger = await getLedger(ctx, { limit: 100 });
    for (const rec of run.requests) {
      const row = rows.find((x) => displayId(x.seq) === rec.display_id)!;
      expect(row, rec.display_id).toMatchObject({ merchant: rec.merchant, amountCents: rec.amount_cents, status: rec.status, finalDecision: rec.final_decision, reasonEn: rec.reason_en });
      const decisions = await listDecisions(db, row.id);
      expect(decisions.map((d) => [d.stage, d.decision, d.actor, d.reasonEn])).toEqual(rec.decisions.map((d) => [d.stage, d.decision, d.actor, d.reason_en]));
      const p = await getPaymentByRequest(db, row.id);
      if (!rec.payment) expect(p).toBeUndefined();
      else expect(p).toMatchObject({ payoutBatchId: rec.payment.payout_batch_id, captureId: rec.payment.capture_id, status: rec.payment.status, reconciled: rec.payment.reconciled });
      // every row says it is recorded, with the real time and the shift
      expect(ledger.find((l) => l.request_id === row.id)!.recorded).toMatchObject({ recorded_at: new Date(rec.decisions[0]!.created_at).toISOString(), time_shift_ms: expect.any(Number) });
    }
  });

  it("invents nothing: no FAKE ids, no fabricated matched, every Claude actor is a recorded Claude call, no human clicks or threads", async () => {
    const db = await tempDb("b.db");
    await seedDemo(db);
    const ctx = await createTestContext({ db });
    const ledger = await getLedger(ctx, { limit: 100 });
    for (const row of ledger) {
      if (row.payment) {
        expect(row.payment.capture_id ?? row.payment.payout_batch_id).not.toMatch(/^(FAKE|SIM)-/);
        if (row.payment.reconciled === "matched") expect(row.payment.reconcile_note).toContain(row.payment.capture_id);
      }
      for (const d of row.decisions) {
        if (d.actor?.startsWith("claude")) expect(recordedLlm.some((x) => x.actor === d.actor && x.reason_en === d.reasonEn)).toBe(true);
        expect(d.stage).not.toBe("human");
      }
      expect(row.messages).toEqual([]);
    }
    expect(ledger.filter((l) => l.payment?.reconciled === "matched").length).toBe(run.requests.filter((r) => r.payment?.reconciled === "matched").length);
  });

  it("times are shifted by one offset: the run ends just before now and keeps its own spacing", async () => {
    const db = await tempDb("c.db");
    const now = Date.parse("2026-11-20T09:30:00Z");
    await seedDemo(db, { now });
    const rows = (await listRequests(db, { limit: 100 })).sort((a, b) => a.createdAt - b.createdAt);
    const recs = [...run.requests].sort((a, b) => a.created_at - b.created_at);
    const shift = rows[0]!.createdAt - recs[0]!.created_at;
    rows.forEach((row, i) => expect(row.createdAt - recs[i]!.created_at).toBe(shift));
    expect(Math.max(...rows.map((r) => r.updatedAt))).toBeLessThanOrEqual(now - 60_000);
    expect(Math.max(...rows.map((r) => r.updatedAt))).toBeGreaterThan(now - 10 * 60_000);
  });

  it("story rows on the hosted ledger: R-0143 fiverr denied (v2 snapshot, Claude explains), R-0142 statista waits for a person", async () => {
    const db = await tempDb("d.db");
    await seedDemo(db);
    const ctx = await createTestContext({ db });
    const rows = await listRequests(db, { limit: 100 });
    const fiverr = rows.find((x) => x.merchant === "fiverr.com")!;
    expect(displayId(fiverr.seq)).toBe("R-0143");
    const detail = await getRequestDetail(ctx, fiverr.id);
    expect(detail.mandate!.version).toBe(2);
    expect(detail.auditor).toMatchObject({ provider: expect.stringMatching(/^claude:claude-/), advisory: true });
    const pending = rows.find((x) => x.status === "pending_human" && x.merchant === "statista.com")!;
    expect(displayId(pending.seq)).toBe("R-0142");
    // a paid row's receipt carries the real PayPal ids and the recorded marker
    const paid = rows.find((x) => x.status === "paid")!;
    const receipt = await getReceipt(ctx, paid.id);
    expect(receipt.payment.strategy).toBe("treasury");
    expect(receipt.payment.payout_batch_id).toMatch(/^[A-Z0-9]{13}$/);
    expect(receipt.recorded).not.toBeNull();
  });

  it("Reconcile now leaves the recorded rows alone (their state is what PayPal said when recorded)", async () => {
    const db = await tempDb("e.db");
    await seedDemo(db, { connectDemoMerchant: true, env: { PAYPAL_ENV: "fake" } });
    const ctx = await createTestContext({ db });
    const before = await getLedger(ctx, { limit: 100 });
    const r = await reconcileNow(ctx, { start: Date.now() - 31 * 86_400_000, env: {} });
    expect(r).toMatchObject({ mode: "paypal", checked: 0, skipped: before.filter((l) => l.payment?.status === "completed").length });
    expect((await getLedger(ctx, { limit: 100 })).map((l) => l.payment?.reconciled)).toEqual(before.map((l) => l.payment?.reconciled));
  });

  it("approving the recorded pending R-0142 on the demo is live: chip says recorded + live, its payment is reconciled", async () => {
    const db = await tempDb("live.db");
    await seedDemo(db, { connectDemoMerchant: true, env: { PAYPAL_ENV: "fake" } });
    const ctx = await createTestContext({ db, config: { approvalTtlMs: 7 * 86_400_000 } });
    await updateWorkspace(db, { paymentMode: "vaulted", vaultId: "VAULT-TEST" });
    const pending = (await listRequests(db, { limit: 100 })).find((x) => x.status === "pending_human")!;
    const before = (await getLedger(ctx, { limit: 100 })).find((l) => l.request_id === pending.id)!;
    expect(before.recorded).toMatchObject({ live_after: false });
    expect((await decideRequest(ctx, pending.id, "approve", "web")).status).toBe("paid");
    const after = (await getLedger(ctx, { limit: 100 })).find((l) => l.request_id === pending.id)!;
    expect(after.recorded).toMatchObject({ live_after: true });
    const r = await reconcileNow(ctx, { start: Date.now() - 31 * 86_400_000, env: {} });
    expect(r).toMatchObject({ mode: "paypal", checked: 1 }); // the live payment, not the recorded ones
  });

  it("connects the demo merchant only when asked; hosted treasury mode only with a payee address", async () => {
    const plain = await tempDb("ws-plain.db");
    await seedDemo(plain);
    expect((await getWorkspace(plain)).connectedAt).toBeNull();

    const pub = await tempDb("ws-public.db");
    await seedIfEmpty(pub, { connectDemoMerchant: true, env: { PAYPAL_ENV: "fake" } });
    expect(await getWorkspace(pub)).toMatchObject({ paypalEnv: "fake", merchantEmail: "sb-merchant-demo@business.example.com", paymentMode: "supervised" });

    expect(seedPaymentMode({ PAYPAL_PAYMENT_MODE: "treasury", TREASURY_PAYEE_EMAIL: "payee@personal.example.com" })).toBe("treasury");
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      expect(seedPaymentMode({ PAYPAL_PAYMENT_MODE: "treasury" })).toBe("supervised");
    } finally {
      console.warn = warn;
    }
    expect(seedPaymentMode({ PAYPAL_PAYMENT_MODE: "vaulted" })).toBe("supervised");
  });

  it("--config-only: agents and mandates (Scout v1+v2), no history, nobody paused", async () => {
    const db = await tempDb("cfg.db");
    const r = await seedDemo(db, { configOnly: true });
    expect(r).toMatchObject({ agents: 3, requests: 0 });
    expect(await listRequests(db, { limit: 10 })).toHaveLength(0);
    expect((await listAgents(db)).every((a) => a.pausedAt == null)).toBe(true);
  });

  it("is re-runnable, and refuses a DB with non-seed data unless --force", async () => {
    const db = await tempDb("f.db");
    await seedDemo(db);
    const again = await seedDemo(db);
    expect(again).toMatchObject({ agents: 3, requests: run.requests.length, replaced: 3 });
    expect(await listAgents(db)).toHaveLength(3);

    const k = generateApiKey();
    await insertAgent(db, { name: "Real agent", keyHash: k.hash, keyPrefix: k.displayPrefix });
    await expect(seedDemo(db)).rejects.toBeInstanceOf(SeedRefusal);
    await seedDemo(db, { force: true });
    const names = (await listAgents(db)).map((a) => a.name);
    expect(names).toContain("Real agent");
    expect((await listAgents(db)).filter((a) => a.keyPrefix.startsWith(SEED_KEY_PREFIX))).toHaveLength(3);
  });

  it("#38 first-boot --if-empty: seeds an empty DB once, then never touches it again", async () => {
    const db = await tempDb("g.db");
    expect(await seedIfEmpty(db)).toMatchObject({ agents: 3, requests: run.requests.length, replaced: 0 });
    const ids = (await listAgents(db)).map((a) => a.id);
    expect(await seedIfEmpty(db)).toBeNull();
    expect((await listAgents(db)).map((a) => a.id)).toEqual(ids);

    const real = await tempDb("h.db");
    const k = generateApiKey();
    await insertAgent(real, { name: "Real agent", keyHash: k.hash, keyPrefix: k.displayPrefix });
    expect(await seedIfEmpty(real)).toBeNull();
    expect(await listRequests(real, { limit: 10 })).toHaveLength(0);
  });

  it("the month total is the recorded run's on any day (mid-month, Monday morning, judging day)", async () => {
    for (const iso of ["2026-11-11T12:00:00Z", "2026-11-09T06:00:00Z", "2026-11-13T09:00:00Z", "2026-12-15T10:00:00Z"]) {
      const now = Date.parse(iso);
      const db = await tempDb(`now-${iso.slice(0, 10)}.db`);
      const r = await seedDemo(db, { now });
      expect(r, iso).toMatchObject({ requests: run.requests.length, thisMonthSpentCents: paidCents });
    }
  });
});
