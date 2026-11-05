import {
  COMMITTED_STATUSES,
  getActiveMandate,
  getWorkspace,
  listAgents,
  listDecisionsFor,
  listRequestsSince,
  spendSinceCents,
  type Decision,
  type PurchaseRequest,
  type ReinsDb,
} from "@reins/db";
import { monthStartUtc } from "./policy/hardRules.ts";
import { displayId } from "./pay/strategies.ts";
import type { ReinsContext } from "./service.ts";

/**
 * Feature S1 / screen S7 "Overview": every number the dashboard shows, computed from the same repositories and
 * spend rule the rest of the app uses (spendSinceCents over COMMITTED_STATUSES, active mandate monthly limit).
 */

/** Cap usage at or above this share turns the status chip amber. */
export const CAP_WARN_PCT = 80;
export const RECENT_FEED_SIZE = 8;
/** S7 period toggle: calendar month to date (default) or a rolling 30 days. Caps stay monthly either way. */
export type OverviewPeriod = "month" | "30d";
export const ROLLING_DAYS = 30;
export const parsePeriod = (v: string | null | undefined): OverviewPeriod => (v === "30d" ? "30d" : "month");

/** How a request was settled: by policy alone (auto / blocked), by a person (human), or still in review. */
export type Outcome = "auto" | "human" | "blocked" | "reviewing";

export function outcomeOf(r: Pick<PurchaseRequest, "status" | "finalDecision">, decisions: Pick<Decision, "stage">[]): Outcome {
  if (decisions.some((d) => d.stage === "human") || r.status === "pending_human" || r.status === "expired") return "human";
  if (r.status === "denied") return "blocked";
  if (r.status === "reviewing") return "reviewing";
  if (r.finalDecision === "AUTO_APPROVE") return "auto";
  return "human";
}

export interface AgentBudget {
  id: string;
  name: string;
  mandate_version: number | null;
  spent_cents: number;
  limit_cents: number | null;
  /** Share of the monthly limit used, 0 when there is no mandate. Can exceed 100. */
  pct: number;
}

/** Per-agent month-to-date spend vs. the active mandate limit (revoked agents excluded). */
export async function agentBudgets(db: ReinsDb, now: number): Promise<AgentBudget[]> {
  const since = monthStartUtc(now);
  const agents = (await listAgents(db)).filter((a) => !a.revokedAt);
  return Promise.all(
    agents.map(async (a) => {
      const m = await getActiveMandate(db, a.id);
      const spent = await spendSinceCents(db, a.id, since);
      const limit = m?.monthlyLimitCents ?? null;
      return { id: a.id, name: a.name, mandate_version: m?.version ?? null, spent_cents: spent, limit_cents: limit, pct: limit ? Math.round((spent / limit) * 100) : 0 };
    }),
  );
}

export interface FeedItem {
  request_id: string;
  display_id: string;
  agent_id: string;
  agent_name: string;
  merchant: string;
  amount_cents: number;
  status: PurchaseRequest["status"];
  outcome: Outcome;
  /** "auto-approved", "approved via telegram", "hard rules", … */
  via: string;
  created_at: string;
}

/** S2 "Money protected": everything is computed from the ledger. The only assumption is the stated seconds per approval. */
export const SECONDS_PER_APPROVAL = 30;
export interface Protection {
  /** Sum of the agents' monthly caps: the most they can spend in a month. A shared unlimited key has no such bound. */
  exposure_cents: number;
  exposure_agents: number;
  /** Requests stopped by hard rules or the auditor in the period, and the dollars they asked for. */
  blocked_cents: number;
  blocked_count: number;
  /** Largest blocked request, with how many hard rules it failed. */
  blocked_top: { request_id: string; display_id: string; merchant: string; amount_cents: number; rules_failed: number } | null;
  auto_paid: number;
  requests: number;
  /** (auto + blocked) x SECONDS_PER_APPROVAL, in minutes (1 decimal). */
  minutes_saved: number;
  seconds_per_approval: number;
  /** True for the seeded sandbox demo data, so the card says it is not live traffic. */
  demo_data: boolean;
}

export interface Overview {
  generated_at: string;
  paypal_env: string;
  /** `start` is the first instant counted by totals, decisions, categories and the feed (month start or now - 30 days). */
  period: { kind: OverviewPeriod; start: string; month_start: string; now: string };
  /** spent_cents covers the period; limit_cents is the sum of monthly caps (the status chip and cap bars stay month to date). */
  totals: { spent_cents: number; limit_cents: number; agents: number; pct: number };
  status: { level: "ok" | "warn" | "bad"; message: string };
  decisions: { total: number; auto: number; human: number; blocked: number; pending: number };
  /** Requests settled without a tap (auto + blocked) vs. an all-manual flow. */
  approvals_saved: number;
  agents: AgentBudget[];
  protection: Protection;
  categories: Array<{ category: string; cents: number }>;
  recent: FeedItem[];
}

const hasRule = (d: Decision) => d.stage === "hard_rules" && d.decision === "DENY";

function viaOf(r: PurchaseRequest, outcome: Outcome, decisions: Decision[]): string {
  const human = decisions.filter((d) => d.stage === "human").at(-1);
  if (human) return `${human.decision === "APPROVE" ? "approved" : "rejected"} via ${human.actor ?? "web"}`;
  if (r.status === "pending_human") return "waiting for you";
  if (r.status === "expired") return "no answer in time";
  if (outcome === "blocked") return decisions.some(hasRule) ? "hard rules" : "auditor";
  if (outcome === "auto") return "auto-approved";
  return "in review";
}

