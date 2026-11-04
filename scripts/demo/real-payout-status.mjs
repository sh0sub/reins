#!/usr/bin/env node
/**
 * Reads the payout batch ids from <work>/real-run.json (written by real-run.mjs), asks the PayPal sandbox for each
 * batch's status (GET /v1/payments/payouts/{id}) and stores the public fields back as `paypal_status`.
 *   node --env-file=.env scripts/demo/real-payout-status.mjs --work <scratch dir>
 * The OAuth token and client secret are never printed or stored.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const i = process.argv.indexOf("--work");
if (i < 0) throw new Error("--work <scratch dir> is required");
const file = path.join(path.resolve(process.argv[i + 1]), "real-run.json");
const { PAYPAL_CLIENT_ID: id, PAYPAL_CLIENT_SECRET: secret } = process.env;
if (!id || !secret) throw new Error("PAYPAL_CLIENT_ID/PAYPAL_CLIENT_SECRET not set (run with node --env-file=.env)");
const api = "https://api-m.sandbox.paypal.com";
const tok = await (await fetch(`${api}/v1/oauth2/token`, { method: "POST", headers: { authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials" })).json();
if (!tok.access_token) throw new Error("PayPal sandbox OAuth failed");
const rows = JSON.parse(readFileSync(file, "utf8"));
for (const r of rows) {
  const batch = r.payment?.payout_batch_id;
  if (!batch) continue;
  const res = await fetch(`${api}/v1/payments/payouts/${batch}`, { headers: { authorization: `Bearer ${tok.access_token}` } });
  const b = await res.json();
  r.paypal_status = { http: res.status, batch_status: b.batch_header?.batch_status, amount: b.batch_header?.amount, time_completed: b.batch_header?.time_completed ?? null, item_status: b.items?.[0]?.transaction_status ?? null };
  console.log(r.display_id, batch, JSON.stringify(r.paypal_status));
}
writeFileSync(file, JSON.stringify(rows, null, 2));
