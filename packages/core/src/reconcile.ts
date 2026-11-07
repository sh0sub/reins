import { getWorkspace, listPaymentsForReconcile, updatePayment, type Payment } from "@reins/db";
import { centsToValue, toCents } from "./money.ts";
import type { TransactionDetail } from "./paypal/types.ts";
import { playgroundEnabled } from "./playground.ts";
import type { ReinsContext } from "./service.ts";

/**
 * M11 "대사": nightly Transaction Search reconciliation (plan step 7: custom_id / capture id 대사).
 * For every completed payment in the window, look for the PayPal transaction by capture id (transaction_id)
 * or by our custom_id (= request id, set on every order):
 * - found, same amount + currency, status S      -> matched
 * - found, different amount/currency or D/V      -> mismatch (note says why)
 * - not found and older than `missingAfterMs`    -> mismatch "missing in Transaction Search"
 * - not found yet (Transaction Search lags ~3 h) -> stays unchecked
 * Payout transactions are negative for the sender, so amounts compare by absolute value.
 */
export interface ReconcileResult {
  window: { start: string; end: string };
  transactions: number;
  checked: number;
  matched: number;
  mismatch: number;
  pending: number;
  pages: number;
  /** Seeded demo payments (FAKE-…/SIM-… ids) left out on a real-PayPal workspace: they were never sent to PayPal. */
  skipped: number;
}

/** Real = PayPal Transaction Search was queried; simulated = a demo instance where nothing was queried and nothing changed. */
export type ReconcileMode = "paypal" | "simulated";

export const SIMULATED_RECONCILE_NOTE = "Reconciliation runs against real PayPal Transaction Search; simulated here. The seeded match states are left as they are.";

/** Public demo on the real sandbox where every payment in the window is seeded demo data: nothing to ask PayPal about. */
export const SEEDED_RECONCILE_NOTE =
  "Seeded demo payments (FAKE- ids) were never sent to PayPal, so Transaction Search is not run on them; their match states are left as they are. Orders you complete on PayPal from /try are reconciled for real.";

/** Ids that only exist in Reins: the seed's FAKE-… and the in-memory fake PayPal's SIM-…. PayPal can never list them. */
export const isSimulatedPayPalId = (id: string | null | undefined): boolean => Boolean(id && /^(FAKE|SIM)-/.test(id));
const isSimulatedPayment = (p: Pick<Payment, "captureId" | "paypalOrderId" | "payoutBatchId">) =>
  isSimulatedPayPalId(p.captureId ?? p.payoutBatchId ?? p.paypalOrderId);

/**
 * Demo instances (`pnpm judge`, REINS_TRY=1, REINS_PUBLIC_DEMO=1) on the in-memory fake PayPal hold seeded SIM ids that were never
 * sent to PayPal, so a Transaction Search run there would flag every seeded payment as missing. Those instances skip it.
 * A demo on the real sandbox (public demo with PayPal keys) is "paypal" here; reconcileNow still keeps it neutral for seeded rows.
 */
export function reconcileMode(paypalEnv: string, env: Record<string, string | undefined> = process.env): ReconcileMode {
  return paypalEnv === "fake" && playgroundEnabled(env) ? "simulated" : "paypal";
}

/** "Reconcile now": the real run, or on a demo instance a neutral no-op result that leaves every payment untouched. */
export async function reconcileNow(
  ctx: ReinsContext,
  opts: { start?: number; end?: number; env?: Record<string, string | undefined> } = {},
): Promise<(ReconcileResult & { mode: "paypal" }) | { mode: "simulated"; note: string }> {
  const ws = await getWorkspace(ctx.db);
  if (reconcileMode(ws.paypalEnv, opts.env) === "simulated") return { mode: "simulated", note: SIMULATED_RECONCILE_NOTE };
  if (playgroundEnabled(opts.env)) {
    // Public demo on the real sandbox: the seeded history has FAKE ids. With nothing real in the window, say so instead of
    // querying PayPal; with real /try orders, reconcile those for real (reconcilePayments skips the seeded rows).
    const { start, end } = reconcileWindow(ctx, opts);
    const payments = await listPaymentsForReconcile(ctx.db, start, end);
    if (!payments.some((p) => !isSimulatedPayment(p))) return { mode: "simulated", note: SEEDED_RECONCILE_NOTE };
  }
  return { mode: "paypal", ...(await reconcilePayments(ctx, { start: opts.start, end: opts.end })) };
}

