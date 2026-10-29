import type { Metadata, Viewport } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { Nav, SideFoot, TopBar } from "@/components/Nav";
import "./globals.css";

export const metadata: Metadata = {
  title: "Reins",
  description: "Spending guardrails for AI agents on PayPal",
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a className="skip" href="#main">Skip to content</a>
        <div className="shell">
          <aside className="sidebar">
            <Link className="brand" href="/inbox">
              <span className="brand-mark" aria-hidden />
              <span>
                Reins<small>Agent spending</small>
              </span>
            </Link>
            <Nav />
            <SideFoot />
          </aside>
          <div>
            <TopBar />
            <main id="main" className="main">{children}</main>
          </div>
        </div>
      </body>
    </html>
  );
}
