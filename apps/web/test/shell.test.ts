import { describe, expect, it } from "vitest";
import { PLAYGROUND_AGENT } from "@reins/core";
import config from "../next.config.ts";
import { PLAYGROUND_AGENT_NAME, agentsKpi, capPct, pendingCount, playgroundCaption, searchPalette, sidebarAgents, withPlayground, type ShellAgent, type ShellRequest } from "../src/lib/shell.ts";
import { isUnknownRequest, linkedRequest, resolveRequestId, showKo } from "../src/lib/format.ts";

const agents: ShellAgent[] = [
  { id: "a1", name: "Claude Code – DevOps", status: "active", month_spent_cents: 1998, monthly_limit_cents: 15000 },
  { id: "a2", name: "Research Scout", status: "active", month_spent_cents: 5900, monthly_limit_cents: 10000 },
  { id: "a3", name: "Desk Restock Bot", status: "paused", month_spent_cents: 3899, monthly_limit_cents: 16000 },
  { id: "a4", name: "Old", status: "revoked", month_spent_cents: 0, monthly_limit_cents: null },
];
const reqs: ShellRequest[] = [
  { request_id: "rq1", display_id: "R-0143", agent_name: "Research Scout", merchant: "fiverr.com", items: "Logo design package", amount: "450.00", status: "denied" },
  { request_id: "rq2", display_id: "R-0142", agent_name: "Research Scout", merchant: "statista.com", items: "Report", amount: "59.00", status: "paid" },
];

describe("shell helpers", () => {
  it("cap percent is clamped and null without a cap", () => {
    expect(capPct(agents[0]!)).toBe(13);
    expect(capPct(agents[1]!)).toBe(59);
    expect(capPct(agents[3]!)).toBeNull();
    expect(capPct({ month_spent_cents: 500, monthly_limit_cents: 100 })).toBe(100);
  });
  it("agents KPI counts active and paused, skipping revoked", () => {
    expect(agentsKpi(agents)).toEqual({ total: 3, active: 2, paused: 1, line: "2 active · 1 paused" });
    expect(agentsKpi([]).line).toBe("0 active · 0 paused");
  });
  it("palette finds requests, agents and pages", () => {
    expect(searchPalette("fiverr", agents, reqs).map((i) => i.href)).toEqual(["/ledger?r=rq1&drawer=1"]);
    expect(searchPalette("r-0142", agents, reqs)[0]).toMatchObject({ kind: "request", id: "rq2" });
    expect(searchPalette("desk", agents, reqs)[0]).toMatchObject({ kind: "agent", href: "/agents?agent=a3", hint: "Agent · paused" });
    expect(searchPalette("ledger", agents, reqs)[0]).toMatchObject({ kind: "page", href: "/ledger" });
    expect(searchPalette("", agents, reqs).some((i) => i.id === "a4")).toBe(false);
    expect(searchPalette("zzz", agents, reqs)).toEqual([]);
  });
});

describe("resolveRequestId (S6 deep link /ledger/R-0143)", () => {
  const rows = [{ display_id: "R-0143", request_id: "req_abc" }];
  it("maps a display id to the internal id, case-insensitive", () => {
    expect(resolveRequestId(rows, "R-0143")).toBe("req_abc");
    expect(resolveRequestId(rows, "r-0143")).toBe("req_abc");
  });
  it("keeps internal ids and waits (null) for unknown display ids", () => {
    expect(resolveRequestId(rows, "req_abc")).toBe("req_abc");
    expect(resolveRequestId(null, "R-0143")).toBeNull();
    expect(resolveRequestId(rows, "R-9999")).toBeNull();
    expect(resolveRequestId(rows, null)).toBeNull();
  });
});

describe("isUnknownRequest (/ledger/R-9999 notice)", () => {
  const rows = [{ display_id: "R-0143", request_id: "req_abc" }];
  it("flags only loaded rows with an unmatched display id", () => {
    expect(isUnknownRequest(rows, "R-9999")).toBe(true);
    expect(isUnknownRequest(rows, "R-0143")).toBe(false);
    expect(isUnknownRequest(null, "R-9999")).toBe(false);
    expect(isUnknownRequest(rows, "req_zzz")).toBe(false);
    expect(isUnknownRequest(rows, null)).toBe(false);
  });
});

describe("shared approval links (M5)", () => {
  const pending = [{ request_id: "rq2", display_id: "R-0142" }];
  const decided = [{ request_id: "rq1", display_id: "R-0143" }];
  it("never falls back to another request", () => {
    expect(linkedRequest(pending, decided, null)).toEqual({ kind: "none" });
    expect(linkedRequest(pending, decided, "r-0142")).toEqual({ kind: "pending", row: pending[0] });
    expect(linkedRequest(pending, decided, "R-0143")).toEqual({ kind: "decided", row: decided[0] });
    expect(linkedRequest(pending, decided, "R-9999")).toEqual({ kind: "missing" });
    expect(linkedRequest(pending, null, "R-0143")).toEqual({ kind: "unknown-yet" });
  });
  it("Korean audit text is hidden outside a Korean locale", () => {
    expect(showKo()).toBe(false); // node: no document
  });
});

describe("playground rows stay out of badges and the sidebar unless the toggle is on", () => {
  const inbox = [{ agent_name: "Research Scout" }, { agent_name: PLAYGROUND_AGENT_NAME }, { agent_name: PLAYGROUND_AGENT_NAME }];
  const withPg: ShellAgent[] = [...agents, { id: "pg", name: PLAYGROUND_AGENT_NAME, status: "active", month_spent_cents: 0, monthly_limit_cents: 30000 }];
  it("the client constant matches the server's playground agent name", () => {
    expect(PLAYGROUND_AGENT_NAME).toBe(PLAYGROUND_AGENT);
  });
  it("Approvals badge and Pending N count only real agents by default, all of them with ?playground=1", () => {
    expect(pendingCount(inbox, false)).toBe(1);
    expect(pendingCount(inbox, true)).toBe(3);
    expect(pendingCount([{ agent_name: PLAYGROUND_AGENT_NAME }], false)).toBe(0);
  });
  it("sidebar agents hide the Playground Agent and revoked agents, unless the toggle is on", () => {
    expect(sidebarAgents(withPg, false).map((a) => a.name)).toEqual(["Claude Code – DevOps", "Research Scout", "Desk Restock Bot"]);
    expect(sidebarAgents(withPg, true).map((a) => a.name)).toContain(PLAYGROUND_AGENT_NAME);
  });
  it("in-app links keep ?playground=1 while it is on", () => {
    expect(withPlayground("/inbox", true)).toBe("/inbox?playground=1");
    expect(withPlayground("/ledger?r=x", true)).toBe("/ledger?r=x&playground=1");
    expect(withPlayground("/inbox", false)).toBe("/inbox");
  });
  it("toggle caption agrees in number", () => {
    expect(playgroundCaption(1, true)).toBe("1 request from /try is counted below");
    expect(playgroundCaption(3, false)).toBe("3 requests from /try are left out so these numbers match the seeded demo");
    expect(playgroundCaption(0, false)).toContain("0 requests from /try are");
  });
  it("/approvals redirects to /inbox with no fixed query, so Next forwards ?playground=1 untouched", async () => {
    const [r] = await config.redirects!();
    expect(r).toMatchObject({ source: "/approvals", destination: "/inbox" });
    expect(r!.destination).not.toContain("?");
  });
});
