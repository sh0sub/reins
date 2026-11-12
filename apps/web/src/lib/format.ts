import type { LedgerRow } from "@reins/core";

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
/** Cents as dollars with a thousands separator: 135000 -> "$1,350.00". */
export const usd = (cents: number) => USD.format(cents / 100);
/** Same format for an amount already in dollars. */
export const usdAmount = (dollars: number) => USD.format(dollars);

/** Subscription guard: "$20.00 monthly · $240.00 a year"; null for a one-off purchase. */
export function cadenceText(r: { amount: string; recurring?: string | null; annual_amount?: string | null }): string | null {
  if (!r.recurring) return null;
  const cents = (v: string) => Math.round(Number(v) * 100);
  return `${usd(cents(r.amount))} ${r.recurring} · ${usd(cents(r.annual_amount ?? r.amount))} a year`;
}

export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "2-digit", timeZone: "UTC" });
}

export type RuleResult = { rule: string; ok: boolean; detail: string };

export function hardRules(row: Pick<LedgerRow, "decisions">): RuleResult[] {
  return (row.decisions.find((d) => d.stage === "hard_rules")?.details as { results?: RuleResult[] } | null)?.results ?? [];
}

export function riskClass(risk: number | null): string {
  if (risk == null) return "status";
  return risk <= 3 ? "status status-ok" : risk >= 8 ? "status status-bad" : "status status-warn";
}

export type DecisionLabel = "Auto" | "Human" | "Blocked" | "Denied" | "Needs you" | "Expired";

/**
 * Plain-word "Decision" column of the ledger (S4): Auto (rules + auditor paid it), Human (a person decided), Blocked (rules or
 * auditor stopped it), Denied (a person rejected it), Needs you (waiting), Expired. Never the raw AUTO_APPROVE / ASK_HUMAN enums.
 */
export function decisionLabel(row: Pick<LedgerRow, "decisions" | "decision" | "status">): DecisionLabel {
  if (row.status === "expired") return "Expired";
  const human = row.decisions.find((d) => d.stage === "human");
  if (row.status === "denied") return human ? "Denied" : "Blocked";
  if (human) return "Human";
  if (row.decision === "AUTO_APPROVE") return "Auto";
  return "Needs you";
}

/** Chip colour for a decision label (paired with the word, never colour alone). */
export function decisionClass(d: DecisionLabel): string {
  return d === "Blocked" || d === "Denied" ? "status status-bad" : d === "Human" || d === "Needs you" ? "status status-warn" : d === "Auto" ? "status status-ok" : "status";
}

/** Auditor answers in words: AUTO_APPROVE -> "approve", ASK_HUMAN -> "ask a person", DENY -> "deny". */
export function auditorWord(decision: string | null | undefined): string {
  return decision === "AUTO_APPROVE" ? "approve" : decision === "ASK_HUMAN" ? "ask a person" : decision === "DENY" ? "deny" : (decision ?? "").toLowerCase().replace(/_/g, " ");
}

/**
 * Overview-style split used by the ledger tiles ("Auto 19 · Human 4 · Blocked 1"): anything that needed a person
 * (asked, approved, rejected, pending, expired) is Human, only rule/auditor denials are Blocked. Mirrors core outcomeOf.
 */
export function outcomeBucket(row: Pick<LedgerRow, "decisions" | "decision" | "status">): "auto" | "human" | "blocked" | "other" {
  if (row.decisions.some((d) => d.stage === "human") || row.status === "pending_human" || row.status === "expired") return "human";
  if (row.status === "denied") return "blocked";
  if (row.status === "reviewing") return "other";
  return row.decision === "AUTO_APPROVE" ? "auto" : "human";
}

/** Sum of amounts in one outcome bucket (the Blocked tile and the grid footer share this so they never disagree). */
export function bucketTotal(rows: Array<Pick<LedgerRow, "decisions" | "decision" | "status" | "amount">>, bucket: ReturnType<typeof outcomeBucket>): number {
  return rows.filter((r) => outcomeBucket(r) === bucket).reduce((s, r) => s + Number(r.amount), 0);
}

/** Status chip: label text + colour (never colour alone). */
export function statusChip(row: Pick<LedgerRow, "status"> & { payment?: { error?: string | null } | null }): { label: string; className: string } {
  if (row.status === "paying" && isUnclaimedPayout(row.payment)) return { label: "Payout unclaimed", className: "status status-warn" };
  switch (row.status) {
    case "paid":
      return { label: "Paid", className: "status status-ok" };
    case "denied":
      return { label: "Denied", className: "status status-bad" };
    case "failed":
      return { label: "Failed", className: "status status-bad" };
    case "pending_human":
      return { label: "Waiting for you", className: "status status-warn" };
    case "awaiting_buyer":
      return { label: "Checkout open", className: "status status-info" };
    case "paying":
    case "approved":
      return { label: "Paying", className: "status status-info" };
    case "expired":
      return { label: "Expired", className: "status" };
    default:
      return { label: row.status, className: "status" };
  }
}

/** Deep links may carry a display id (R-0143). Returns the internal id, the id itself when it is not a display id, or null while rows are unknown. */
export function resolveRequestId(rows: Array<Pick<LedgerRow, "display_id" | "request_id">> | null, id: string | null): string | null {
  if (!id) return null;
  const hit = rows?.find((r) => r.display_id.toLowerCase() === id.toLowerCase());
  if (hit) return hit.request_id;
  return /^R-\d+$/i.test(id) ? null : id;
}

