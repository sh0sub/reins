"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useLive, useLiveStatus } from "@/lib/live";
import { agentInitials, capPct, type ShellAgent } from "@/lib/shell";
import { CommandPalette } from "./CommandPalette";
import { Icon, type IconName } from "./Icon";

const ITEMS: Array<{ href: string; label: string; icon: IconName }> = [
  { href: "/overview", label: "Overview", icon: "home" },
  { href: "/inbox", label: "Approvals", icon: "inbox" },
  { href: "/agents", label: "Agents", icon: "bot" },
  { href: "/ledger", label: "Ledger", icon: "list" },
  { href: "/setup", label: "Setup", icon: "gear" },
];

function usePending() {
  const [pending, setPending] = useState<number | null>(null);
  const load = useCallback(() => {
    api<{ items: unknown[] }>("/api/inbox").then((r) => setPending(r.items.length)).catch(() => setPending(null));
  }, []);
  useEffect(load, [load]);
  useLive((e) => {
    if (e.type === "resync" || e.request?.status === "pending_human" || e.type === "request.updated") load();
  });
  return pending;
}

export function Nav() {
  const path = usePathname();
  const pending = usePending();
  return (
    <nav className="nav" aria-label="Main">
      {ITEMS.map((i) => (
        <Link key={i.href} href={i.href} aria-current={path.startsWith(i.href) ? "page" : undefined}>
          <Icon name={i.icon} />
          <span className="lbl">{i.label}</span>
          {i.href === "/inbox" && pending ? (
            <span className="badge" aria-label={`${pending} pending`}>
              {pending}
            </span>
          ) : null}
        </Link>
      ))}
    </nav>
  );
}

interface WorkspaceView {
  name?: string;
  paypal_env: string;
  merchant_email: string | null;
  payment_mode: string;
  has_vault: boolean;
  telegram_linked: boolean;
  connected_at: string | null;
}

/** Demo identity for the user block (the product has a single workspace owner, no accounts). */
export const DEMO_USER = { name: "Minji Park", handle: "@minji_builds" };

function useWorkspace() {
  const path = usePathname();
  const [ws, setWs] = useState<WorkspaceView | null>(null);
  const load = useCallback(() => {
    api<WorkspaceView>("/api/workspace").then(setWs).catch(() => setWs(null));
  }, []);
  useEffect(load, [load, path]);
  useLive((e) => {
    if (e.type === "resync") load();
  });
  return ws;
}

/** Brand row: product mark + Sandbox badge so a viewer never mistakes it for a live app. */
export function EnvBadge() {
  const ws = useWorkspace();
  if (!ws || ws.paypal_env === "live") return null;
  return <span className="env-badge">Sandbox</span>;
}

export function WorkspaceRow() {
  const ws = useWorkspace();
  const name = ws?.name && ws.name !== "Workspace" ? ws.name : `${DEMO_USER.name.split(" ")[0]}'s workspace`;
  return (
    <div className="side-ws">
      <span className="avatar avatar-sm" aria-hidden>
        {name[0]}
      </span>
      <span>{name}</span>
    </div>
  );
}

/** Sidebar agents list: dot (paused = grey), name and the share of the monthly cap used. */
export function SideAgents() {
  const [agents, setAgents] = useState<ShellAgent[] | null>(null);
  const path = usePathname();
  const load = useCallback(() => {
    api<{ agents: ShellAgent[] }>("/api/agents").then((r) => setAgents(r.agents.filter((a) => a.status !== "revoked"))).catch(() => setAgents(null));
  }, []);
  useEffect(load, [load, path]);
  useLive((e) => {
    if (e.type === "resync" || e.type === "request.updated") load();
  });
  return (
    <section className="side-agents" aria-label="Agents">
      <div className="side-label">Agents</div>
      {agents === null ? null : agents.length === 0 ? (
        <Link className="caption side-empty" href="/agents">
          No agents yet. Add one.
        </Link>
      ) : (
        <ul className="side-list">
          {agents.map((a) => {
            const pct = capPct(a);
            return (
              <li key={a.id}>
                <Link href={`/agents?agent=${a.id}`} className="side-agent" title={a.status === "paused" ? `${a.name} (paused)` : a.name}>
                  <i className={a.status === "paused" ? "dot" : "dot dot-ok"} aria-hidden />
                  <span className="side-agent-n">{a.name}</span>
                  {a.status === "paused" && <span className="sr-only">paused</span>}
                  {pct !== null && (
                    <b className="num" aria-label={`${pct}% of monthly cap`}>
                      {pct}%
                    </b>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Sidebar footer: PayPal connection (env, merchant email, Telegram) and the user block. */
export function SideFoot() {
  const ws = useWorkspace();
  const user = (
    <div className="side-me">
      <span className="avatar avatar-sm" aria-hidden>
        {agentInitials(DEMO_USER.name)}
      </span>
      <div>
        <b>{DEMO_USER.name}</b>
        <span>{DEMO_USER.handle}</span>
      </div>
    </div>
  );
  if (!ws) return <div className="side-foot"><span className="caption">PayPal status unavailable</span>{user}</div>;
  const offline = ws.paypal_env === "fake";
  return (
    <div className="side-foot">
      <div className="stack-s">
        <span className="side-pp">
          <span className={ws.connected_at ? "dot dot-ok" : "dot"} />
          <b className="label">{ws.paypal_env === "live" ? "PayPal Live" : "PayPal Sandbox"}</b>
          <span className={ws.connected_at ? "status status-ok" : "status"}>{ws.connected_at ? "Connected" : "Not connected"}</span>
        </span>
        {ws.merchant_email && <span className="mono side-email" title={ws.merchant_email}>{ws.merchant_email}</span>}
        <span className="caption">
          {offline ? "Offline fake PayPal · " : ""}
          {ws.payment_mode === "vaulted" ? "Automatic · vault" : ws.payment_mode === "treasury" ? "Treasury payouts" : "Supervised checkout"}
        </span>
        <span className="row caption">
          <span className={ws.telegram_linked ? "dot dot-ok" : "dot"} />
          Telegram {ws.telegram_linked ? "linked" : "not linked"}
        </span>
      </div>
      {user}
    </div>
  );
}

const TITLES: Record<string, string> = { "/overview": "Overview", "/inbox": "Approvals", "/agents": "Agents & mandates", "/ledger": "Ledger", "/setup": "Setup", "/receipts": "Receipt" };

/** 56px top bar: page name, live connection state, pending shortcut. */
export function TopBar() {
  const path = usePathname();
  const status = useLiveStatus();
  const pending = usePending();
  const title = Object.entries(TITLES).find(([k]) => path.startsWith(k))?.[1] ?? "Reins";
  const label = status === "live" ? "Live" : status === "connecting" ? "Connecting…" : status === "reconnecting" ? "Reconnecting…" : "Offline · retrying";
  return (
    <header className="topbar">
      <span className="crumb">{title}</span>
      <CommandPalette />
      <div className="row">
        <span className="live" role="status" aria-live="polite">
          <span className={status === "live" ? "dot dot-ok" : status === "offline" ? "dot dot-bad" : "dot dot-warn"} />
          {label}
        </span>
        {pending ? (
          <Link className="btn" href="/inbox">
            Pending {pending}
          </Link>
        ) : null}
      </div>
    </header>
  );
}
