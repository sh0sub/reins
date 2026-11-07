/**
 * Public demo on the real PayPal sandbox (Render: REINS_PUBLIC_DEMO=1 + PayPal keys, supervised checkout): the seed connects
 * the workspace as "sandbox" so the labels match the HttpPayPalClient that really runs, /try approvals stop at
 * awaiting_buyer with a sandbox approve link, and "Reconcile now" never runs Transaction Search against the seeded FAKE ids.
 * PayPal is a stubbed HttpPayPalClient (no network).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createDb, getPaymentByRequest, getWorkspace, listPaymentsForReconcile, migrateDb, updatePayment, updateWorkspace, type ReinsDb } from "@reins/db";
import { getOverview, HttpPayPalClient, reconcileNow, runPlayground, SEEDED_RECONCILE_NOTE, SIMULATED_RECONCILE_NOTE, type ReinsContext } from "@reins/core";
import { createTestContext } from "@reins/core/testing";
import { DEMO_MERCHANT_EMAIL, seedDemo, seedPayPal } from "../../scripts/seed.ts";
import { PRESETS } from "../../apps/web/src/app/try/presets.ts";
import { timelineItem, timelineSummary, verdictLine, type VerdictRule } from "../../apps/web/src/app/try/verdict.ts";
import { reconcileBanner } from "../../apps/web/src/lib/format.ts";
import { topbarStatus } from "../../apps/web/src/lib/shell.ts";

const dir = mkdtempSync(join(tmpdir(), "reins-sandbox-demo-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let dbN = 0;
async function tempDb(): Promise<ReinsDb> {
  const db = createDb(`file:${join(dir, `db-${++dbN}.db`)}`);
  await migrateDb(db);
  return db;
}

const CREDS = { PAYPAL_ENV: "sandbox", PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "secret" };
const DEMO = { REINS_PUBLIC_DEMO: "1" };
const preset = (id: string) => PRESETS.find((p) => p.id === id)!;
const rulesOf = (row: { decisions: Array<{ stage: string; details: unknown }> }): VerdictRule[] =>
  (row.decisions.find((d) => d.stage === "hard_rules")?.details as { results?: VerdictRule[] } | null)?.results ?? [];

/** HttpPayPalClient over a stubbed fetch: orders come back CREATED with a sandbox approve link, like the live site's 1L554285NR236183P. */
function stubSandbox(txns: Array<{ id: string; custom?: string; value: string }> = []) {
  const calls: string[] = [];
  let n = 0;
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
  const fetch = async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const key = `${init.method ?? "GET"} ${u.pathname}`;
    calls.push(key);
    if (key === "POST /v1/oauth2/token") return json({ access_token: "tok", expires_in: 32400 });
    if (key === "POST /v2/checkout/orders") {
      const id = `1L5542${String(++n).padStart(11, "0")}`;
      return json({ id, status: "CREATED", links: [{ rel: "approve", href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }] });
    }
    if (key === "GET /v1/reporting/transactions") {
      return json({
        total_pages: 1,
        transaction_details: txns.map((t) => ({ transaction_info: { transaction_id: t.id, custom_field: t.custom, transaction_status: "S", transaction_amount: { currency_code: "USD", value: t.value } } })),
      });
    }
    return new Response(JSON.stringify({ name: "NOT_FOUND" }), { status: 404 });
  };
  return { client: new HttpPayPalClient({ clientId: "id", clientSecret: "secret", env: "sandbox", fetch }), calls };
}

async function sandboxDemo(txns: Parameters<typeof stubSandbox>[0] = []) {
  const db = await tempDb();
  await seedDemo(db, { connectDemoMerchant: true, env: CREDS });
  const stub = stubSandbox(txns);
  const ctx = (await createTestContext({ db, paypal: stub.client })) as unknown as ReinsContext;
  await updateWorkspace(db, { paymentMode: "supervised" });
  return { db, ctx, calls: stub.calls };
}

describe("seed: the demo merchant is on the PayPal the server really uses", () => {
  it("with PayPal keys the workspace is 'sandbox' (merchant email from PAYPAL_SANDBOX_MERCHANT_EMAIL, else the demo address)", () => {
    expect(seedPayPal(CREDS)).toEqual({ paypalEnv: "sandbox", merchantEmail: DEMO_MERCHANT_EMAIL });
    expect(seedPayPal({ ...CREDS, PAYPAL_SANDBOX_MERCHANT_EMAIL: "sb-shop@business.example.com" })).toEqual({ paypalEnv: "sandbox", merchantEmail: "sb-shop@business.example.com" });
  });

  it("without keys, or with PAYPAL_ENV=fake (pnpm judge), it stays the simulated fake", () => {
    expect(seedPayPal({})).toEqual({ paypalEnv: "fake", merchantEmail: DEMO_MERCHANT_EMAIL });
    expect(seedPayPal({ PAYPAL_CLIENT_ID: "id" })).toMatchObject({ paypalEnv: "fake" });
    expect(seedPayPal({ ...CREDS, PAYPAL_ENV: "fake" })).toMatchObject({ paypalEnv: "fake" });
  });

  it("a sandbox-connected seed still reads as seeded demo data: FAKE ids, overview demo note on", async () => {
    const { db, ctx } = await sandboxDemo();
    expect(await getWorkspace(db)).toMatchObject({ paypalEnv: "sandbox", merchantEmail: DEMO_MERCHANT_EMAIL });
    const paid = await listPaymentsForReconcile(db, 0, Date.now());
    expect(paid.length).toBeGreaterThan(0);
    expect(paid.every((p) => /^FAKE-/.test(p.captureId ?? p.paypalOrderId ?? ""))).toBe(true);
    const ov = await getOverview(ctx);
    expect(ov.paypal_env).toBe("sandbox");
    expect(JSON.stringify(ov)).toContain('"demo_data":true');
  });
});

