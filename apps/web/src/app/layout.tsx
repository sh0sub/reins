import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { getInbox, judgeMode, listAgentSummaries } from "@reins/core";
import { AppShell } from "@/components/AppShell";
import { EMPTY_SHELL, type ShellInitial } from "@/components/ShellData";
import { getContext } from "@/server/context";
import { workspaceView } from "@/server/workspace";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Reins", template: "%s - Reins" },
  description: "Spending guardrails for AI agents on PayPal",
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" };
export const dynamic = "force-dynamic";

/**
 * Server-renders what the sidebar and top bar show (PayPal card, agents list, approvals badge, "Offline demo"), so the first
 * paint is never "Connecting…" or "Checking connection…". The client refetches right after; any error here falls back to that.
 */
async function shellInitial(): Promise<ShellInitial> {
  const judge = judgeMode();
  // with an admin token set the API is guarded, so the layout must not read the ledger around it
  if (process.env.REINS_ADMIN_TOKEN) return { ...EMPTY_SHELL, judge };
  try {
    const ctx = await getContext();
    const [workspace, agents, inbox] = await Promise.all([workspaceView(ctx), listAgentSummaries(ctx), getInbox(ctx)]);
    return { judge, workspace, agents, inbox: inbox.map((i) => ({ agent_name: i.agent_name })) };
  } catch {
    return { ...EMPTY_SHELL, judge };
  }
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const initial = await shellInitial();
  return (
    <html lang="en">
      <body>
        <a className="skip" href="#main">Skip to content</a>
        <AppShell initial={initial}>{children}</AppShell>
      </body>
    </html>
  );
}
