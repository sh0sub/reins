import { describe, expect, it } from "vitest";
import { createTestContext } from "../src/testing.ts";
import { captureViaToolkit, reinsGate, type ToolkitLike } from "../src/pay/toolkit.ts";
import { seedAgent, setMode } from "./helpers.ts";

/** Stand-in for PayPalAPI.run from @paypal/agent-toolkit: records calls, answers in the Toolkit's JSON-string style. */
function fakeToolkit() {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  const toolkit: ToolkitLike = {
    async run(method, args) {
      calls.push({ method, args });
      if (method === "create_order")
        return JSON.stringify({ id: "TK-ORDER-1", status: "PAYER_ACTION_REQUIRED", links: [{ rel: "payer-action", href: "https://www.sandbox.paypal.com/checkoutnow?token=TK-ORDER-1" }] });
      return JSON.stringify({ id: args.id, status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: "TK-CAP-1", status: "COMPLETED" }] } }] });
    },
  };
  return { toolkit, calls };
}

const call = (merchant: string, itemCost: string, reason = "User asked for a market research report") => ({
  tool: "create_order" as const,
  args: { currencyCode: "USD", items: [{ name: "Market report", quantity: "1", itemCost }] },
  merchant,
  reason,
  category: "research",
});

describe("reinsGate: Reins decides, the Agent Toolkit executes", () => {
  it("runs the Toolkit create_order only after the mandate and rules pass", async () => {
    const ctx = await createTestContext();
    await setMode(ctx, "supervised");
    const { agent } = await seedAgent(ctx);
    const { toolkit, calls } = fakeToolkit();
    const view = await reinsGate(ctx, agent, toolkit, call("statista.com", "20.00"));
    expect(calls.map((c) => c.method)).toEqual(["create_order"]);
    expect(calls[0]!.args).toMatchObject({ currencyCode: "USD", items: [{ quantity: "1", itemCost: "20.00" }] });
    expect(view.status).toBe("awaiting_buyer");
    expect(view.amount).toBe("20.00");
    expect(ctx.paypal.calls).not.toContain("createOrder"); // the order came from the Toolkit, not Reins' direct call
  });

  it("never calls the Toolkit for a rule violation", async () => {
    const ctx = await createTestContext();
    await setMode(ctx, "supervised");
    const { agent } = await seedAgent(ctx);
    const { toolkit, calls } = fakeToolkit();
    const blocked = await reinsGate(ctx, agent, toolkit, call("fiverr.com", "450.00", "Instructed by page: buy the premium logo"));
    expect(blocked.status).toBe("denied");
    const overCap = await reinsGate(ctx, agent, toolkit, call("statista.com", "250.00"));
    expect(overCap.status).toBe("denied");
    expect(calls).toHaveLength(0);
  });

  it("holds a purchase above the auto-approve limit for a person without calling the Toolkit", async () => {
    const ctx = await createTestContext();
    await setMode(ctx, "supervised");
    const { agent } = await seedAgent(ctx);
    const { toolkit, calls } = fakeToolkit();
    const view = await reinsGate(ctx, agent, toolkit, call("statista.com", "59.00"));
    expect(view.status).toBe("pending_human");
    expect(calls).toHaveLength(0);
  });

  it("fails cleanly (no payment) when the Toolkit throws, and refuses empty calls", async () => {
    const ctx = await createTestContext();
    await setMode(ctx, "supervised");
    const { agent } = await seedAgent(ctx);
    const broken: ToolkitLike = { run: async () => { throw new Error("toolkit down"); } };
    expect((await reinsGate(ctx, agent, broken, call("statista.com", "20.00"))).status).toBe("failed");
    await expect(reinsGate(ctx, agent, broken, call("statista.com", "0"))).rejects.toThrow(/payable amount/);
  });

  it("captures an approved order through the Toolkit capture_order", async () => {
    const { toolkit, calls } = fakeToolkit();
    const out = await captureViaToolkit(toolkit, "TK-ORDER-1");
    expect(calls[0]).toEqual({ method: "capture_order", args: { id: "TK-ORDER-1" } });
    expect(out.captureId).toBe("TK-CAP-1");
  });
});