/** True once the rows are loaded and a display id (R-0143) matches no request, so the page can say so. */
export function isUnknownRequest(rows: Array<Pick<LedgerRow, "display_id" | "request_id">> | null, id: string | null): boolean {
  return rows !== null && !!id && /^R-\d+$/i.test(id) && resolveRequestId(rows, id) === null;
}

/** "Nov 4, 17:42": short enough for a 128 px ledger column (or a phone card line) without an ellipsis. */
/** "Nov 6, 2026, 3:57:46 PM UTC": English and UTC regardless of the browser locale. */
export const fullTime = (v: string | number | Date): string =>
  new Date(v).toLocaleString("en-US", { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", timeZone: "UTC", timeZoneName: "short" });

export const shortTime = (v: string | number | Date | null | undefined): string => (v ? new Date(v).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) : "");

/** Korean audit text is kept in the data but shown only for a Korean locale (<html lang="ko"> or ?lang=ko). The product UI is English. */
export function showKo(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.lang.toLowerCase().startsWith("ko") || new URLSearchParams(window.location.search).get("lang") === "ko";
}

/**
 * What a shared link (?r=R-0143 or an internal id) points at. A link never falls back to another request:
 * "pending" is approvable, "decided" is read-only, "missing" means the id is unknown, "none" means no link.
 */
export function linkedRequest<P extends Pick<LedgerRow, "display_id" | "request_id">, D extends Pick<LedgerRow, "display_id" | "request_id">>(
  pending: P[],
  decided: D[] | null,
  id: string | null,
): { kind: "none" } | { kind: "pending"; row: P } | { kind: "decided"; row: D } | { kind: "missing" } | { kind: "unknown-yet" } {
  if (!id) return { kind: "none" };
  const hit = (r: { display_id: string; request_id: string }) => r.request_id === id || r.display_id.toLowerCase() === id.toLowerCase();
  const p = pending.find(hit);
  if (p) return { kind: "pending", row: p };
  if (decided === null) return { kind: "unknown-yet" };
  const d = decided.find(hit);
  return d ? { kind: "decided", row: d } : { kind: "missing" };
}

/**
 * Rows replayed from the recorded real sandbox run (the demo seed): a "recorded run" chip whose tooltip says when it
 * really happened and how far its times were moved, so a shifted time never passes for live traffic.
 */
export function recordedChip(rec: { recorded_at: string; time_shift_ms: number; live_after?: boolean } | null | undefined): { label: string; title: string } | null {
  if (!rec) return null;
  if (rec.live_after) {
    const at = new Date(rec.recorded_at).toISOString().replace("T", " ").slice(0, 16);
    return { label: "recorded + live", title: `Requested and audited in a recorded real PayPal sandbox + Claude run (${at} UTC; its times are shifted). The decision and any payment after that happened live on this demo.` };
  }
  const when = new Date(rec.recorded_at).toISOString().replace("T", " ").slice(0, 16);
  const h = Math.abs(rec.time_shift_ms) / 3_600_000;
  const shift = h >= 48 ? `${Math.round(h / 24)} days` : h >= 1 ? `${h.toFixed(1)} h` : `${Math.round(h * 60)} min`;
  return {
    label: "recorded run",
    title: `Recorded real PayPal sandbox + Claude run (${when} UTC). Ids, amounts and auditor text are as recorded; times are shifted ${rec.time_shift_ms >= 0 ? "forward" : "back"} by ${shift} so the run ends just before this demo started. Not live traffic.`,
  };
}

/** A treasury payout PayPal sent that the payee has not claimed yet (not a failure; the request stays committed). */
export const isUnclaimedPayout = (payment: { error?: string | null } | null | undefined): boolean => Boolean(payment?.error?.startsWith("unclaimed"));

/** Offline demo ids (seed "FAKE-…", fake PayPal "SIM-…") are shown as SIM-… with a "simulated" chip so they never pass for sandbox ids. */
export const isSimId = (id: string | null | undefined): boolean => Boolean(id && /^(FAKE|SIM)-/.test(id));
export const simId = (id: string): string => id.replace(/^FAKE-/, "SIM-");
/** Short form for narrow cells: SIM-0143 stays readable, a real id is cut to 5 chars + last. */
export const shortPayId = (id: string): string => (isSimId(id) ? simId(id).replace(/^SIM-(CAPTURE|ORDER)-/, "SIM-").slice(0, 12) : `${id.slice(0, 5)}…${id.slice(-1)}`);

/** POST /api/reconcile: the Transaction Search counts, or on a demo instance (fake PayPal + seeded SIM ids) a neutral note and no changes. */
export type ReconcileResponse =
  | { mode: "simulated"; note: string }
  | { mode?: "paypal"; transactions: number; checked: number; matched: number; mismatch: number; pending: number; skipped?: number };
export type BannerTone = "ok" | "warn" | "bad" | "info";

/** Ledger banner after "Reconcile now": green only when nothing is off; any mismatch is a warning; a demo instance gets a neutral note. */
export function reconcileBanner(r: ReconcileResponse): { tone: BannerTone; msg: string } {
  if (r.mode === "simulated") return { tone: "info", msg: r.note };
  const seeded = r.skipped ? ` · ${r.skipped} recorded-run ${r.skipped === 1 ? "payment" : "payments"} left as recorded` : "";
  const msg = `Transaction Search: ${r.transactions} PayPal transactions · ${r.matched} matched · ${r.mismatch} mismatch · ${r.pending} not listed yet${seeded}`;
  return { tone: r.mismatch > 0 ? "warn" : "ok", msg: r.mismatch > 0 ? `${msg}. Expand a row with a red mark for the reason.` : msg };
}
