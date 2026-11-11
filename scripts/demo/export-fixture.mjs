#!/usr/bin/env node
/**
 * Turns the scratch database of scripts/demo/real-run.mjs into the committed fixture scripts/seed.ts replays.
 *
 *   node --env-file=.env scripts/demo/export-fixture.mjs --db <scratch>/reins-real.db --out scripts/demo/fixtures/real-sandbox-run.json
 *
 * Copies requests, decisions and payments as recorded (real PayPal sandbox ids, Claude's text, model, tokens, latency,
 * real timestamps). Leaves out agent ids and keys, approve URLs, the workspace row and the run's placeholder row.
 * Refuses to write when the output contains an e-mail address or, when run with --env-file, any secret or the sandbox
 * payee address from the environment (it prints only which check failed, never a value).
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith("--") ? [...a, [x.slice(2), all[i + 1]]] : a), []));
if (!args.db || !args.out) throw new Error("--db <scratch db> and --out <fixture json> are required");
const db = path.resolve(args.db);
const q = (sql) => JSON.parse(execFileSync("/usr/bin/sqlite3", ["-json", db, sql], { encoding: "utf8" }) || "[]");
const json = (v) => (v == null ? null : typeof v === "string" ? JSON.parse(v) : v);

const reqs = q(`select r.*, a.name as agent_name, m.version as mandate_version from requests r
  join agents a on a.id = r.agent_id left join mandates m on m.id = r.mandate_id
  where r.client_request_id != 'run-seq-placeholder' order by r.seq`);
const requests = reqs.map((r) => {
  const decisions = q(`select * from decisions where request_id = '${r.id}' order by created_at, rowid`).map((d) => ({
    stage: d.stage,
    decision: d.decision,
    risk: d.risk,
    reason_en: d.reason_en,
    reason_ko: d.reason_ko,
    details: json(d.details),
    actor: d.actor,
    created_at: d.created_at,
  }));
  const [p] = q(`select * from payments where request_id = '${r.id}'`);
  return {
    display_id: `R-${String(r.seq).padStart(4, "0")}`,
    agent: r.agent_name,
    mandate_version: r.mandate_version,
    client_request_id: r.client_request_id,
    merchant: r.merchant,
    amount_cents: r.amount_cents,
    currency: r.currency,
    items: r.items,
    reason: r.reason,
    category: r.category,
    status: r.status,
    final_decision: r.final_decision,
    risk: r.risk,
    reason_en: r.reason_en,
    reason_ko: r.reason_ko,
    anomalies: json(r.anomalies) ?? [],
    created_at: r.created_at,
    updated_at: r.updated_at,
    decisions,
    payment: p
      ? {
          strategy: p.strategy,
          status: p.status,
          paypal_order_id: p.paypal_order_id,
          capture_id: p.capture_id,
          payout_batch_id: p.payout_batch_id,
          amount_cents: p.amount_cents,
          currency: p.currency,
          error: p.error,
          reconciled: p.reconciled,
          reconciled_at: p.reconciled_at,
          reconcile_note: p.reconcile_note,
          created_at: p.created_at,
          updated_at: p.updated_at,
        }
      : null,
  };
});
if (!requests.length) throw new Error("no requests in the run database");

const llm = requests.flatMap((r) => r.decisions.filter((d) => d.stage === "llm"));
const claude = llm.filter((d) => String(d.actor ?? "").startsWith("claude"));
const end = Math.max(...requests.flatMap((r) => [r.updated_at, r.payment?.updated_at ?? 0, r.payment?.reconciled_at ?? 0, ...r.decisions.map((d) => d.created_at)]));
const payouts = requests.filter((r) => r.payment);
const fixture = {
  about:
    "Recorded by scripts/demo/real-run.mjs: every request below went through the real Reins pipeline (MCP request_purchase, hard rules, a real Claude audit) on the real PayPal sandbox in treasury mode (Payouts API, paid to a sandbox personal account whose address is not stored here). Ids, amounts, decisions, auditor text, model, tokens, latency and times are as recorded. Nobody approved anything: requests sent to a human are still pending. scripts/seed.ts replays this file and shifts every time by one offset so the run ends just before the demo boots.",
  recorded_at: new Date(end).toISOString(),
  run: {
    paypal_env: "sandbox",
    payment_mode: "treasury",
    payee: "PayPal sandbox personal account (address redacted)",
    auditor_models: [...new Set(claude.map((d) => d.actor))],
    claude_audits: claude.length,
    non_claude_audits: llm.length - claude.length,
    payouts: { total: payouts.length, by_status: Object.fromEntries([...new Set(payouts.map((r) => r.payment.status))].map((s) => [s, payouts.filter((r) => r.payment.status === s).length])) },
    transaction_search: { matched: payouts.filter((r) => r.payment.reconciled === "matched").length, mismatch: payouts.filter((r) => r.payment.reconciled === "mismatch").length, unchecked: payouts.filter((r) => r.payment.reconciled === "unchecked").length },
  },
  requests,
};

const text = `${JSON.stringify(fixture, null, 2)}\n`;
const problems = [];
if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(text)) problems.push("an e-mail address");
for (const k of ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "ANTHROPIC_API_KEY", "PAYPAL_SANDBOX_BUYER_EMAIL", "PAYPAL_SANDBOX_MERCHANT_EMAIL", "TREASURY_PAYEE_EMAIL", "TELEGRAM_BOT_TOKEN", "PAYPAL_WEBHOOK_ID"]) {
  const v = process.env[k];
  if (v && v.length >= 6 && text.includes(v)) problems.push(k);
}
if (/rk_(live|demo)_|vault|A21[A-Za-z0-9_-]{10,}|access_token|Bearer /i.test(text)) problems.push("a key, token or vault reference");
if (problems.length) throw new Error(`refusing to write the fixture: it contains ${problems.join(", ")}`);
writeFileSync(path.resolve(args.out), text);
console.log(`fixture: ${requests.length} requests, ${claude.length} Claude audits (${fixture.run.auditor_models.join(", ")}), ${payouts.length} payouts ${JSON.stringify(fixture.run.payouts.by_status)}, Transaction Search ${JSON.stringify(fixture.run.transaction_search)} -> ${path.relative(process.cwd(), path.resolve(args.out))}`);
