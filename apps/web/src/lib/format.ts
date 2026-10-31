import type { LedgerRow } from "@reins/core";

export const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "2-digit" });
}

export type RuleResult = { rule: string; ok: boolean; detail: string };

export function hardRules(row: Pick<LedgerRow, "decisions">): RuleResult[] {
  return (row.decisions.find((d) => d.stage === "hard_rules")?.details as { results?: RuleResult[] } | null)?.results ?? [];
}

export function riskClass(risk: number | null): string {
  if (risk == null) return "status";
  return risk <= 3 ? "status status-ok" : risk >= 8 ? "status status-bad" : "status status-warn";
}

/** AUTO / HUMAN / DENIED label used in the ledger "Decision" column (S4). */
export function decisionLabel(row: Pick<LedgerRow, "decisions" | "decision" | "status">): "AUTO" | "HUMAN" | "DENIED" | "PENDING" | "EXPIRED" {
  if (row.status === "expired") return "EXPIRED";
  const human = row.decisions.find((d) => d.stage === "human");
  if (row.status === "denied") return "DENIED";
  if (human) return "HUMAN";
  if (row.decision === "AUTO_APPROVE") return "AUTO";
  return "PENDING";
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
export function statusChip(row: Pick<LedgerRow, "status">): { label: string; className: string } {
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
