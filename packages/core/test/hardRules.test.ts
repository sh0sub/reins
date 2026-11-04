import { describe, expect, it } from "vitest";
import { evaluateHardRules, monthStartUtc, type HardRuleInput } from "../src/policy/hardRules.ts";

const NOW = Date.UTC(2026, 10, 2, 12, 0, 0);
const mandate = {
  monthlyLimitCents: 6000,
  perTxCapCents: 10000,
  currency: "USD",
  allowedMerchants: ["statista.com", "namecheap.com"],
  blockedMerchants: ["fiverr.com"],
  validFrom: null,
  validUntil: null,
};
const base = (patch: Partial<HardRuleInput> = {}, req: Partial<HardRuleInput["request"]> = {}): HardRuleInput => ({
  mandate,
  agentRevoked: false,
  request: { merchant: "statista.com", amountCents: 5900, currency: "USD", ...req },
  now: NOW,
  monthSpentCents: 0,
  recentRequestCount: 0,
  ...patch,
});
const failedRules = (i: HardRuleInput) => evaluateHardRules(i).failed.map((f) => f.rule);

describe("M5 hard rules (stage 1)", () => {
  it("1. passes a request inside every rule", () => {
    const out = evaluateHardRules(base());
    expect(out.pass).toBe(true);
    expect(out.failed).toEqual([]);
  });
  it("2. denies when there is no mandate", () => {
    expect(failedRules(base({ mandate: null }))).toEqual(["mandate_present"]);
  });
  it("3. denies a revoked agent", () => {
    expect(failedRules(base({ agentRevoked: true }))).toContain("agent_active");
  });
  it("4. denies an expired mandate", () => {
    expect(failedRules(base({ mandate: { ...mandate, validUntil: NOW - 1 } }))).toEqual(["mandate_window"]);
  });
  it("5. denies a mandate that is not yet valid", () => {
    expect(failedRules(base({ mandate: { ...mandate, validFrom: NOW + 1000 } }))).toEqual(["mandate_window"]);
  });
  it("6. denies above the per-purchase cap", () => {
    const m = { ...mandate, monthlyLimitCents: 100000 };
    expect(failedRules(base({ mandate: m }, { amountCents: 10001 }))).toEqual(["per_tx_cap"]);
    expect(failedRules(base({ mandate: m }, { amountCents: 10000 }))).toEqual([]);
  });
  it("7. denies when the monthly limit would be exceeded ($60 with $19 spent leaves $41)", () => {
    expect(failedRules(base({ monthSpentCents: 1900 }, { amountCents: 4100 }))).toEqual([]);
    expect(failedRules(base({ monthSpentCents: 1900 }, { amountCents: 4101 }))).toEqual(["monthly_limit"]);
  });
  it("7b. monthly rule uses one unit: spent + this = total vs cap", () => {
    const fail = evaluateHardRules(base({ monthSpentCents: 900 }, { amountCents: 45000 })).results.find((r) => r.rule === "monthly_limit");
    expect(fail?.ok).toBe(false);
    expect(fail?.detail).toBe("Spent $9.00 + this $450.00 = $459.00 > $60.00 monthly cap");
    expect(fail?.value).toBe("$459.00");
    const ok = evaluateHardRules(base({ monthSpentCents: 900 }, { amountCents: 1000 })).results.find((r) => r.rule === "monthly_limit");
    expect(ok?.detail).toBe("Spent $9.00 + this $10.00 = $19.00 ≤ $60.00 monthly cap");
  });
  it("8. denies a blocked merchant even when also allow-listed", () => {
    const m = { ...mandate, allowedMerchants: [...mandate.allowedMerchants, "fiverr.com"] };
    expect(failedRules(base({ mandate: m }, { merchant: "fiverr.com", amountCents: 100 }))).toEqual(["blocked_merchant"]);
  });
  it("9. denies a merchant missing from a non-empty allow list", () => {
    expect(failedRules(base({}, { merchant: "amazon.com", amountCents: 100 }))).toEqual(["allowlist"]);
  });
  it("10. treats an empty allow list as allow-all", () => {
    const m = { ...mandate, allowedMerchants: [] };
    expect(failedRules(base({ mandate: m }, { merchant: "amazon.com", amountCents: 100 }))).toEqual([]);
  });
  it("11. velocity: third request in 10 minutes passes, fourth is denied", () => {
    expect(failedRules(base({ recentRequestCount: 2 }))).toEqual([]);
    expect(failedRules(base({ recentRequestCount: 3 }))).toEqual(["velocity"]);
  });
  it("12. reports every failing rule (injection demo: $450 fiverr -> 3 FAILs)", () => {
    const out = evaluateHardRules(base({}, { merchant: "fiverr.com", amountCents: 45000 }));
    expect(out.pass).toBe(false);
    expect(out.failed.map((f) => f.rule).sort()).toEqual(["blocked_merchant", "monthly_limit", "per_tx_cap", "allowlist"].sort());
    expect(out.results.length).toBeGreaterThan(out.failed.length);
  });
  it("13. denies zero amounts and other currencies", () => {
    expect(failedRules(base({}, { amountCents: 0 }))).toEqual(["amount_valid"]);
    expect(failedRules(base({}, { currency: "EUR" }))).toEqual(["currency"]);
  });
  it("14. month start is the first of the month (UTC)", () => {
    expect(new Date(monthStartUtc(NOW)).toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });
});
