import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HttpPayPalClient, PayPalApiError, type Order } from "@reins/core";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Exits with a clear message when a required .env key is missing (values are never printed). */
export function requireEnv<K extends string>(...names: K[]): Record<K, string> {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length) {
    console.error(`Missing in .env: ${missing.join(", ")}. See .env.example.`);
    process.exit(2);
  }
  return Object.fromEntries(names.map((n) => [n, process.env[n]!])) as Record<K, string>;
}

export function paypal(): HttpPayPalClient {
  const env = requireEnv("PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET");
  return new HttpPayPalClient({ clientId: env.PAYPAL_CLIENT_ID, clientSecret: env.PAYPAL_CLIENT_SECRET, env: "sandbox" });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Prints the approval link, then polls GET order until APPROVED (buyer logs in with the sandbox personal account). */
export async function waitForApproval(pp: HttpPayPalClient, order: Order, label: string, timeoutMs = 10 * 60_000): Promise<Order> {
  const link = order.links?.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href;
  console.log(`\n[${label}] Open in a browser and approve with the sandbox PERSONAL account:\n  ${link}\n`);
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const o = await pp.getOrder(order.id);
    if (o.status === "APPROVED" || o.status === "COMPLETED") return o;
    await sleep(4000);
  }
  throw new Error(`${label}: not approved within ${timeoutMs / 60000} min`);
}

export function describeError(err: unknown): string {
  if (err instanceof PayPalApiError) return `HTTP ${err.status} ${err.issue ?? ""} (debug_id ${err.debugId ?? "-"}) ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

/** Strips emails, tokens, vault and customer ids before anything is written to docs/ (the repo is public). */
export function redact(value: unknown, path: string[] = []): unknown {
  if (Array.isArray(value)) return value.map((v) => redact(v, path));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, [...path, k])]));
  }
  if (typeof value !== "string") return value;
  const key = path.at(-1) ?? "";
  if (/email/i.test(key) || value.includes("@")) return "<redacted-email>";
  if (/token|secret|access/i.test(key)) return "<redacted>";
  if (key === "vault_id" || (key === "id" && path.some((p) => p === "vault" || p === "customer"))) return "<redacted-id>";
  if (key === "payer_id" || key === "account_id") return "<redacted-id>";
  return value;
}

export function writeReport(file: string, title: string, sections: Array<[string, string]>): void {
  const path = resolve(ROOT, "docs/spikes", file);
  mkdirSync(dirname(path), { recursive: true });
  const body = [`# ${title}`, "", `Run: ${new Date().toISOString()} (sandbox)`, "", ...sections.flatMap(([h, t]) => [`## ${h}`, "", t, ""])].join("\n");
  writeFileSync(path, body);
  console.log(`\nWrote ${path}`);
}

export const code = (v: unknown) => "```json\n" + JSON.stringify(redact(v), null, 2) + "\n```";
