/** S4 ledger tiles: "Auto 19 · Human 4 · Blocked 1" uses the same split as the overview (anything a person touched is Human). */
import { describe, expect, it } from "vitest";
import { outcomeBucket } from "../src/lib/format.ts";

const row = (status: string, decision: string | null, stages: string[] = []) =>
  ({ status, decision, decisions: stages.map((stage) => ({ stage })) }) as unknown as Parameters<typeof outcomeBucket>[0];

describe("outcomeBucket", () => {
  it("auto, human (approved, rejected, pending, expired) and blocked", () => {
    expect(outcomeBucket(row("paid", "AUTO_APPROVE", ["hard_rules", "llm"]))).toBe("auto");
    expect(outcomeBucket(row("failed", "AUTO_APPROVE", ["hard_rules", "llm"]))).toBe("auto"); // declined card is still an auto decision
    expect(outcomeBucket(row("paid", "ASK_HUMAN", ["hard_rules", "llm", "human"]))).toBe("human");
    expect(outcomeBucket(row("denied", "DENY", ["hard_rules", "llm", "human"]))).toBe("human"); // rejected by the owner
    expect(outcomeBucket(row("pending_human", "ASK_HUMAN", ["llm"]))).toBe("human");
    expect(outcomeBucket(row("expired", "ASK_HUMAN", ["llm", "system"]))).toBe("human");
    expect(outcomeBucket(row("denied", "DENY", ["hard_rules", "llm"]))).toBe("blocked");
  });
});
