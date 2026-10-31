/**
 * M11 nightly reconciliation against a local DB file (`pnpm reconcile`). On Render the cron job calls
 * POST /api/cron/reconcile on reins-web instead, because cron jobs cannot mount the web service disk (render.yaml).
 * Pulls PayPal Transaction Search for the last N days (default 2, max 31) and marks payments matched/mismatch.
 * Prints counts only (no ids, emails or amounts per row).
 *   pnpm reconcile            # uses DATABASE_URL and PayPal keys from .env
 *   pnpm reconcile -- --days 7
 */
import { resolve } from "node:path";
import { reconcilePayments } from "@reins/core";
import { createContextFromEnv } from "../apps/web/src/server/context.ts";
import { ROOT } from "./spikes/lib.ts";

async function main() {
  const i = process.argv.indexOf("--days");
  const days = Math.min(Math.max(Number(i > 0 ? process.argv[i + 1] : 2) || 2, 1), 31);
  const ctx = await createContextFromEnv({
    ...process.env,
    TELEGRAM_MODE: "off", // never start the bot from the cron job
    REINS_MIGRATIONS_DIR: process.env.REINS_MIGRATIONS_DIR ?? resolve(ROOT, "packages/db/drizzle"),
    DATABASE_URL: process.env.DATABASE_URL ?? `file:${resolve(ROOT, "apps/web/.local/reins.db")}`,
  });
  const r = await reconcilePayments(ctx, { start: ctx.now() - days * 86_400_000 });
  console.log(`reconcile: window ${r.window.start} .. ${r.window.end}, ${r.transactions} PayPal transaction(s) in ${r.pages} page(s); payments checked ${r.checked}: matched ${r.matched}, mismatch ${r.mismatch}, pending ${r.pending}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`reconcile failed: ${err instanceof Error ? err.message : "error"}`);
  process.exit(1);
});
