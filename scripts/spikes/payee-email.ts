/**
 * Spike #29 — run: pnpm spike scripts/spikes/payee-email.ts
 * Needs .env: PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_SANDBOX_PAYEE_EMAIL (a second sandbox BUSINESS account).
 * Creates an order whose purchase_units[0].payee.email_address is another business account, approves, captures,
 * and records whether funds went to that payee. Writes docs/spikes/payee-email.md.
 */
import { firstCapture } from "@reins/core";
import { code, describeError, paypal, requireEnv, waitForApproval, writeReport } from "./lib.ts";

const { PAYPAL_SANDBOX_PAYEE_EMAIL } = requireEnv("PAYPAL_SANDBOX_PAYEE_EMAIL");
const pp = paypal();
const base = (process.env.PUBLIC_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const sections: Array<[string, string]> = [];
try {
  const order = await pp.createOrder(
    {
      intent: "CAPTURE",
      purchase_units: [{ amount: { currency_code: "USD", value: "2.00" }, payee: { email_address: PAYPAL_SANDBOX_PAYEE_EMAIL } }],
      payment_source: { paypal: { experience_context: { return_url: `${base}/pay/return`, cancel_url: `${base}/pay/cancel`, user_action: "PAY_NOW", shipping_preference: "NO_SHIPPING" } } },
    },
    `spike-payee-${Date.now()}`,
  );
  await waitForApproval(pp, order, "payee");
  const cap = await pp.captureOrder(order.id, `spike-payee-cap-${Date.now()}`);
  sections.push(["Result", `order ${cap.status}, capture ${firstCapture(cap)?.status}. Check the payee business account balance in the sandbox dashboard.\n\n${code(cap)}`]);
  sections.push(["Decision (fill in)", "- Direct payee via Orders v2 works for X1: __ (if not, use Payouts)"]);
} catch (e) {
  sections.push(["Result", `FAILED: ${describeError(e)}\n\nDecision: use Payouts for X1.`]);
}
writeReport("payee-email.md", "Spike #29: Orders v2 payee.email_address", sections);
