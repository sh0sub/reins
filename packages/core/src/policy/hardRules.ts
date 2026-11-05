import type { Mandate } from "@reins/db";
import { formatUsd } from "../money.ts";
import { merchantInList } from "../merchant.ts";

/** Velocity rule: at most VELOCITY_MAX requests per VELOCITY_WINDOW_MS; the next one is denied. */
export const VELOCITY_MAX = 3;
export const VELOCITY_WINDOW_MS = 10 * 60 * 1000;

export type HardRuleId =
  | "mandate_present"
  | "agent_active"
  | "agent_paused"
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
  /** S6 hard-rule table: what the request had ("$450.00", "fiverr.com") and the mandate limit it was checked against. */
  value?: string;
  limit?: string;
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
  /** Owner paused the agent: every request is denied before the auditor or PayPal is called. */
  agentPaused?: boolean;
  request: { merchant: string; amountCents: number; currency: string };
  now: number;
  /** Committed spend in the current calendar month, excluding this request. */
  monthSpentCents: number;
  /** Requests by this agent inside VELOCITY_WINDOW_MS, excluding this request. */
  recentRequestCount: number;
  /** Override of VELOCITY_MAX (the /try playground relaxes it so a judge can click freely). */
  velocityMax?: number;
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
  const add = (rule: HardRuleId, ok: boolean, detail: string, value?: string, limit?: string) =>
    results.push({ rule, ok, detail, ...(value !== undefined ? { value } : {}), ...(limit !== undefined ? { limit } : {}) });

  add("agent_active", !input.agentRevoked, input.agentRevoked ? "Agent key is revoked" : "Agent key active", input.agentRevoked ? "revoked" : "active", "active");
  if (input.agentPaused) add("agent_paused", false, "Agent paused", "paused", "active");

  if (!mandate) {
    add("mandate_present", false, "No mandate configured for this agent", "missing", "required");
    return finish(results);
  }
  add("mandate_present", true, "Mandate found", "present", "required");

  const notYet = mandate.validFrom != null && now < mandate.validFrom;
  const expired = mandate.validUntil != null && now > mandate.validUntil;
  add(
    "mandate_window",
    !notYet && !expired,
    expired ? "Mandate expired" : notYet ? "Mandate not yet valid" : "Mandate within validity window",
    new Date(now).toISOString().slice(0, 10),
    mandate.validFrom == null && mandate.validUntil == null
      ? "no window"
      : `${mandate.validFrom == null ? "…" : new Date(mandate.validFrom).toISOString().slice(0, 10)} – ${mandate.validUntil == null ? "…" : new Date(mandate.validUntil).toISOString().slice(0, 10)}`,
  );

  const amountOk = Number.isInteger(request.amountCents) && request.amountCents > 0;
  add("amount_valid", amountOk, amountOk ? "Amount is positive" : "Amount must be greater than zero", formatUsd(request.amountCents), "> $0.00");

  const curOk = request.currency.toUpperCase() === mandate.currency.toUpperCase();
  add("currency", curOk, curOk ? `Currency ${mandate.currency}` : `Currency ${request.currency} not allowed (mandate is ${mandate.currency})`, request.currency.toUpperCase(), mandate.currency.toUpperCase());

  if (mandate.perTxCapCents != null) {
    const ok = request.amountCents <= mandate.perTxCapCents;
    add(
      "per_tx_cap",
      ok,
      ok
        ? `${formatUsd(request.amountCents)} within per-purchase cap ${formatUsd(mandate.perTxCapCents)}`
        : `${formatUsd(request.amountCents)} exceeds per-purchase cap ${formatUsd(mandate.perTxCapCents)}`,
      formatUsd(request.amountCents),
      `≤ ${formatUsd(mandate.perTxCapCents)}`,
    );
  }

  const monthTotal = input.monthSpentCents + request.amountCents;
  const monthlyOk = monthTotal <= mandate.monthlyLimitCents;
  const monthlyMath = `Spent ${formatUsd(input.monthSpentCents)} + this ${formatUsd(request.amountCents)} = ${formatUsd(monthTotal)}`;
  add(
    "monthly_limit",
    monthlyOk,
    monthlyOk
      ? `${monthlyMath} ≤ ${formatUsd(mandate.monthlyLimitCents)} monthly cap`
      : `${monthlyMath} > ${formatUsd(mandate.monthlyLimitCents)} monthly cap`,
    formatUsd(monthTotal),
    `≤ ${formatUsd(mandate.monthlyLimitCents)}`,
  );

  const blocked = merchantInList(request.merchant, mandate.blockedMerchants);
  add(
    "blocked_merchant",
    !blocked,
    blocked ? `${request.merchant} is blocked` : "Merchant not on block list",
    request.merchant,
    mandate.blockedMerchants.length ? `not ${mandate.blockedMerchants.join(", ")}` : "no block list",
  );

  if (mandate.allowedMerchants.length > 0) {
    const allowed = merchantInList(request.merchant, mandate.allowedMerchants);
    add("allowlist", allowed, allowed ? `${request.merchant} is allowed` : `${request.merchant} is not on the allow list`, request.merchant, mandate.allowedMerchants.join(", "));
  }

  const velocityMax = input.velocityMax ?? VELOCITY_MAX;
  const velocityOk = input.recentRequestCount < velocityMax;
  add(
    "velocity",
    velocityOk,
    velocityOk
      ? `${input.recentRequestCount} request(s) in the last 10 minutes`
      : `${input.recentRequestCount} requests in the last 10 minutes (max ${velocityMax})`,
    `${input.recentRequestCount} earlier`,
    `< ${velocityMax} per 10 min`,
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
