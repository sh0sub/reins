"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useLive, useLiveStatus } from "@/lib/live";
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
  paypal_env: string;
  merchant_email: string | null;
  payment_mode: string;
  has_vault: boolean;
  telegram_linked: boolean;
  connected_at: string | null;
}

/** Sidebar footer: PayPal connection + Telegram link state (always visible so demo viewers see "Sandbox"). */
export function SideFoot() {
  const path = usePathname();
  const [ws, setWs] = useState<WorkspaceView | null>(null);
  const load = useCallback(() => {
    api<WorkspaceView>("/api/workspace").then(setWs).catch(() => setWs(null));
  }, []);
  useEffect(load, [load, path]);
  useLive((e) => {
    if (e.type === "resync") load();
  });
  if (!ws) return <div className="side-foot caption">PayPal status unavailable</div>;
  const env = ws.paypal_env === "sandbox" ? "PayPal Sandbox" : ws.paypal_env === "fake" ? "Fake PayPal (offline)" : ws.paypal_env;
  return (
    <div className="side-foot">
      <div className="stack-s">
        <span className="caption">{env}</span>
        <span className="row">
          <span className={ws.connected_at ? "dot dot-ok" : "dot"} />
          <span className="label">{ws.connected_at ? "Connected" : "Not connected"}</span>
        </span>
        <span className="caption">{ws.payment_mode === "vaulted" ? "Automatic · vault" : ws.payment_mode === "treasury" ? "Treasury payouts" : "Supervised checkout"}</span>
      </div>
      <span className="row caption">
        <span className={ws.telegram_linked ? "dot dot-ok" : "dot"} />
        Telegram {ws.telegram_linked ? "linked" : "not linked"}
      </span>
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