export async function getOverview(ctx: ReinsContext, period: OverviewPeriod = "month"): Promise<Overview> {
  const { db } = ctx;
  const now = ctx.now();
  const monthStart = monthStartUtc(now);
  const since = period === "30d" ? now - ROLLING_DAYS * 86_400_000 : monthStart;
  const [ws, budgets, allAgents, monthRequests] = await Promise.all([getWorkspace(db), agentBudgets(db, now), listAgents(db), listRequestsSince(db, since)]);
  const names = new Map(allAgents.map((a) => [a.id, a.name]));
  const decisions = await listDecisionsFor(db, monthRequests.map((r) => r.id));
  const byRequest = new Map<string, Decision[]>();
  for (const d of decisions) byRequest.set(d.requestId, [...(byRequest.get(d.requestId) ?? []), d]);

  const counts = { total: monthRequests.length, auto: 0, human: 0, blocked: 0, pending: 0 };
  const categories = new Map<string, number>();
  for (const r of monthRequests) {
    const o = outcomeOf(r, byRequest.get(r.id) ?? []);
    if (o !== "reviewing") counts[o]++;
    if (r.status === "pending_human") counts.pending++;
    if (COMMITTED_STATUSES.includes(r.status)) {
      const c = r.category?.trim() || "uncategorized";
      categories.set(c, (categories.get(c) ?? 0) + r.amountCents);
    }
  }

  const spent =
    period === "month" ? budgets.reduce((s, a) => s + a.spent_cents, 0) : (await Promise.all(budgets.map((a) => spendSinceCents(db, a.id, since)))).reduce((s, c) => s + c, 0);
  const limit = budgets.reduce((s, a) => s + (a.limit_cents ?? 0), 0);
  const over = budgets.filter((a) => a.limit_cents && a.pct >= 100);
  const near = budgets.filter((a) => a.limit_cents && a.pct >= CAP_WARN_PCT && a.pct < 100);
  const paused = allAgents.filter((a) => a.pausedAt && !a.revokedAt);
  const status: Overview["status"] = over.length
    ? { level: "bad", message: `${over[0]!.name} reached its monthly cap` }
    : near.length
      ? { level: "warn", message: `${near[0]!.name} used ${near[0]!.pct}% of its cap` }
      : paused.length
        ? { level: "warn", message: paused.length === 1 ? `${paused[0]!.name} is paused` : `${paused.length} agents are paused` }
        : { level: "ok", message: budgets.length ? "All agents within caps" : "No agents yet" };

  let blockedCents = 0;
  let blockedCount = 0;
  let top: Protection["blocked_top"] = null;
  for (const r of monthRequests) {
    const ds = byRequest.get(r.id) ?? [];
    if (outcomeOf(r, ds) !== "blocked") continue;
    blockedCents += r.amountCents;
    blockedCount++;
    if (!top || r.amountCents > top.amount_cents) {
      const results = (ds.find((d) => d.stage === "hard_rules")?.details as { results?: Array<{ ok: boolean }> } | null)?.results ?? [];
      top = { request_id: r.id, display_id: displayId(r.seq), merchant: r.merchant, amount_cents: r.amountCents, rules_failed: results.filter((x) => !x.ok).length };
    }
  }
  const savedMinutes = Math.round(((counts.auto + counts.blocked) * SECONDS_PER_APPROVAL) / 6) / 10;

  const recent = monthRequests
    .filter((r) => r.status !== "reviewing")
    .slice(0, RECENT_FEED_SIZE)
    .map((r): FeedItem => {
      const ds = byRequest.get(r.id) ?? [];
      const outcome = outcomeOf(r, ds);
      return {
        request_id: r.id,
        display_id: displayId(r.seq),
        agent_id: r.agentId,
        agent_name: names.get(r.agentId) ?? r.agentId,
        merchant: r.merchant,
        amount_cents: r.amountCents,
        status: r.status,
        outcome,
        via: viaOf(r, outcome, ds),
        created_at: new Date(r.createdAt).toISOString(),
      };
    });

  return {
    generated_at: new Date(now).toISOString(),
    paypal_env: ws.paypalEnv,
    period: { kind: period, start: new Date(since).toISOString(), month_start: new Date(monthStart).toISOString(), now: new Date(now).toISOString() },
    totals: { spent_cents: spent, limit_cents: limit, agents: budgets.length, pct: limit ? Math.round((spent / limit) * 100) : 0 },
    status,
    decisions: counts,
    approvals_saved: counts.auto + counts.blocked,
    agents: budgets,
    protection: {
      exposure_cents: limit,
      exposure_agents: budgets.length,
      blocked_cents: blockedCents,
      blocked_count: blockedCount,
      blocked_top: top,
      auto_paid: counts.auto,
      requests: counts.total,
      minutes_saved: savedMinutes,
      seconds_per_approval: SECONDS_PER_APPROVAL,
      demo_data: ws.paypalEnv === "fake" || allAgents.some((a) => a.keyPrefix.startsWith("rk_demo_")),
    },
    categories: [...categories.entries()].map(([category, cents]) => ({ category, cents })).sort((a, b) => b.cents - a.cents),
    recent,
  };
}
