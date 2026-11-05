/**
 * `pnpm judge`: one command for a judge with no deploy and no MCP client.
 *   - makes a throwaway database in the OS temp dir (your real .local/reins.db is never touched)
 *   - seeds the demo data (3 agents, 24 requests) and connects the in-memory fake PayPal (payments are labelled "simulated")
 *   - builds (first run only) and starts the web app, then opens http://localhost:<port>/try
 * Reads no .env file and calls no paid API: the offline demo auditor decides, PayPal is simulated, Telegram is off.
 *   pnpm judge                  # port 3100
 *   pnpm judge -- --port 3200 --no-open
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, migrateDb, updateWorkspace } from "@reins/db";
import { seedDemo } from "./seed.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WEB = join(ROOT, "apps/web");
const DIST = ".next-judge";

const args = process.argv.slice(2).filter((a) => a !== "--");
const portIdx = args.indexOf("--port");
const port = Number(portIdx >= 0 ? args[portIdx + 1] : process.env.PORT ?? 3100);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("--port needs a number between 1024 and 65535");
const base = `http://localhost:${port}`;

const dir = mkdtempSync(join(tmpdir(), "reins-judge-"));
const dbFile = join(dir, "judge.db");
const cleanup = () => rmSync(dir, { recursive: true, force: true });

// Fixed environment: nothing from the shell or any .env file can switch on real PayPal, Claude or Telegram.
const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  NODE_ENV: "production",
  DATABASE_URL: `file:${dbFile}`,
  REINS_NEXT_DIST_DIR: DIST,
  REINS_TRY: "1",
  PAYPAL_ENV: "fake",
  PAYPAL_CLIENT_ID: "",
  PAYPAL_CLIENT_SECRET: "",
  PAYPAL_WEBHOOK_ID: "",
  ANTHROPIC_API_KEY: "",
  TELEGRAM_BOT_TOKEN: "",
  TELEGRAM_MODE: "off",
  REINS_QUIET_HOURS: "off",
  REINS_ADMIN_TOKEN: "",
  REINS_APPROVAL_TTL_MINUTES: "240",
  PUBLIC_BASE_URL: base,
  REINS_API_URL: base,
  NEXT_TELEMETRY_DISABLED: "1",
};
const next = ["node_modules/next/dist/bin/next"];

async function main() {
  console.log("judge: seeding a throwaway database (your .local/reins.db is not touched)");
  const db = createDb(`file:${dbFile}`);
  await migrateDb(db, join(ROOT, "packages/db/drizzle"));
  const r = await seedDemo(db, { connectDemoMerchant: true });
  // automatic payment path: a fake vault id makes AUTO_APPROVE pay immediately through the simulated PayPal
  await updateWorkspace(db, { paypalEnv: "fake", paymentMode: "vaulted", vaultId: "VAULT-SIM-JUDGE" });
  console.log(`judge: ${r.requests} requests across ${r.agents} agents seeded`);

  if (!existsSync(join(WEB, DIST, "BUILD_ID"))) {
    console.log("judge: building the web app (first run, about a minute)");
    execFileSync(process.execPath, [...next, "build"], { cwd: WEB, env: { ...env, NODE_ENV: "production" }, stdio: "inherit" });
  }

  const server = spawn(process.execPath, [...next, "start", "-p", String(port)], { cwd: WEB, env, stdio: "inherit" });
  const stop = () => {
    server.kill("SIGTERM");
    cleanup();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  server.on("exit", (code) => {
    cleanup();
    process.exit(code ?? 0);
  });

  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {
      /* booting */
    }
    await new Promise((res) => setTimeout(res, 500));
  }
  const url = `${base}/try`;
  console.log(`\njudge: ready -> ${url}`);
  console.log("judge: send the $450 order, then tick 'Simulate a fooled auditor' and send it again. Ctrl+C stops the server and deletes the database.");
  if (!args.includes("--no-open")) {
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    try {
      spawn(opener, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).on("error", () => undefined).unref();
    } catch {
      /* opening a browser is a convenience only */
    }
  }
}

main().catch((err) => {
  console.error(`judge failed: ${err instanceof Error ? err.message : "error"}`);
  cleanup();
  process.exit(1);
});
