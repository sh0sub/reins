/**
 * `pnpm attacks`: a simulated benchmark. Nine scripted attacks are sent two ways on a throwaway in-memory database:
 * through the real Reins rule engine (with an auditor that is fooled into approving everything), and through a model of an
 * ungated shared card / API token that pays whatever it is told. Simulated PayPal, no network, no money, no LLM, no .env.
 */
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { dollars, runAttackSuite } from "@reins/core";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const r = await runAttackSuite({ migrationsFolder: join(ROOT, "packages/db/drizzle") });
const pad = (s: string, n: number) => s.padEnd(n);
console.log(`Reins attack suite (${r.label}; auditor: ${r.auditor})\n`);
console.log(`${pad("Attack", 38)}${pad("Asked", 10)}${pad("Ungated paid", 14)}${pad("With Reins paid", 36)}Stopped by`);
for (const a of r.attacks) {
  const held = a.gated_held_cents ? ` (+${dollars(a.gated_held_cents)} held for a person)` : "";
  console.log(`${pad(a.title, 38)}${pad(dollars(a.asked_cents), 10)}${pad(dollars(a.ungated_paid_cents), 14)}${pad(dollars(a.gated_paid_cents) + held, 36)}${a.stopped_by.join(", ") || "-"}`);
}
console.log(`\nTotal: ungated paid ${dollars(r.ungated_paid_cents)}, with Reins paid ${dollars(r.gated_paid_cents)}; ${dollars(r.prevented_cents)} prevented across ${r.stopped_attacks} of ${r.attacks.length} attacks.`);
console.log("Read it as: the rules do what they say against these scripted attacks. It is not a claim about every possible attack.");
