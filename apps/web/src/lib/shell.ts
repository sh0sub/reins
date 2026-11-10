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

/** Name of the /try demo agent (packages/core playground.ts PLAYGROUND_AGENT; kept in sync by a test). */
export const PLAYGROUND_AGENT_NAME = "Playground Agent";

/** Sidebar agents: revoked agents never show; the /try Playground Agent only shows when the playground toggle is on. */
export function sidebarAgents<T extends Pick<ShellAgent, "name" | "status">>(agents: T[], includePlayground: boolean): T[] {
  return agents.filter((a) => a.status !== "revoked" && (includePlayground || a.name !== PLAYGROUND_AGENT_NAME));
}

/** Approvals badge and "Pending N": requests raised from /try are not counted unless the playground toggle is on. */
export function pendingCount(items: Array<{ agent_name: string }>, includePlayground: boolean): number {
  return includePlayground ? items.length : items.filter((i) => i.agent_name !== PLAYGROUND_AGENT_NAME).length;
}

/** Keeps `?playground=1` on in-app links while the toggle is on. */
export function withPlayground(href: string, includePlayground: boolean): string {
  if (!includePlayground) return href;
  return href.includes("?") ? `${href}&playground=1` : `${href}?playground=1`;
}

/** "1 request from /try is" / "3 requests from /try are": the Overview toggle caption. */
export function playgroundCaption(n: number, included: boolean): string {
  const subject = `${n} ${n === 1 ? "request" : "requests"} from /try ${n === 1 ? "is" : "are"}`;
  return included ? `${subject} counted below` : `${subject} left out so these numbers match the seeded demo`;
}

/**
 * Top-bar status: the label matches the sidebar card, "Simulated PayPal" (grey dot) on the fake client, "PayPal Sandbox" /
 * "PayPal Live" (green dot) on a real one; a dropped live stream still wins.
 */
export function topbarStatus(status: "connecting" | "live" | "reconnecting" | "offline", simulated: boolean, paypalEnv?: string | null): { label: string; dot: string; title?: string } {
  if (status === "offline") return { label: "Offline · retrying", dot: "dot dot-bad" };
  if (status === "reconnecting") return { label: "Reconnecting…", dot: "dot dot-warn" };
  if (simulated) return { label: "Simulated PayPal", dot: "dot", title: "Simulated PayPal: no money moves, ids start with SIM-. Live updates are on." };
  if (status !== "live") return { label: "Connecting…", dot: "dot dot-warn" };
  if (paypalEnv === "sandbox") return { label: "PayPal Sandbox", dot: "dot dot-ok", title: "Real PayPal sandbox (test money, no real charges). Seeded history is demo data. Live updates are on." };
  if (paypalEnv === "live") return { label: "PayPal Live", dot: "dot dot-ok", title: "Real PayPal. Live updates are on." };
  return { label: "Live", dot: "dot dot-ok" };
}
