import { describe, expect, it } from "vitest";
import { agentsKpi, capPct, searchPalette, type ShellAgent, type ShellRequest } from "../src/lib/shell.ts";
import { isUnknownRequest, resolveRequestId } from "../src/lib/format.ts";

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
