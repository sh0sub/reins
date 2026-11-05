/** Pure helpers for the app shell: sidebar agents, command palette search, Agents KPI. */
import { usdAmount } from "./format";

export interface ShellAgent {
  id: string;
  name: string;
  status: "active" | "paused" | "revoked";
  month_spent_cents: number;
  monthly_limit_cents: number | null;
}

export interface ShellRequest {
  request_id: string;
  display_id: string;
  agent_name: string;
  merchant: string;
  items: string;
  amount: string;
  status: string;
}

export type PaletteItem = { kind: "page" | "agent" | "request"; id: string; label: string; hint: string; href: string };

export const PAGES: Array<{ href: string; label: string; hint: string }> = [
  { href: "/overview", label: "Overview", hint: "Spend, caps and weekly summary" },
  { href: "/inbox", label: "Approvals", hint: "Requests waiting for you" },
  { href: "/agents", label: "Agents & mandates", hint: "Budgets, rules, MCP keys" },
  { href: "/ledger", label: "Ledger", hint: "Every request and PayPal payment" },
  { href: "/setup", label: "Settings", hint: "PayPal, payment method, Telegram" },
];

/** Used share of the monthly cap, 0..100 (null when the agent has no cap). */
export function capPct(a: Pick<ShellAgent, "month_spent_cents" | "monthly_limit_cents">): number | null {
  if (!a.monthly_limit_cents || a.monthly_limit_cents <= 0) return null;
  return Math.min(100, Math.round((a.month_spent_cents / a.monthly_limit_cents) * 100));
}

export function agentInitials(name: string): string {
  return (
    name
      .split(/[\s–-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("") || "?"
  );
}

/** "Agents 3 · 2 active · 1 paused" for the ledger KPI tile (revoked agents are not counted). */
export function agentsKpi(agents: Array<Pick<ShellAgent, "status">>) {
  const live = agents.filter((a) => a.status !== "revoked");
  const paused = live.filter((a) => a.status === "paused").length;
  const active = live.length - paused;
  return { total: live.length, active, paused, line: `${active} active · ${paused} paused` };
}

/** Case-insensitive search over pages, agents and requests; empty query lists pages and agents. */
export function searchPalette(query: string, agents: ShellAgent[], requests: ShellRequest[], limit = 8): PaletteItem[] {
  const q = query.trim().toLowerCase();
  const pages: PaletteItem[] = PAGES.map((p) => ({ kind: "page", id: p.href, label: p.label, hint: p.hint, href: p.href }));
  const ags: PaletteItem[] = agents
    .filter((a) => a.status !== "revoked")
    .map((a) => ({ kind: "agent", id: a.id, label: a.name, hint: a.status === "paused" ? "Agent · paused" : "Agent", href: `/agents?agent=${a.id}` }));
  if (!q) return [...pages, ...ags].slice(0, limit + 4);
  const hit = (...s: string[]) => s.some((x) => x.toLowerCase().includes(q));
  const reqs: PaletteItem[] = requests
    .filter((r) => hit(r.display_id, r.merchant, r.items, r.agent_name, r.status))
    .slice(0, limit)
    .map((r) => ({
      kind: "request",
      id: r.request_id,
      label: `${r.display_id} · ${r.merchant}`,
      hint: `${usdAmount(Number(r.amount))} · ${r.agent_name} · ${r.status.replace(/_/g, " ")}`,
      href: `/ledger?r=${encodeURIComponent(r.request_id)}&drawer=1`,
    }));
  return [...pages.filter((p) => hit(p.label, p.hint)), ...ags.filter((a) => hit(a.label)), ...reqs];
}
