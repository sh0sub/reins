"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useLive, useLiveStatus } from "@/lib/live";
import { agentInitials, capPct, pendingCount, sidebarAgents, topbarStatus, withPlayground, type ShellAgent } from "@/lib/shell";
import { useIncludePlayground, useShellInitial, type WorkspaceView } from "./ShellData";
import { CommandPalette } from "./CommandPalette";
import { Icon, type IconName } from "./Icon";

const ITEMS: Array<{ href: string; label: string; icon: IconName }> = [
  { href: "/overview", label: "Overview", icon: "home" },
  { href: "/inbox", label: "Approvals", icon: "inbox" },
  { href: "/agents", label: "Agents", icon: "bot" },
  { href: "/ledger", label: "Ledger", icon: "list" },
  { href: "/setup", label: "Settings", icon: "gear" },
];

/**
 * Waiting approvals for the badge and "Pending N". Same list, same count as the /inbox header and tab (playground requests included:
 * if /inbox shows it, the badge counts it). Reloaded on every live event and when the tab becomes visible again.
 */
export function usePending() {
  const initial = useShellInitial().inbox;
  const [items, setItems] = useState<Array<{ agent_name: string }> | null>(initial);
  const load = useCallback(() => {
    api<{ items: Array<{ agent_name: string }> }>("/api/inbox").then((r) => setItems(r.items)).catch(() => setItems(null));
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [load]);
  useLive(load);
  return items === null ? null : pendingCount(items, true);
}

export function Nav() {
  const path = usePathname();
  const pending = usePending();
  const include = useIncludePlayground();
  return (
    <nav className="nav" aria-label="Main">
      {ITEMS.map((i) => (
        <Link key={i.href} href={withPlayground(i.href, include)} aria-label={i.href === "/inbox" && pending ? `${i.label}, ${pending} pending` : i.label} aria-current={path.startsWith(i.href) ? "page" : undefined}>
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

/** Demo identity for the user block (the product has a single workspace owner, no accounts). */
export const DEMO_USER = { name: "Minji Park", handle: "@minji_builds" };
/** On a judge instance (REINS_TRY=1) the made-up persona gives way to what the viewer is: a judge on an offline demo. */
export const JUDGE_USER = { name: "Judge", handle: "offline demo" };

function useWorkspace() {
  const path = usePathname();
  const [ws, setWs] = useState<WorkspaceView | null>(useShellInitial().workspace);
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
  const name = ws?.name && ws.name !== "Workspace" ? ws.name : ws?.judge_mode ? "Demo workspace" : `${DEMO_USER.name.split(" ")[0]}'s workspace`;
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
  const include = useIncludePlayground();
  const [all, setAll] = useState<ShellAgent[] | null>(useShellInitial().agents);
  const agents = all === null ? null : sidebarAgents(all, include);
  const path = usePathname();
  const load = useCallback(() => {
    api<{ agents: ShellAgent[] }>("/api/agents").then((r) => setAll(r.agents)).catch(() => setAll(null));
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
  const who = ws?.judge_mode ? JUDGE_USER : DEMO_USER;
  const user = (
    <div className="side-me">
      <span className="avatar avatar-sm" aria-hidden>
        {agentInitials(who.name)}
      </span>
      <div>
        <b>{who.name}</b>
        <span>{who.handle}</span>
      </div>
    </div>
  );
  if (!ws) return <div className="side-foot"><span className="side-pp"><span className="dot" /><b className="label">PayPal Sandbox</b></span><span className="caption">Checking connection…</span>{user}</div>;
  const offline = ws.paypal_env === "fake";
  return (
    <div className="side-foot">
      <div className="stack-s">
        <span className="side-pp">
          <span className={!offline && ws.connected_at ? "dot dot-ok" : "dot"} aria-hidden />
          <b className="label">{offline ? "Simulated PayPal" : ws.paypal_env === "live" ? "PayPal Live" : "PayPal Sandbox"}</b>
          <span className={!offline && ws.connected_at ? "status status-ok" : "status"}>{offline ? "SIM ids" : ws.connected_at ? "Connected" : "Not connected"}</span>
        </span>
        {!offline && ws.merchant_email && <span className="mono side-email" title={ws.merchant_email}>{ws.merchant_email}</span>}
        <span className="caption">
          {offline ? "No money moves here · " : ""}
          {ws.payment_mode === "vaulted" ? "Automatic · vault" : ws.payment_mode === "treasury" ? "Treasury payouts" : "Supervised checkout"}
        </span>
        <Link className="caption" href="/proof">
          {offline ? "Real sandbox proof: recorded ids" : "Sandbox proof: spike-run ids"}
        </Link>
        <span className="caption">
          Telegram {ws.telegram_linked ? "linked" : "optional, not linked"}
        </span>
      </div>
      {user}
    </div>
  );
}

const TITLES: Record<string, string> = { "/overview": "Overview", "/inbox": "Approvals", "/agents": "Agents & mandates", "/ledger": "Ledger", "/setup": "Settings", "/receipts": "Receipt", "/try": "Try an agent", "/proof": "Proof" };

/** 56px top bar: page name, live connection state, pending shortcut. */
export function TopBar() {
  const path = usePathname();
  const status = useLiveStatus();
  const pending = usePending();
  const include = useIncludePlayground();
  const ws = useWorkspace();
  const judge = useShellInitial().judge || Boolean(ws?.judge_mode);
  const who = judge ? JUDGE_USER : DEMO_USER;
  const title = Object.entries(TITLES).find(([k]) => path.startsWith(k))?.[1] ?? "Reins";
  // the same words as the sidebar card: "Simulated PayPal" (judge, fake env, grey) or "PayPal Sandbox" (real client); the dot only turns red when the live stream drops
  const sim = topbarStatus(status, judge || ws?.paypal_env === "fake", ws?.paypal_env);
  const n = pending ?? 0;
  return (
    <header className="topbar">
      <span className="crumb">{title}</span>
      <CommandPalette />
      <div className="row">
        <span className="live" role="status" aria-live="polite" title={sim.title}>
          <span className={sim.dot} />
          <span className="live-lbl">{sim.label}</span>
        </span>
        {/* always present so the header does not jump between pages; quiet when nothing waits */}
        <Link className={n ? "btn" : "btn btn-quiet"} href={withPlayground("/inbox", include)} aria-label={n ? `Pending ${n}: open Approvals` : "Pending 0: nothing waits for you"}>
          Pending {n}
        </Link>
        <Link className="bell" href={withPlayground("/inbox", include)} aria-label={pending ? `Notifications: ${pending} pending approval${pending === 1 ? "" : "s"}` : "Notifications: nothing pending"}>
          <Icon name="bell" />
          {pending ? <i className="bell-dot" aria-hidden /> : null}
        </Link>
        <span className="avatar avatar-sm" role="img" aria-label={who.name} title={who.name}>
          {agentInitials(who.name)}
        </span>
      </div>
    </header>
  );
}
