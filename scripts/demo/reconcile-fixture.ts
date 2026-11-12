/**
 * Re-checks the recorded run's payouts against the real PayPal sandbox Transaction Search and writes the result into the
 * fixture (read-only API calls: token + GET /v1/reporting/transactions; no payouts, no orders).
 *
 *   tsx --env-file=.env scripts/demo/reconcile-fixture.ts [--write]
 *
 * Uses the app's own `judge` (packages/core/src/reconcile.ts): a row becomes "matched" only when PayPal listed its
 * transaction id with the same amount; otherwise it keeps "unchecked" (not listed yet). Prints counts and ids only.
 * Without --write nothing is changed.
 */
import { writeFileSync } from "node:fs";
import { HttpPayPalClient, judge, type TransactionDetail } from "@reins/core";
import { FIXTURE_PATH, loadFixture } from "../seed.ts";

const write = process.argv.includes("--write");
const { PAYPAL_CLIENT_ID: clientId, PAYPAL_CLIENT_SECRET: clientSecret } = process.env;
if (!clientId || !clientSecret) throw new Error("PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are required (use --env-file=.env)");

const run = loadFixture();
const payments = run.requests.flatMap((r) => (r.payment ? [r.payment] : []));
const HOUR = 3_600_000;
const start = Math.min(...payments.map((p) => p.created_at)) - HOUR;
const end = Math.max(...payments.map((p) => p.updated_at)) + HOUR;
const stamp = (t: number) => new Date(t).toISOString().replace(/\.\d{3}Z$/, "-0000");

const paypal = new HttpPayPalClient({ clientId, clientSecret, env: "sandbox" });
const txns: TransactionDetail[] = [];
for (let page = 1, pages = 1; page <= pages && page <= 20; page++) {
  const r = await paypal.searchTransactions({ startDate: stamp(start), endDate: stamp(end), page });
  txns.push(...(r.transaction_details ?? []));
  pages = r.total_pages ?? 1;
}
const byId = new Map(txns.map((t) => [t.transaction_info.transaction_id, t]));
const checkedAt = Date.now();
const counts = { matched: 0, mismatch: 0, unchecked: 0 };
for (const p of payments) {
  const v = judge({ amountCents: p.amount_cents, currency: p.currency }, p.capture_id ? byId.get(p.capture_id) : undefined, false);
  counts[v.state] += 1;
  console.log(`${p.capture_id} ${p.payout_batch_id} ${v.state} ${v.note}`);
  p.reconciled = v.state;
  p.reconcile_note = v.note;
  p.reconciled_at = checkedAt;
}
console.log(`Transaction Search returned ${txns.length} transactions; payouts matched ${counts.matched}, mismatch ${counts.mismatch}, unchecked ${counts.unchecked}`);
if (write) {
  run.run.transaction_search = { ...counts, checked_at: new Date(checkedAt).toISOString() };
  writeFileSync(FIXTURE_PATH, `${JSON.stringify(run, null, 2)}\n`);
  console.log(`fixture updated: ${FIXTURE_PATH}`);
}
