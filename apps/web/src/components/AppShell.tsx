"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { EnvBadge, Nav, SideAgents, SideFoot, TopBar, WorkspaceRow } from "./Nav";

/** Routes that render as a focused single column without the app chrome (S1 onboarding). */
const BARE = ["/setup"];

export function AppShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  if (BARE.some((p) => path === p || path.startsWith(`${p}/`))) {
    return (
      <main id="main" className="bare">
        {children}
      </main>
    );
  }
  return (
    <div className="shell">
      <aside className="sidebar">
        <Link className="brand" href="/overview" aria-label="Reins overview">
          <span className="brand-mark" aria-hidden />
          <span>
            Reins<small>Agent spending</small>
          </span>
          <EnvBadge />
        </Link>
        <WorkspaceRow />
        <Nav />
        <SideAgents />
        <SideFoot />
      </aside>
      <div>
        <TopBar />
        <main id="main" className="main">
          {children}
        </main>
      </div>
    </div>
  );
}
