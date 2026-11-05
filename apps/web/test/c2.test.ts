import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { metadata as ledgerMeta } from "../src/app/ledger/layout.tsx";
import { metadata as inboxMeta } from "../src/app/inbox/layout.tsx";
import { metadata as overviewMeta } from "../src/app/overview/layout.tsx";

describe("C2-8 page titles and truthful labels", () => {
  it("every route has its own title and the root template appends Reins", () => {
    expect(readFileSync(new URL("../src/app/layout.tsx", import.meta.url), "utf8")).toContain('title: { default: "Reins", template: "%s - Reins" }');
    expect(ledgerMeta.title).toBe("Ledger");
    expect(inboxMeta.title).toBe("Approvals");
    expect(overviewMeta.title).toBe("Overview");
  });
  it("the offline auditor is labelled as a stand-in, not as Claude", () => {
    const drawer = readFileSync(new URL("../src/components/RequestDrawer.tsx", import.meta.url), "utf8");
    expect(drawer).toContain('p === "mock" ? "demo auditor (offline stand-in)"');
    const inbox = readFileSync(new URL("../src/app/inbox/page.tsx", import.meta.url), "utf8");
    expect(inbox).toContain("Demo auditor (offline stand-in)");
  });
  it("fake PayPal is never shown as a PayPal environment name", () => {
    const src = readFileSync(new URL("../src/app/overview/OverviewClient.tsx", import.meta.url), "utf8");
    expect(src).toContain("Sandbox demo data");
    expect(src).not.toContain("Fake PayPal (offline)");
  });
});

describe("C2-7 mobile approve bar", () => {
  it("is pinned to the bottom of the viewport on phones and the approve button carries the amount", () => {
    const css = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.act-bar \{ position: fixed; left: 0; right: 0; bottom: 0;/);
    expect(css).toContain("@media (max-width: 719px)");
    const page = readFileSync(new URL("../src/app/inbox/page.tsx", import.meta.url), "utf8");
    expect(page).toContain('className="stack-s act-bar"');
    expect(page).toContain("`Approve $${row.amount}`");
  });
});