function reconcileWindow(ctx: ReinsContext, opts: { start?: number; end?: number }): { start: number; end: number } {
  const end = opts.end ?? ctx.now();
  return { start: Math.max(opts.start ?? end - 2 * DAY, end - MAX_WINDOW_MS), end };
}

const DAY = 86_400_000;
/** PayPal rejects windows longer than 31 days. */
export const MAX_WINDOW_MS = 31 * DAY;

export async function reconcilePayments(
  ctx: ReinsContext,
  opts: { start?: number; end?: number; missingAfterMs?: number } = {},
): Promise<ReconcileResult> {
  const { start, end } = reconcileWindow(ctx, opts);
  const missingAfterMs = opts.missingAfterMs ?? DAY;
  const all = await listPaymentsForReconcile(ctx.db, start, end);
  // On a real-PayPal workspace the seeded FAKE-… rows can never be in Transaction Search: leave their seeded state alone.
  const real = (await getWorkspace(ctx.db)).paypalEnv !== "fake";
  const payments = real ? all.filter((p) => !isSimulatedPayment(p)) : all;

  // Search slightly wider than the payment window: capture time can trail order creation.
  const window = { start: new Date(start - 60 * 60_000).toISOString(), end: new Date(Math.min(end + 60 * 60_000, ctx.now())).toISOString() };
  const txns: TransactionDetail[] = [];
  let page = 1;
  let pages = 1;
  do {
    const r = await ctx.paypal.searchTransactions({ startDate: toPayPalTime(window.start), endDate: toPayPalTime(window.end), page });
    txns.push(...(r.transaction_details ?? []));
    pages = r.total_pages ?? 1;
    page += 1;
  } while (page <= pages && page <= 20);

  const byId = new Map<string, TransactionDetail>();
  const byCustom = new Map<string, TransactionDetail>();
  for (const t of txns) {
    const info = t.transaction_info;
    if (info.transaction_id) byId.set(info.transaction_id, t);
    if (info.custom_field) byCustom.set(info.custom_field, t);
  }

  const result: ReconcileResult = { window, transactions: txns.length, checked: payments.length, matched: 0, mismatch: 0, pending: 0, pages, skipped: all.length - payments.length };
  for (const p of payments) {
    const t = (p.captureId ? byId.get(p.captureId) : undefined) ?? byCustom.get(p.requestId);
    const verdict = judge(p, t, ctx.now() - p.createdAt > missingAfterMs);
    if (verdict.state === "unchecked") {
      result.pending += 1;
      await updatePayment(ctx.db, p.id, { reconciledAt: ctx.now(), reconcileNote: verdict.note });
      continue;
    }
    result[verdict.state] += 1;
    await updatePayment(ctx.db, p.id, { reconciled: verdict.state, reconciledAt: ctx.now(), reconcileNote: verdict.note });
  }
  return result;
}

export function judge(p: Pick<Payment, "amountCents" | "currency">, t: TransactionDetail | undefined, overdue: boolean): { state: "matched" | "mismatch" | "unchecked"; note: string } {
  if (!t) return overdue ? { state: "mismatch", note: "missing in Transaction Search" } : { state: "unchecked", note: "not in Transaction Search yet" };
  const info = t.transaction_info;
  const amt = info.transaction_amount;
  const status = info.transaction_status ?? "S";
  if (status === "D" || status === "V") return { state: "mismatch", note: `PayPal status ${status}` };
  if (amt) {
    let cents: number;
    try {
      cents = Math.abs(toCents(amt.value.replace(/^-/, "")));
    } catch {
      return { state: "mismatch", note: `unreadable amount ${amt.value}` };
    }
    if (amt.currency_code !== p.currency || cents !== p.amountCents) {
      return { state: "mismatch", note: `amount ${amt.currency_code} ${centsToValue(cents)} != ${p.currency} ${centsToValue(p.amountCents)}` };
    }
  }
  if (status === "P") return { state: "unchecked", note: "PayPal transaction pending" };
  return { state: "matched", note: `matched ${info.transaction_id}` };
}

/** Transaction Search wants yyyy-MM-ddTHH:mm:ss-0000 style; ISO with milliseconds dropped works. */
function toPayPalTime(iso: string): string {
  return iso.replace(/\.\d{3}Z$/, "-0000");
}