describe("/try on the real sandbox (supervised checkout)", () => {
  it("$12.98 is approved by Reins: a real sandbox order with an approve link, awaiting the buyer, and the verdict says so", async () => {
    const { ctx, calls } = await sandboxDemo();
    const r = await runPlayground(ctx, preset("domain").purchase);
    expect(r.paypal).toBe("sandbox");
    expect(r.row.status).toBe("awaiting_buyer");
    expect(r.row.payment).toMatchObject({ order_id: expect.stringMatching(/^1L5542/), approve_url: expect.stringMatching(/^https:\/\/www\.sandbox\.paypal\.com\//) });
    expect(calls).toContain("POST /v2/checkout/orders");

    const v = verdictLine({ status: r.row.status, llm: { decision: "AUTO_APPROVE", actor: "claude" }, rules: rulesOf(r.row), auditor: "configured", paypal: r.paypal, orderId: r.row.payment!.order_id });
    expect(v.tone).toBe("ok");
    expect(v.head).toBe("Approved by Reins");
    expect(v.text).toContain(`real PayPal sandbox order ${r.row.payment!.order_id} created`);
    expect(v.text).toContain("Buyer approval on PayPal is the last step");
  });

  it("the 5 × $29 preset still reads 3 approved / 2 denied (awaiting_buyer counts as committed spend)", async () => {
    const { ctx } = await sandboxDemo();
    const split = preset("split");
    const out = [];
    for (let i = 0; i < split.repeat!; i++) out.push(await runPlayground(ctx, split.purchase));
    expect(out.map((r) => r.row.status)).toEqual(["awaiting_buyer", "awaiting_buyer", "awaiting_buyer", "denied", "denied"]);
    const items = out.map((r, i) => timelineItem(i + 1, { status: r.row.status, rules: rulesOf(r.row) }));
    expect(items.map((i) => i.label)).toEqual(["Approved", "Approved", "Approved", "Denied", "Denied"]);
    expect(timelineSummary(items)).toBe("3 approved, 2 denied");
  });
});

describe("Reconcile now on the public demo with real sandbox keys", () => {
  it("only seeded FAKE payments in the window: neutral seeded note, no Transaction Search call, nothing changed", async () => {
    const { db, ctx, calls } = await sandboxDemo();
    const before = await listPaymentsForReconcile(db, 0, Date.now());
    const r = await reconcileNow(ctx, { start: Date.now() - 31 * 86_400_000, env: DEMO });
    expect(r).toEqual({ mode: "simulated", note: SEEDED_RECONCILE_NOTE });
    expect(reconcileBanner(r)).toEqual({ tone: "info", msg: SEEDED_RECONCILE_NOTE });
    expect(calls).not.toContain("GET /v1/reporting/transactions");
    expect(await listPaymentsForReconcile(db, 0, Date.now())).toEqual(before);
  });

  it("a real completed /try order is reconciled for real; the seeded rows are skipped and keep their seeded state", async () => {
    const { db, ctx, calls } = await sandboxDemo([{ id: "8AB12345CD6789012", value: "12.98" }]);
    const r0 = await runPlayground(ctx, preset("domain").purchase);
    const pay = (await getPaymentByRequest(db, r0.row.request_id))!;
    await updatePayment(db, pay.id, { status: "completed", captureId: "8AB12345CD6789012" }); // the buyer approved and it was captured
    const seededBefore = (await listPaymentsForReconcile(db, 0, Date.now())).filter((p) => p.captureId?.startsWith("FAKE-"));
    expect(seededBefore.length).toBeGreaterThan(1);

    const r = await reconcileNow(ctx, { start: Date.now() - 31 * 86_400_000, env: DEMO });
    expect(r).toMatchObject({ mode: "paypal", checked: 1, matched: 1, mismatch: 0, skipped: seededBefore.length });
    expect(calls).toContain("GET /v1/reporting/transactions");
    expect(reconcileBanner(r as Parameters<typeof reconcileBanner>[0])).toMatchObject({ tone: "ok", msg: expect.stringContaining(`${seededBefore.length} seeded demo payments left as seeded`) });
    const seededAfter = (await listPaymentsForReconcile(db, 0, Date.now())).filter((p) => p.captureId?.startsWith("FAKE-"));
    expect(seededAfter).toEqual(seededBefore);
  });

  it("pnpm judge / fake PayPal demo keeps the old simulated note", async () => {
    const db = await tempDb();
    await seedDemo(db, { connectDemoMerchant: true, env: { PAYPAL_ENV: "fake" } });
    const ctx = await createTestContext({ db });
    expect(await reconcileNow(ctx, { env: { REINS_TRY: "1" } })).toEqual({ mode: "simulated", note: SIMULATED_RECONCILE_NOTE });
  });
});

describe("header status", () => {
  it("says PayPal Sandbox on the real client and Simulated PayPal on the fake one", () => {
    expect(topbarStatus("live", false, "sandbox")).toMatchObject({ label: "PayPal Sandbox", dot: "dot dot-ok" });
    expect(topbarStatus("live", true, "fake")).toMatchObject({ label: "Simulated PayPal", dot: "dot" });
    expect(topbarStatus("offline", false, "sandbox")).toMatchObject({ dot: "dot dot-bad" });
    expect(topbarStatus("connecting", false, "sandbox")).toMatchObject({ label: "Connecting…" });
  });
});
