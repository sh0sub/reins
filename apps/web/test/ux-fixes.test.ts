/**
 * UX review fixes: simulated reconcile, the five-order preset as one run with a timeline, the /try verdict line and folded rules,
 * plain decision labels, the top-bar status wording, /settings and /receipts redirects, receipts by display id.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getPaymentByRequest, updatePayment, updateWorkspace } from "@reins/db";
import { createTestContext } from "@reins/core/testing";
import { findRequest, getReceipt, parseDisplayId, reconcileMode, reconcileNow, runPlayground, SIMULATED_RECONCILE_NOTE } from "@reins/core";
import config from "../next.config.ts";
import { createRouter } from "../src/server/router.ts";
import { PRESETS } from "../src/app/try/presets.ts";
import { runSequence, splitRules, timelineItem, timelineSummary, verdictLine, type VerdictRule } from "../src/app/try/verdict.ts";
import { auditorWord, decisionClass, decisionLabel, reconcileBanner } from "../src/lib/format.ts";
import { topbarStatus } from "../src/lib/shell.ts";

type Ctx = Awaited<ReturnType<typeof createTestContext>>;
const preset = (id: string) => PRESETS.find((p) => p.id === id)!;
const rulesOf = (row: { decisions: Array<{ stage: string; details: unknown }> }): VerdictRule[] =>
  (row.decisions.find((d) => d.stage === "hard_rules")?.details as { results?: VerdictRule[] } | null)?.results ?? [];

const envKeys = ["REINS_TRY", "REINS_PUBLIC_DEMO"] as const;
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
});
afterEach(() => {
  for (const k of envKeys) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function paidCtx(): Promise<{ ctx: Ctx; id: string }> {
  const ctx = await createTestContext();
  await updateWorkspace(ctx.db, { paypalEnv: "fake", paymentMode: "vaulted", vaultId: "VAULT-FAKE-TEST", connectedAt: Date.now() });
  const r = await runPlayground(ctx, preset("domain").purchase);
  expect(r.row.status).toBe("paid");
  return { ctx, id: r.row.request_id };
}

describe("reconcile on a simulated-PayPal demo", () => {
  it("mode: demo flag + fake PayPal is simulated; sandbox or no demo flag runs Transaction Search", () => {
    expect(reconcileMode("fake", { REINS_TRY: "1" })).toBe("simulated");
    expect(reconcileMode("fake", { REINS_PUBLIC_DEMO: "1" })).toBe("simulated");
    expect(reconcileMode("sandbox", { REINS_TRY: "1" })).toBe("paypal");
    expect(reconcileMode("live", { REINS_PUBLIC_DEMO: "1" })).toBe("paypal");
    expect(reconcileMode("fake", {})).toBe("paypal");
  });

  it("a simulated run changes nothing: a seeded 'matched' SIM payment stays matched, so the KPI is the same before and after", async () => {
    const { ctx, id } = await paidCtx();
    const pay = (await getPaymentByRequest(ctx.db, id))!;
    // like the seed: matched although the fake PayPal never saw this id
    await updatePayment(ctx.db, pay.id, { reconciled: "matched", captureId: "SIM-0141", reconcileNote: "seeded" });
    ctx.paypal.orders.clear();
    const r = await reconcileNow(ctx, { env: { REINS_TRY: "1" } });
    expect(r).toEqual({ mode: "simulated", note: SIMULATED_RECONCILE_NOTE });
    expect(ctx.paypal.calls).not.toContain("searchTransactions");
    expect((await getPaymentByRequest(ctx.db, id))!).toMatchObject({ reconciled: "matched", reconcileNote: "seeded" });
  });

  it("POST /api/reconcile on a judge instance answers with the neutral note; off a demo instance it still runs Transaction Search", async () => {
    const { ctx, id } = await paidCtx();
    const handle = createRouter(async () => ctx);
    const call = async () => (await handle(new Request("http://localhost/api/reconcile", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ days: 31 }) }))).json();
    process.env.REINS_TRY = "1";
    expect(await call()).toMatchObject({ mode: "simulated" });
    expect((await getPaymentByRequest(ctx.db, id))!.reconciled).toBe("unchecked");
    delete process.env.REINS_TRY;
    delete process.env.REINS_PUBLIC_DEMO;
    expect(await call()).toMatchObject({ mode: "paypal", checked: 1, matched: 1, mismatch: 0 });
  });

  it("banner: neutral for simulated, green only with zero mismatches, a warning otherwise", () => {
    expect(reconcileBanner({ mode: "simulated", note: SIMULATED_RECONCILE_NOTE })).toEqual({ tone: "info", msg: SIMULATED_RECONCILE_NOTE });
    expect(reconcileBanner({ mode: "paypal", transactions: 5, checked: 5, matched: 5, mismatch: 0, pending: 0 }).tone).toBe("ok");
    const bad = reconcileBanner({ mode: "paypal", transactions: 5, checked: 24, matched: 5, mismatch: 19, pending: 0 });
    expect(bad.tone).toBe("warn");
    expect(bad.msg).toContain("19 mismatch");
  });
});

describe("/try five $29 orders as one run", () => {
  it("runSequence sends strictly one after another and reports each in order", async () => {
    const log: string[] = [];
    let inFlight = 0;
    const out = await runSequence(
      5,
      async (i) => {
        inFlight += 1;
        expect(inFlight).toBe(1);
        log.push(`start ${i}`);
        await new Promise((r) => setTimeout(r, 1));
        inFlight -= 1;
        return i * 10;
      },
      (r, i) => log.push(`done ${i}=${r}`),
    );
    expect(out).toEqual([10, 20, 30, 40, 50]);
    expect(log.slice(0, 4)).toEqual(["start 1", "done 1=10", "start 2", "done 2=20"]);
    expect(await runSequence(0, async () => "x")).toEqual(["x"]);
  });

  it("the timeline reads Paid, Paid, Paid, Denied, Denied with the same-merchant 24 h reason", async () => {
    const ctx = await createTestContext();
    await updateWorkspace(ctx.db, { paypalEnv: "fake", paymentMode: "vaulted", vaultId: "VAULT-FAKE-TEST", connectedAt: Date.now() });
    const split = preset("split");
    const results = await runSequence(split.repeat!, () => runPlayground(ctx, split.purchase));
    const items = results.map((r, i) => timelineItem(i + 1, { status: r.row.status, rules: rulesOf(r.row) }));
    expect(items.map((x) => x.label)).toEqual(["Paid", "Paid", "Paid", "Denied", "Denied"]);
    expect(items.slice(0, 3).every((x) => x.reason === null)).toBe(true);
    expect(items[3]!.reason).toMatch(/^Split purchase: \$87\.00 already paid to vercel\.com in 24 hours \+ this \$29\.00 = \$116\.00 > per-purchase cap \$100\.00$/);
    expect(timelineSummary(items)).toBe("3 paid, 2 denied");
  });
});

describe("/try verdict line and folded rules", () => {
  const pass = (rule: string): VerdictRule => ({ rule, ok: true, detail: "ok" });
  const fail = (rule: string): VerdictRule => ({ rule, ok: false, detail: `${rule} failed` });
  const basics = ["agent_active", "agent_paused", "mandate_present", "mandate_window", "amount_valid", "currency", "blocked_merchant", "velocity"].map(pass);

  it("blocked by three hard rules while Claude said approve", () => {
    const rules = [...basics, fail("per_tx_cap"), fail("monthly_limit"), fail("allowlist"), pass("merchant_total")];
    const v = verdictLine({ status: "denied", llm: { decision: "AUTO_APPROVE", actor: "claude" }, rules, auditor: "configured" });
    expect(`${v.head} — ${v.text}`).toBe("Blocked — 3 hard rules failed; Claude said approve");
    expect(v.tone).toBe("bad");
  });

  it("fooled auditor, demo auditor, paid and waiting read in words, never enums", () => {
    const rules = [...basics, pass("per_tx_cap")];
    expect(verdictLine({ status: "denied", llm: { decision: "ASK_HUMAN", actor: "fooled" }, rules: [fail("per_tx_cap")], auditor: "fooled" }).text).toBe("1 hard rule failed; the fooled auditor said approve");
    expect(verdictLine({ status: "paid", llm: { decision: "AUTO_APPROVE", actor: "mock" }, rules, auditor: "configured" })).toMatchObject({ tone: "ok", head: "Paid", text: "all 9 checks passed; the demo auditor said approve" });
    expect(verdictLine({ status: "pending_human", llm: { decision: "ASK_HUMAN", actor: "mock" }, rules, auditor: "configured" })).toMatchObject({ head: "Needs you", text: "all 9 checks passed; the demo auditor said ask a person" });
    expect(verdictLine({ status: "denied", llm: null, rules: [fail("agent_paused")], auditor: "configured" }).text).toBe("1 hard rule failed; auditor not called");
    expect(auditorWord("DENY")).toBe("deny");
  });

  it("only failed rules and the four limits stay visible; the always-pass rows fold behind 'Show all N checks'", () => {
    const rules = [...basics, pass("per_tx_cap"), fail("merchant_total"), pass("monthly_limit"), pass("allowlist")];
    const { shown, hidden } = splitRules(rules);
    expect(shown.map((r) => r.rule)).toEqual(["per_tx_cap", "merchant_total", "monthly_limit", "allowlist"]);
    expect(hidden).toBe(8);
    expect(splitRules([fail("currency"), pass("velocity")]).shown.map((r) => r.rule)).toEqual(["currency"]);
  });
});

describe("plain labels and header status", () => {
  const d = (stage: string, decision: string) => ({ stage, decision }) as never;
  it("decision column: Auto / Human / Blocked / Denied / Needs you / Expired", () => {
    expect(decisionLabel({ status: "paid", decision: "AUTO_APPROVE", decisions: [] })).toBe("Auto");
    expect(decisionLabel({ status: "paid", decision: "ASK_HUMAN", decisions: [d("human", "APPROVE")] })).toBe("Human");
    expect(decisionLabel({ status: "denied", decision: "DENY", decisions: [] })).toBe("Blocked");
    expect(decisionLabel({ status: "denied", decision: "ASK_HUMAN", decisions: [d("human", "DENY")] })).toBe("Denied");
    expect(decisionLabel({ status: "pending_human", decision: "ASK_HUMAN", decisions: [] })).toBe("Needs you");
    expect(decisionLabel({ status: "expired", decision: "ASK_HUMAN", decisions: [] })).toBe("Expired");
    expect(decisionClass("Blocked")).toBe("status status-bad");
    expect(decisionClass("Needs you")).toBe("status status-warn");
  });

  it("simulated PayPal reads the same in the header as in the sidebar, with a grey dot; a dropped stream still turns red", () => {
    expect(topbarStatus("live", true)).toMatchObject({ label: "Simulated PayPal", dot: "dot" });
    expect(topbarStatus("connecting", true)).toMatchObject({ label: "Simulated PayPal", dot: "dot" });
    expect(topbarStatus("live", false)).toMatchObject({ label: "Live", dot: "dot dot-ok" });
    expect(topbarStatus("offline", true)).toMatchObject({ dot: "dot dot-bad" });
  });
});

describe("routes", () => {
  it("/settings goes to /setup and a bare /receipts goes to the ledger", async () => {
    const r = await config.redirects!();
    expect(r).toEqual(expect.arrayContaining([expect.objectContaining({ source: "/settings", destination: "/setup" }), expect.objectContaining({ source: "/receipts", destination: "/ledger" })]));
  });

  it("receipts resolve a display id (R-0143, r-143) as well as the internal id", async () => {
    expect(parseDisplayId("R-0143")).toBe(143);
    expect(parseDisplayId("r-143")).toBe(143);
    expect(parseDisplayId("req_abc")).toBeNull();
    expect(parseDisplayId("R-")).toBeNull();
    const { ctx, id } = await paidCtx();
    const byId = await getReceipt(ctx, id);
    const byDisplay = await getReceipt(ctx, byId.display_id);
    expect(byDisplay.request_id).toBe(id);
    expect((await getReceipt(ctx, byId.display_id.toLowerCase())).request_id).toBe(id);
    expect((await findRequest(ctx.db, "R-9999"))).toBeUndefined();
    await expect(getReceipt(ctx, "R-9999")).rejects.toMatchObject({ status: 404 });
    const res = await createRouter(async () => ctx)(new Request(`http://localhost/api/receipts/${byId.display_id}`));
    expect(res.status).toBe(200);
  });
});
