/**
 * Spikes #33 (D2), #27, #28 — run: pnpm spike scripts/spikes/d2-payment.ts
 * Needs .env: PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PUBLIC_BASE_URL (any https/http URL for return_url).
 * (a) plain order -> buyer approval -> capture
 * (b) store_in_vault=ON_SUCCESS order -> approval -> capture -> vault id
 *     -> buyer-absent re-order with vault_id (variant 1: vault_id only; variant 2: + stored_credential MERCHANT)
 * Writes docs/spikes/d2-payment.md with statuses and error codes (emails/tokens redacted).
 */
import { firstCapture, type CreateOrderBody } from "@reins/core";
import { code, describeError, paypal, waitForApproval, writeReport } from "./lib.ts";

const pp = paypal();
const base = (process.env.PUBLIC_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const sections: Array<[string, string]> = [];
const ctx = { return_url: `${base}/pay/return`, cancel_url: `${base}/pay/cancel`, user_action: "PAY_NOW" as const, shipping_preference: "NO_SHIPPING" as const };
const unit = (v: string) => ({ amount: { currency_code: "USD", value: v }, description: "Reins spike" });
const rid = (s: string) => `spike-${s}-${Date.now()}`;

await pp.getAccessToken();
sections.push(["OAuth", "POST /v1/oauth2/token: OK"]);

// (a)
try {
  const order = await pp.createOrder({ intent: "CAPTURE", purchase_units: [unit("1.00")], payment_source: { paypal: { experience_context: ctx } } }, rid("a"));
  await waitForApproval(pp, order, "a");
  const cap = await pp.captureOrder(order.id, rid("a-cap"));
  sections.push(["(a) order -> approve -> capture", `order ${cap.status}, capture ${firstCapture(cap)?.status}\n\n${code(cap)}`]);
} catch (e) {
  sections.push(["(a) order -> approve -> capture", `FAILED: ${describeError(e)}`]);
}

// (b)
let vaultId: string | undefined;
try {
  const order = await pp.createOrder(
    {
      intent: "CAPTURE",
      purchase_units: [unit("0.01")],
      payment_source: { paypal: { experience_context: ctx, attributes: { vault: { store_in_vault: "ON_SUCCESS", usage_type: "MERCHANT", customer_type: "CONSUMER" } } } },
    },
    rid("b"),
  );
  await waitForApproval(pp, order, "b (save PayPal)");
  const cap = await pp.captureOrder(order.id, rid("b-cap"));
  vaultId = cap.payment_source?.paypal?.attributes?.vault?.id;
  const vstatus = cap.payment_source?.paypal?.attributes?.vault?.status;
  sections.push(["(b1) store_in_vault capture (#27)", `order ${cap.status}, vault status ${vstatus ?? "missing"}, vault id ${vaultId ? "present" : "MISSING"}\n\n${code(cap)}`]);
} catch (e) {
  sections.push(["(b1) store_in_vault capture (#27)", `FAILED: ${describeError(e)}`]);
}

if (vaultId) {
  const variants: Array<[string, CreateOrderBody["payment_source"]]> = [
    ["vault_id only", { paypal: { vault_id: vaultId } }],
    ["vault_id + stored_credential MERCHANT/UNSCHEDULED/SUBSEQUENT", { paypal: { vault_id: vaultId, stored_credential: { payment_initiator: "MERCHANT", payment_type: "UNSCHEDULED", usage: "SUBSEQUENT" } } }],
  ];
  for (const [name, source] of variants) {
    try {
      let o = await pp.createOrder({ intent: "CAPTURE", purchase_units: [unit("1.23")], payment_source: source }, rid("b2"));
      const createdStatus = o.status;
      if (o.status !== "COMPLETED") o = await pp.captureOrder(o.id, rid("b2-cap"));
      sections.push([`(b2) buyer-absent re-order: ${name} (#28)`, `create returned ${createdStatus}; final ${o.status}; capture ${firstCapture(o)?.status}\n\n${code(o)}`]);
    } catch (e) {
      sections.push([`(b2) buyer-absent re-order: ${name} (#28)`, `FAILED: ${describeError(e)}`]);
    }
  }
}

const vaultOk = sections.some(([h, t]) => h.startsWith("(b2)") && !t.startsWith("FAILED") && t.includes("final COMPLETED"));
sections.push([
  "Decision (fill in)",
  `- Sandbox app Features > "Save payment methods" toggle present? (#27, check in the dashboard): __\n- Automatic mode: ${vaultOk ? "Vaulted (vault_id capture succeeded)" : "Treasury (vault_id capture did not succeed)"}\n- Set PAYPAL_PAYMENT_MODE accordingly.`,
]);
writeReport("d2-payment.md", "D2 payment spike (#33, #27, #28)", sections);
