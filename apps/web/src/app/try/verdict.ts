/** Pure helpers for the /try Decision panel: the one-line verdict, which rule rows stay visible, the split-preset run and its timeline. */
import { auditorWord } from "../../lib/format";

export interface VerdictRule {
  rule: string;
  ok: boolean;
  detail: string;
  value?: string;
  limit?: string;
}
export interface VerdictInput {
  status: string;
  /** The auditor stage, if it ran ("fooled" = the simulated fooled auditor, "mock" = the offline demo auditor). */
  llm: { decision: string; actor: string | null } | null;
  rules: VerdictRule[];
  auditor: "configured" | "fooled";
  /** Which PayPal took the order (from POST /api/try): "sandbox" = the real PayPal sandbox, "simulated" = the in-memory fake. */
  paypal?: "sandbox" | "simulated" | "none";
  /** PayPal order id, shown when the order waits for the buyer. */
  orderId?: string | null;
}

/** Who the auditor was, in words. */
export function auditorName(llm: VerdictInput["llm"], auditor: VerdictInput["auditor"]): string {
  if (auditor === "fooled") return "the fooled auditor";
  if (!llm) return "the auditor";
  return llm.actor === "mock" ? "the demo auditor" : "Claude";
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * One line at the top of the Decision panel, e.g. "Blocked — 3 hard rules failed; Claude said approve".
 * With the fooled auditor the line reports what it said (approve), even if code clamped the stored answer. On a request the
 * hard rules denied, the auditor's answer is marked advisory: it could not change the outcome.
 */
export function verdictLine({ status, llm, rules, auditor, paypal, orderId }: VerdictInput): { tone: "ok" | "warn" | "bad" | "info"; head: string; text: string } {
  const failed = rules.filter((r) => !r.ok).length;
  const said = llm ? `${auditorName(llm, auditor)} said ${auditor === "fooled" ? "approve" : auditorWord(llm.decision)}` : "auditor not called";
  const said1 = said[0]!.toUpperCase() + said.slice(1);
  const checks = rules.length ? `all ${plural(rules.length, "check")} passed` : "no rule failed";
  switch (status) {
    case "paid":
      return { tone: "ok", head: "Paid", text: `${checks}; ${said}` };
    case "denied":
      // the hard rules decide first; an auditor that still ran on a denied request is advisory only and cannot undo the denial
      if (failed) return { tone: "bad", head: "Blocked", text: llm ? `${plural(failed, "hard rule")} failed, so code denied it; ${said} (advisory only, it cannot override a rule)` : `${plural(failed, "hard rule")} failed; ${said}` };
      return { tone: "bad", head: "Blocked", text: llm ? said1 : "denied" };
    case "pending_human":
      return { tone: "warn", head: "Needs you", text: `${checks}; ${said}` };
    case "awaiting_buyer": {
      // supervised checkout: Reins approved and created the order; the buyer approving it on PayPal is the last step, not a failure
      const order = paypal === "sandbox" ? `real PayPal sandbox order${orderId ? ` ${orderId}` : ""} created` : `simulated PayPal order${orderId ? ` ${orderId}` : ""} created`;
      return { tone: "ok", head: "Approved by Reins", text: `${checks}; ${said}; ${order}. Buyer approval on PayPal is the last step` };
    }
    case "paying":
    case "approved":
      return { tone: "info", head: "Approved", text: `${checks}; ${said}; payment in progress` };
    case "failed":
      return { tone: "bad", head: "Payment failed", text: "nothing charged" };
    default:
      return { tone: "info", head: status.replace(/_/g, " "), text: said };
  }
}

/** Rules a judge cares about on every request (the limits); the rest pass on any well-formed request and fold away. */
export const KEY_RULES = ["per_tx_cap", "merchant_total", "monthly_limit", "allowlist"];

/** Visible rows: every failed rule plus the key limits; `hidden` is how many always-pass rows sit behind "Show all N checks". */
export function splitRules<T extends Pick<VerdictRule, "rule" | "ok">>(rules: T[]): { shown: T[]; hidden: number } {
  const shown = rules.filter((r) => !r.ok || KEY_RULES.includes(r.rule));
  return { shown, hidden: rules.length - shown.length };
}

/** Sends one order `repeat` times, strictly one after the other (each waits for the previous decision), reporting each as it lands. */
export async function runSequence<R>(repeat: number, sendOne: (i: number) => Promise<R>, onEach?: (r: R, i: number) => void): Promise<R[]> {
  const out: R[] = [];
  for (let i = 1; i <= Math.max(1, repeat); i++) {
    const r = await sendOne(i);
    out.push(r);
    onEach?.(r, i);
  }
  return out;
}

export interface TimelineItem {
  n: number;
  label: string;
  tone: "ok" | "warn" | "bad" | "info";
  /** Why it was not paid (the failed rule), null when paid or waiting. */
  reason: string | null;
}

/** One row per order of a multi-order preset: "Paid", or "Denied" with the rule that stopped it. */
export function timelineItem(n: number, r: { status: string; rules: VerdictRule[] }): TimelineItem {
  const failed = r.rules.filter((x) => !x.ok);
  if (r.status === "paid") return { n, label: "Paid", tone: "ok", reason: null };
  if (r.status === "denied") return { n, label: "Denied", tone: "bad", reason: failed.map((f) => f.detail).join("; ") || "denied by the auditor" };
  if (r.status === "pending_human") return { n, label: "Waiting for you", tone: "warn", reason: null };
  // supervised checkout (public demo on the real sandbox): approved by Reins, the buyer step on PayPal is still open
  if (r.status === "awaiting_buyer") return { n, label: "Approved", tone: "ok", reason: "PayPal order created, waiting for the buyer on PayPal" };
  // treasury payout sent, PayPal has not confirmed it yet (the page re-reads the row until it is Paid)
  if (r.status === "paying" || r.status === "approved") return { n, label: "Paying", tone: "info", reason: null };
  return { n, label: r.status.replace(/_/g, " "), tone: "info", reason: null };
}

/** "3 paid, 2 denied" (or "3 approved, 2 denied" when the orders wait for the buyer on PayPal) summary for the timeline heading. */
export function timelineSummary(items: TimelineItem[]): string {
  const count = (l: string) => items.filter((i) => i.label === l).length;
  return [
    [count("Paid"), "paid"],
    [count("Approved"), "approved"],
    [count("Paying"), "paying"],
    [count("Waiting for you"), "waiting"],
    [count("Denied"), "denied"],
  ]
    .filter(([n]) => (n as number) > 0)
    .map(([n, w]) => `${n} ${w}`)
    .join(", ");
}
