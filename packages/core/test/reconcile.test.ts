import { describe, expect, it } from "vitest";
import { getPaymentByRequest, updateWorkspace } from "@reins/db";
import { authenticateAgent, createAgent, judge, reconcilePayments, saveMandate, submitPurchase } from "../src/index.ts";
import { createTestContext } from "../src/testing.ts";

async function paidRequests(n: number) {
  const ctx = await createTestContext();
  await updateWorkspace(ctx.db, { paymentMode: "vaulted", vaultId: "VAULT-1" });
  const a = await createAgent(ctx, "DevOps");
  await saveMandate(ctx, a.agent.id, { monthly_limit: "500", auto_approve_limit: "30", categories: ["domains"], purpose: "Domain renewal and hosting for developer infrastructure" });
  const agent = await authenticateAgent(ctx, `Bearer ${a.api_key}`);
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const v = await submitPurchase(ctx, agent, { merchant: "namecheap.com", amount: `1${i}.98`, items: `domain ${i}`, reason: "Domain renewal for the project", category: "domains", client_request_id: `c${i}` });
    expect(v.status).toBe("paid");
    ids.push(v.request_id);
  }
  return { ctx, ids };
}

describe("M11 Transaction Search reconciliation", () => {
  it("judge(): matched / amount mismatch / reversed / pending / missing", () => {
    const p = { amountCents: 1298, currency: "USD" };
    const t = (value: string, status = "S", currency = "USD") => ({ transaction_info: { transaction_id: "T1", transaction_status: status, transaction_amount: { currency_code: currency, value } } });
    expect(judge(p, t("12.98"), false).state).toBe("matched");
    expect(judge(p, t("-12.98"), false).state).toBe("matched"); // payouts are negative for the sender
    expect(judge(p, t("12.99"), false)).toEqual({ state: "mismatch", note: "amount USD 12.99 != USD 12.98" });
    expect(judge(p, t("12.98", "S", "EUR"), false).state).toBe("mismatch");
    expect(judge(p, t("12.98", "V"), false)).toEqual({ state: "mismatch", note: "PayPal status V" });
    expect(judge(p, t("12.98", "P"), false).state).toBe("unchecked");
    expect(judge(p, undefined, false)).toEqual({ state: "unchecked", note: "not in Transaction Search yet" });
    expect(judge(p, undefined, true)).toEqual({ state: "mismatch", note: "missing in Transaction Search" });
  });

  it("nightly run: captures matched by transaction id, a tampered amount flagged, missing ones stay pending", async () => {
    const { ctx, ids } = await paidRequests(3);
    const [a, b, c] = await Promise.all(ids.map((id) => getPaymentByRequest(ctx.db, id)));
    // b: PayPal reports a different amount; c: not in Transaction Search yet (lag)
    for (const o of ctx.paypal.orders.values()) {
      const cap = o.purchase_units?.[0]?.payments?.captures?.[0];
      if (cap?.id === b!.captureId) o.purchase_units![0]!.amount = { currency_code: "USD", value: "99.00" };
      if (cap?.id === c!.captureId) o.status = "PAYER_ACTION_REQUIRED";
    }
    const r = await reconcilePayments(ctx);
    expect(r).toMatchObject({ checked: 3, matched: 1, mismatch: 1, pending: 1, transactions: 2 });
    expect((await getPaymentByRequest(ctx.db, ids[0]!))!.reconciled).toBe("matched");
    expect((await getPaymentByRequest(ctx.db, ids[1]!))!.reconcileNote).toBe("amount USD 99.00 != USD 11.98");
    expect((await getPaymentByRequest(ctx.db, ids[2]!))!.reconciled).toBe("unchecked");
    expect(a!.captureId).toBeTruthy();
    expect(ctx.paypal.calls.filter((x) => x === "searchTransactions")).toHaveLength(1);
  });

  it("matches by custom_id when the capture id is unknown, and caps the window at 31 days", async () => {
    const { ctx, ids } = await paidRequests(1);
    ctx.paypal.orders.clear();
    ctx.paypal.extraTransactions.push({ transaction_info: { transaction_id: "OTHER", custom_field: ids[0], transaction_status: "S", transaction_amount: { currency_code: "USD", value: "10.98" } } });
    const r = await reconcilePayments(ctx, { start: 0 });
    expect(r.matched).toBe(1);
    expect(Date.parse(r.window.end) - Date.parse(r.window.start)).toBeLessThanOrEqual(31 * 86_400_000 + 2 * 3_600_000);
  });
});
