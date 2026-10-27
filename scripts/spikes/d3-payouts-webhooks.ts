/**
 * Spike #34 (D3) — run: pnpm spike scripts/spikes/d3-payouts-webhooks.ts
 * Needs .env: PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_SANDBOX_BUYER_EMAIL (personal account),
 *   PUBLIC_BASE_URL (https ngrok URL forwarding to `pnpm dev:web`), optional PAYPAL_WEBHOOK_ID.
 * 1. Payout business -> personal ($1.00), read batch status
 * 2. Register (or reuse) the webhook for PUBLIC_BASE_URL/api/webhooks/paypal with SUBSCRIBED_EVENTS
 * 3. Fire simulate-event for each event type; the running web app verifies the signature and logs the result
 * Writes docs/spikes/d3-payouts-webhooks.md.
 */
import { SUBSCRIBED_EVENTS } from "@reins/core";
import { code, describeError, paypal, requireEnv, sleep, writeReport } from "./lib.ts";

const { PAYPAL_SANDBOX_BUYER_EMAIL, PUBLIC_BASE_URL } = requireEnv("PAYPAL_SANDBOX_BUYER_EMAIL", "PUBLIC_BASE_URL");
const pp = paypal();
const sections: Array<[string, string]> = [];

try {
  const batch = await pp.createPayout({
    sender_batch_header: { sender_batch_id: `spike-${Date.now()}`, email_subject: "Reins spike payout", recipient_type: "EMAIL" },
    items: [{ recipient_type: "EMAIL", amount: { value: "1.00", currency: "USD" }, receiver: PAYPAL_SANDBOX_BUYER_EMAIL, note: "Reins spike", sender_item_id: "spike-1" }],
  });
  await sleep(5000);
  const status = await pp.call("GET", `/v1/payments/payouts/${batch.batch_header.payout_batch_id}`);
  sections.push(["1. Payout business -> personal", code(status)]);
} catch (e) {
  sections.push(["1. Payout business -> personal", `FAILED: ${describeError(e)}`]);
}

const url = `${PUBLIC_BASE_URL.replace(/\/$/, "")}/api/webhooks/paypal`;
let webhookId = process.env.PAYPAL_WEBHOOK_ID;
try {
  const list = await pp.call<{ webhooks: Array<{ id: string; url: string }> }>("GET", "/v1/notifications/webhooks");
  webhookId ??= list.webhooks.find((w) => w.url === url)?.id;
  if (!webhookId) {
    const created = await pp.call<{ id: string }>("POST", "/v1/notifications/webhooks", { url, event_types: SUBSCRIBED_EVENTS.map((name) => ({ name })) });
    webhookId = created.id;
  }
  sections.push(["2. Webhook", `URL ${url}\nwebhook id: set PAYPAL_WEBHOOK_ID in .env (${webhookId ? "obtained" : "missing"})\nSubscribed: ${SUBSCRIBED_EVENTS.join(", ")}`]);
} catch (e) {
  sections.push(["2. Webhook", `FAILED: ${describeError(e)} (PayPal requires an https URL)`]);
}

if (webhookId) {
  const rows: string[] = [];
  for (const eventType of SUBSCRIBED_EVENTS) {
    try {
      const sim = await pp.call<{ id: string }>("POST", "/v1/notifications/simulate-event", { webhook_id: webhookId, event_type: eventType, resource_version: eventType.startsWith("CHECKOUT") ? "2.0" : undefined });
      rows.push(`| ${eventType} | sent (${sim.id}) |`);
    } catch (e) {
      rows.push(`| ${eventType} | FAILED ${describeError(e)} |`);
    }
  }
  sections.push([
    "3. simulate-event",
    `| event | result |\n|---|---|\n${rows.join("\n")}\n\nCheck the web app log for verify-webhook-signature results. Note: simulated events may fail signature verification by design (미확인); confirm with a real sandbox order.`,
  ]);
}
sections.push(["Decision (fill in)", "- Final event list: __\n- verify-signature on real deliveries: SUCCESS / FAILURE"]);
writeReport("d3-payouts-webhooks.md", "D3 Payouts + webhooks spike (#34)", sections);
