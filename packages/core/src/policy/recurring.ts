import type { RecurringCadence } from "@reins/db";
import { formatUsd } from "../money.ts";
import type { FinalDecision } from "./audit.ts";
import type { HardRuleResult } from "./hardRules.ts";

/**
 * Subscription guard (hard-rule stage, deterministic, no LLM). A request that declares `recurring` ("monthly" / "yearly")
 * is never auto-approved the first time for that agent and merchant: a person approves the first charge. Once a person
 * approved one at the same merchant with the same cadence and it was paid, later charges follow the normal path.
 * Caps are unchanged: they compare the actual charge. The yearly figure is shown as information only.
 */

/** What one charge adds up to over a year: monthly x 12, yearly x 1. */
export function annualCents(amountCents: number, recurring: RecurringCadence): number {
  return recurring === "monthly" ? amountCents * 12 : amountCents;
}

/** "$20.00 monthly · $240.00 a year". */
export function cadenceLine(amountCents: number, recurring: RecurringCadence): string {
  return `${formatUsd(amountCents)} ${recurring} · ${formatUsd(annualCents(amountCents, recurring))} a year`;
}

export interface RecurringOutcome {
  /** true: the first charge of a new subscription, so the decision is at least ASK_HUMAN. */
  escalate: boolean;
  /** Row for the hard-rule table (ok: never a failure; `ask` marks the escalation). */
  result: HardRuleResult & { ask?: boolean };
  reasonEn: string;
  reasonKo: string;
}

export function evaluateRecurring(input: { recurring: RecurringCadence; amountCents: number; merchant: string; approvedBefore: boolean }): RecurringOutcome {
  const { recurring, amountCents, approvedBefore } = input;
  const yearly = formatUsd(annualCents(amountCents, recurring));
  const math = `${formatUsd(amountCents)} ${recurring} = ${yearly} a year`;
  if (approvedBefore) {
    return {
      escalate: false,
      result: { rule: "recurring_first", ok: true, detail: `Subscription to ${input.merchant} already approved by a person: ${math}`, value: `${formatUsd(amountCents)} ${recurring}`, limit: "approved before" },
      reasonEn: `Known subscription: ${math}.`,
      reasonKo: `이미 승인된 구독: 연 ${yearly}.`,
    };
  }
  return {
    escalate: true,
    result: { rule: "recurring_first", ok: true, ask: true, detail: `New subscription: ${math}. A person approves the first charge.`, value: `${formatUsd(amountCents)} ${recurring}`, limit: "first charge: a person" },
    reasonEn: `New subscription: ${math}. A person approves the first charge.`,
    reasonKo: `새 구독: 연 ${yearly}. 첫 결제는 사람이 승인합니다.`,
  };
}

/** Code-enforced: the first charge of a new subscription is never AUTO_APPROVE. DENY stays DENY. */
export function applyRecurring(final: FinalDecision, escalate: boolean): FinalDecision {
  return escalate && final === "AUTO_APPROVE" ? "ASK_HUMAN" : final;
}
