import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Nav } from "@/components/Nav";
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
        <a className="sr-only" href="#main">Skip to content</a>
        <div className="shell">
          <aside className="sidebar">
            <div className="brand">
              Reins<small>Agent spending</small>
            </div>
            <Nav />
          </aside>
          <main id="main" className="main">{children}</main>
        </div>
      </body>
    </html>
  );
}
