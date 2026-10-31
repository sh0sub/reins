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

export interface Overview {
  generated_at: string;
  paypal_env: string;
  period: { month_start: string; now: string };
  totals: { spent_cents: number; limit_cents: number; agents: number; pct: number };
  status: { level: "ok" | "warn" | "bad"; message: string };
  decisions: { total: number; auto: number; human: number; blocked: number; pending: number };
  /** Requests settled without a tap (auto + blocked) vs. an all-manual flow. */
  approvals_saved: number;
  agents: AgentBudget[];
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

export async function getOverview(ctx: ReinsContext): Promise<Overview> {
  const { db } = ctx;
  const now = ctx.now();
  const since = monthStartUtc(now);
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

  const spent = budgets.reduce((s, a) => s + a.spent_cents, 0);
  const limit = budgets.reduce((s, a) => s + (a.limit_cents ?? 0), 0);
  const over = budgets.filter((a) => a.limit_cents && a.pct >= 100);
  const near = budgets.filter((a) => a.limit_cents && a.pct >= CAP_WARN_PCT && a.pct < 100);
  const status: Overview["status"] = over.length
    ? { level: "bad", message: `${over[0]!.name} reached its monthly cap` }
    : near.length
      ? { level: "warn", message: `${near[0]!.name} used ${near[0]!.pct}% of its cap` }
      : { level: "ok", message: budgets.length ? "All agents within caps" : "No agents yet" };

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
    period: { month_start: new Date(since).toISOString(), now: new Date(now).toISOString() },
    totals: { spent_cents: spent, limit_cents: limit, agents: budgets.length, pct: limit ? Math.round((spent / limit) * 100) : 0 },
    status,
    decisions: counts,
    approvals_saved: counts.auto + counts.blocked,
    agents: budgets,
    categories: [...categories.entries()].map(([category, cents]) => ({ category, cents })).sort((a, b) => b.cents - a.cents),
    recent,
  };
}
