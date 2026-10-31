/**
 * S4 (#18) receipt returned to the agent: {capture_id, amount, merchant, receipt_url} on paid requests (MCP
 * request_purchase / get_request_status) and the receipt page data behind /receipts/:id.
 */
import { describe, expect, it } from "vitest";
import { harness, devopsMandate, report, scoutMandate } from "./harness.ts";

const renew = { merchant: "namecheap.com", amount: "12.98", items: "reins.dev domain renewal (1 year)", reason: "Domain expires Nov 30", category: "domains", client_request_id: "renew-reins-dev" };

describe("S4 receipt returned to the agent", () => {
  it("AUTO paid: the agent gets capture_id, amount, merchant and receipt_url; the receipt endpoint backs the page", async () => {
    const h = await harness();
    await h.vaulted();
    const devops = await h.agentClient("Claude Code - DevOps", devopsMandate);
    const r = await devops.call("request_purchase", renew);
    expect(r.data.status).toBe("paid");
    expect(r.data.receipt).toMatchObject({ amount: "12.98", currency: "USD", merchant: "namecheap.com", payout_batch_id: null, receipt_url: `http://localhost:3000/receipts/${r.data.request_id}` });
    expect(r.data.receipt.capture_id).toMatch(/\S+/);
    expect(Date.parse(r.data.receipt.paid_at)).not.toBeNaN();
    expect(r.text.split("\n")[0]).toBe(`Paid $12.98 to namecheap.com (${r.data.display_id}, capture ${r.data.receipt.capture_id}). Receipt: http://localhost:3000/receipts/${r.data.request_id}`);

    // get_request_status returns the same receipt (agents that poll)
    expect((await devops.call("get_request_status", { request_id: r.data.request_id })).data.receipt).toEqual(r.data.receipt);

    const page = await h.admin("GET", `/api/receipts/${r.data.request_id}`);
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({
      display_id: r.data.display_id,
      agent_name: "Claude Code - DevOps",
      merchant: "namecheap.com",
      items: "reins.dev domain renewal (1 year)",
      amount: "12.98",
      currency: "USD",
      approved_by: "auto",
      mandate_version: 1,
      payment: { strategy: "vaulted", capture_id: r.data.receipt.capture_id, reconciled: "unchecked" },
      receipt_url: r.data.receipt.receipt_url,
    });
    expect(JSON.stringify(page.body)).not.toContain("VAULT-TEST");
    // ledger rows carry the same link (ledger "View receipt")
    expect((await h.admin("GET", `/api/ledger/${r.data.request_id}`)).body.receipt.receipt_url).toBe(r.data.receipt.receipt_url);
  });

  it("human-approved receipt names the approver; unpaid requests have no receipt", async () => {
    const h = await harness();
    await h.vaulted();
    const scout = await h.agentClient("Research Scout", scoutMandate);
    const r = await scout.call("request_purchase", report(1));
    expect(r.data).toMatchObject({ status: "pending_human", receipt: null });
    expect(await h.admin("GET", `/api/receipts/${r.data.request_id}`)).toMatchObject({ status: 404, body: { error: "not_found" } });

    await h.admin("POST", `/api/requests/${r.data.request_id}/decision`, { action: "approve" });
    const paid = await scout.call("get_request_status", { request_id: r.data.request_id });
    expect(paid.data.receipt.receipt_url).toContain(`/receipts/${r.data.request_id}`);
    expect((await h.admin("GET", `/api/receipts/${r.data.request_id}`)).body.approved_by).toBe("web");
    expect((await h.admin("GET", "/api/receipts/req_doesnotexist0000000")).status).toBe(404);
  });

  it("supervised checkout: no receipt until the buyer approves on PayPal and the webhook captures", async () => {
    const h = await harness();
    const devops = await h.agentClient("Claude Code - DevOps", devopsMandate);
    const r = await devops.call("request_purchase", renew);
    expect(r.data).toMatchObject({ status: "awaiting_buyer", receipt: null });
    const orderId = (await h.admin("GET", `/api/ledger/${r.data.request_id}`)).body.payment.order_id as string;
    h.ctx.paypal.approveOrder(orderId);
    const { FakePayPalClient } = await import("@reins/core/testing");
    await h.admin("POST", "/api/webhooks/paypal", h.ctx.paypal.orderApprovedEvent(orderId), FakePayPalClient.headers() as unknown as Record<string, string>);
    const status = await devops.call("get_request_status", { request_id: r.data.request_id });
    expect(status.data.status).toBe("paid");
    expect(status.data.receipt).toMatchObject({ merchant: "namecheap.com", amount: "12.98" });
    expect(status.text).toContain("Receipt: http://localhost:3000/receipts/");
  });

  it("the receipt endpoint is an admin route: REINS_ADMIN_TOKEN guards it", async () => {
    const h = await harness({ adminToken: "s3cret-admin" });
    await h.vaulted();
    const devops = await h.agentClient("Claude Code - DevOps", devopsMandate);
    const r = await devops.call("request_purchase", renew);
    expect((await h.admin("GET", `/api/receipts/${r.data.request_id}`)).status).toBe(401);
    expect((await h.admin("GET", `/api/receipts/${r.data.request_id}`, undefined, { "x-reins-admin": "s3cret-admin" })).status).toBe(200);
  });
});
