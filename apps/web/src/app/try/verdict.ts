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
 * With the fooled auditor the line reports what it said (approve), even if code clamped the stored answer.
 */
export function verdictLine({ status, llm, rules, auditor }: VerdictInput): { tone: "ok" | "warn" | "bad" | "info"; head: string; text: string } {
  const failed = rules.filter((r) => !r.ok).length;
  const said = llm ? `${auditorName(llm, auditor)} said ${auditor === "fooled" ? "approve" : auditorWord(llm.decision)}` : "auditor not called";
  const said1 = said[0]!.toUpperCase() + said.slice(1);
  const checks = rules.length ? `all ${plural(rules.length, "check")} passed` : "no rule failed";
  switch (status) {
    case "paid":
      return { tone: "ok", head: "Paid", text: `${checks}; ${said}` };
    case "denied":
      if (failed) return { tone: "bad", head: "Blocked", text: `${plural(failed, "hard rule")} failed; ${said}` };
      return { tone: "bad", head: "Blocked", text: llm ? said1 : "denied" };
    case "pending_human":
      return { tone: "warn", head: "Needs you", text: `${checks}; ${said}` };
    case "awaiting_buyer":
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
  return { n, label: r.status.replace(/_/g, " "), tone: "info", reason: null };
}

/** "3 paid, 2 denied" summary for the timeline heading. */
export function timelineSummary(items: TimelineItem[]): string {
  const count = (l: string) => items.filter((i) => i.label === l).length;
  return [
    [count("Paid"), "paid"],
    [count("Waiting for you"), "waiting"],
    [count("Denied"), "denied"],
  ]
    .filter(([n]) => (n as number) > 0)
    .map(([n, w]) => `${n} ${w}`)
    .join(", ");
}
