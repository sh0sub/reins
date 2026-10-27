"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { api, subscribeEvents } from "@/lib/api";

const ITEMS = [
  { href: "/inbox", label: "Approvals" },
  { href: "/agents", label: "Agents" },
];

export function Nav() {
  const path = usePathname();
  const [pending, setPending] = useState<number | null>(null);
  useEffect(() => {
    const load = () => api<{ items: unknown[] }>("/api/inbox").then((r) => setPending(r.items.length)).catch(() => setPending(null));
    load();
    return subscribeEvents(load);
  }, []);
  return (
    <nav className="nav" aria-label="Main">
      {ITEMS.map((i) => (
        <Link key={i.href} href={i.href} aria-current={path.startsWith(i.href) ? "page" : undefined}>
          <span>{i.label}</span>
          {i.href === "/inbox" && pending ? <span className="badge" aria-label={`${pending} pending`}>{pending}</span> : null}
        </Link>
      ))}
    </nav>
  );
}
