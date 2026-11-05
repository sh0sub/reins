"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useLive, useLiveStatus } from "@/lib/live";
import { agentInitials, capPct, pendingCount, sidebarAgents, withPlayground, type ShellAgent } from "@/lib/shell";
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

/** Waiting approvals for the badge. Requests raised from /try are left out unless the playground toggle is on. */
function usePending() {
  const include = useIncludePlayground();
  const initial = useShellInitial().inbox;
  const [items, setItems] = useState<Array<{ agent_name: string }> | null>(initial);
  const load = useCallback(() => {
    api<{ items: Array<{ agent_name: string }> }>("/api/inbox").then((r) => setItems(r.items)).catch(() => setItems(null));
  }, []);
  useEffect(load, [load]);
  useLive((e) => {
    if (e.type === "resync" || e.request?.status === "pending_human" || e.type === "request.updated") load();
  });
  return items === null ? null : pendingCount(items, include);
}

export function Nav() {
  const path = usePathname();
  const pending = usePending();
  const include = useIncludePlayground();
  return (
    <nav className="nav" aria-label="Main">
      {ITEMS.map((i) => (
        <Link key={i.href} href={withPlayground(i.href, include)} aria-current={path.startsWith(i.href) ? "page" : undefined}>
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
          <span className={ws.connected_at ? "dot dot-ok" : "dot"} />
          <b className="label">{ws.paypal_env === "live" ? "PayPal Live" : "PayPal Sandbox"}</b>
          <span className={ws.connected_at ? "status status-ok" : "status"}>{ws.connected_at ? "Connected" : "Not connected"}</span>
        </span>
        {ws.merchant_email && <span className="mono side-email" title={ws.merchant_email}>{ws.merchant_email}</span>}
        <span className="caption">
          {offline ? "Sandbox demo data · " : ""}
          {ws.payment_mode === "vaulted" ? "Automatic · vault" : ws.payment_mode === "treasury" ? "Treasury payouts" : "Supervised checkout"}
        </span>
        <Link className="caption" href="/proof">
          Recorded sandbox run: real ids
        </Link>
        <span className="row caption">
          <span className={ws.telegram_linked ? "dot dot-ok" : "dot"} />
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
  // a judge instance is an offline demo from the first paint on; the dot still shows the live-update connection
  const label = judge && (status === "live" || status === "connecting") ? "Offline demo" : status === "live" ? "Live" : status === "connecting" ? "Connecting…" : status === "reconnecting" ? "Reconnecting…" : "Offline · retrying";
  return (
    <header className="topbar">
      <span className="crumb">{title}</span>
      <CommandPalette />
      <div className="row">
        <span className="live" role="status" aria-live="polite">
          <span className={status === "live" ? "dot dot-ok" : status === "offline" ? "dot dot-bad" : "dot dot-warn"} />
          <span className="live-lbl">{label}</span>
        </span>
        {pending ? (
          <Link className="btn" href={withPlayground("/inbox", include)}>
            Pending {pending}
          </Link>
        ) : null}
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
