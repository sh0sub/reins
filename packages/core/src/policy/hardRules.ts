import type { Mandate } from "@reins/db";
import { formatUsd } from "../money.ts";
import { merchantInList } from "../merchant.ts";

/** Velocity rule: at most VELOCITY_MAX requests per VELOCITY_WINDOW_MS; the next one is denied. */
export const VELOCITY_MAX = 3;
export const VELOCITY_WINDOW_MS = 10 * 60 * 1000;

export type HardRuleId =
  | "mandate_present"
  | "agent_active"
  | "mandate_window"
  | "amount_valid"
  | "currency"
  | "per_tx_cap"
  | "monthly_limit"
  | "blocked_merchant"
  | "allowlist"
  | "velocity";

export interface HardRuleResult {
  rule: HardRuleId;
  ok: boolean;
  detail: string;
}

export interface HardRuleInput {
  mandate: Pick<
    Mandate,
    | "monthlyLimitCents"
    | "perTxCapCents"
    | "currency"
    | "allowedMerchants"
    | "blockedMerchants"
    | "validFrom"
    | "validUntil"
  > | null;
  agentRevoked: boolean;
  request: { merchant: string; amountCents: number; currency: string };
  now: number;
  /** Committed spend in the current calendar month, excluding this request. */
  monthSpentCents: number;
  /** Requests by this agent inside VELOCITY_WINDOW_MS, excluding this request. */
  recentRequestCount: number;
}

export interface HardRuleOutcome {
  pass: boolean;
  results: HardRuleResult[];
  failed: HardRuleResult[];
}

/**
 * Stage 1 of the policy engine. Deterministic, no LLM. Every rule is evaluated (no short-circuit) so the
 * UI can show all FAIL rows; any failure means DENY before the auditor can approve anything.
 */
export function evaluateHardRules(input: HardRuleInput): HardRuleOutcome {
  const { mandate, request, now } = input;
  const results: HardRuleResult[] = [];
  const add = (rule: HardRuleId, ok: boolean, detail: string) => results.push({ rule, ok, detail });

  add("agent_active", !input.agentRevoked, input.agentRevoked ? "Agent key is revoked" : "Agent key active");

  if (!mandate) {
    add("mandate_present", false, "No mandate configured for this agent");
    return finish(results);
  }
  add("mandate_present", true, "Mandate found");

  const notYet = mandate.validFrom != null && now < mandate.validFrom;
  const expired = mandate.validUntil != null && now > mandate.validUntil;
  add(
    "mandate_window",
    !notYet && !expired,
    expired ? "Mandate expired" : notYet ? "Mandate not yet valid" : "Mandate within validity window",
  );

  const amountOk = Number.isInteger(request.amountCents) && request.amountCents > 0;
  add("amount_valid", amountOk, amountOk ? "Amount is positive" : "Amount must be greater than zero");

  const curOk = request.currency.toUpperCase() === mandate.currency.toUpperCase();
  add("currency", curOk, curOk ? `Currency ${mandate.currency}` : `Currency ${request.currency} not allowed (mandate is ${mandate.currency})`);

  if (mandate.perTxCapCents != null) {
    const ok = request.amountCents <= mandate.perTxCapCents;
    add(
      "per_tx_cap",
      ok,
      ok
        ? `${formatUsd(request.amountCents)} within per-purchase cap ${formatUsd(mandate.perTxCapCents)}`
        : `${formatUsd(request.amountCents)} exceeds per-purchase cap ${formatUsd(mandate.perTxCapCents)}`,
    );
  }

  const remaining = mandate.monthlyLimitCents - input.monthSpentCents;
  const monthlyOk = request.amountCents <= remaining;
  add(
    "monthly_limit",
    monthlyOk,
    monthlyOk
      ? `${formatUsd(Math.max(remaining, 0))} of ${formatUsd(mandate.monthlyLimitCents)} left this month`
      : `Only ${formatUsd(Math.max(remaining, 0))} of ${formatUsd(mandate.monthlyLimitCents)} left this month`,
  );

  const blocked = merchantInList(request.merchant, mandate.blockedMerchants);
  add("blocked_merchant", !blocked, blocked ? `${request.merchant} is blocked` : "Merchant not on block list");

  if (mandate.allowedMerchants.length > 0) {
    const allowed = merchantInList(request.merchant, mandate.allowedMerchants);
    add("allowlist", allowed, allowed ? `${request.merchant} is allowed` : `${request.merchant} is not on the allow list`);
  }

  const velocityOk = input.recentRequestCount < VELOCITY_MAX;
  add(
    "velocity",
    velocityOk,
    velocityOk
      ? `${input.recentRequestCount} request(s) in the last 10 minutes`
      : `${input.recentRequestCount} requests in the last 10 minutes (max ${VELOCITY_MAX})`,
  );

  return finish(results);
}

function finish(results: HardRuleResult[]): HardRuleOutcome {
  const failed = results.filter((r) => !r.ok);
  return { pass: failed.length === 0, results, failed };
}

/** First instant of the calendar month (UTC) containing `now`. */
export function monthStartUtc(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}
