/**
 * Demo seed: 3 agents and their mandates, plus the ledger of a REAL recorded PayPal-sandbox run, in one command.
 *   pnpm seed                       # default dev DB (apps/web/.local/reins.db, the one `pnpm dev:web` uses)
 *   pnpm seed -- --db ./some.db     # another file (or a libsql URL)
 *   pnpm seed -- --force            # wipe seed data even if the DB also holds non-seed data (only seed rows are removed)
 *   pnpm seed -- --if-empty         # first-boot mode (Render start command): seed only when the DB has no agents, else no-op
 *   pnpm seed -- --config-only      # agents + mandates only, no history (scripts/demo/real-run.mjs records on top of it)
 *
 * The history is replayed from scripts/demo/fixtures/real-sandbox-run.json, written by scripts/demo/real-run.mjs: every
 * request went through the real pipeline (hard rules, a real Claude audit, real PayPal sandbox Payouts in treasury mode).
 * Ids, amounts, decisions, auditor text, model, tokens and latency are copied as recorded. Only the times move: the
 * whole run is shifted by one offset so it ends just before `now` (each row keeps `recorded_at`, the UI says so).
 * Nothing in it is invented: no human approval clicks, no Q&A thread. The run's pending approvals stay pending.
 * Calls neither PayPal nor Claude. Seed rows are tagged by agent key prefix `rk_demo_`; re-running replaces them. The raw
 * agent keys are discarded (never stored or printed). .env files are never read.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  countRequestsOutside,
  countWebhookEvents,
  createDb,
  createMandateVersion,
  insertAgent,
  insertDecision,
  insertPayment,
  insertRequest,
  updateWorkspace,
  listAgents,
  migrateDb,
  purgeAgents,
  RECORDED_REQUEST_PREFIX,
  setAgentPaused,
  setTimestamps,
  updatePayment,
  updateRequest,
  type Agent,
  type Decision,
  type Mandate,
  type Payment,
  type PurchaseRequest,
  type ReinsDb,
} from "@reins/db";
import { agentBudgets, generateApiKey, monthStartUtc, toCents, usablePaymentMode, type PaymentMode } from "@reins/core";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_DB_URL = `file:${resolve(ROOT, "apps/web/.local/reins.db")}`;
export const FIXTURE_PATH = resolve(ROOT, "scripts/demo/fixtures/real-sandbox-run.json");
/** Same sandbox address the app shows for the offline fake PayPal (apps/web router). */
export const DEMO_MERCHANT_EMAIL = "sb-merchant-demo@business.example.com";
/** Seed agents are the rows whose key prefix starts with this; everything else is considered real data. */
export const SEED_KEY_PREFIX = "rk_demo_";
const MIN = 60_000;
/** Research Scout's v2 adds this merchant to the v1 allow list. */
const SCOUT_V2_ALLOWED = ["huggingface.co"];
/** The replayed run ends this long before `now`. */
const END_BEFORE_NOW_MS = 3 * MIN;

type AgentKey = "devops" | "scout" | "office";

export const AGENTS: Record<
  AgentKey,
  { name: string; mandate: { monthly: string; auto: string; cap: string; allowed: string[]; categories: string[]; purpose: string } }
> = {
  devops: {
    name: "Claude Code – DevOps",
    mandate: { monthly: "150.00", auto: "30.00", cap: "100.00", allowed: ["namecheap.com", "vercel.com", "render.com", "anthropic.com"], categories: ["infrastructure"], purpose: "Keep dev infrastructure running: domains, hosting and API credits" },
  },
  scout: {
    name: "Research Scout",
    mandate: { monthly: "100.00", auto: "25.00", cap: "100.00", allowed: ["statista.com", "gartner.com", "grandviewresearch.com"], categories: ["research"], purpose: "Buy market research reports" },
  },
  office: {
    name: "Desk Restock Bot",
    mandate: { monthly: "160.00", auto: "30.00", cap: "100.00", allowed: ["amazon.com", "staples.com", "hermanmiller.com"], categories: ["office"], purpose: "Restock desk and office supplies" },
  },
};

// ---------------- recorded run fixture ----------------

export interface RecordedDecision {
  stage: Decision["stage"];
  decision: Decision["decision"];
  risk: number | null;
  reason_en: string | null;
  reason_ko: string | null;
  details: Record<string, unknown> | null;
  actor: string | null;
  created_at: number;
}
export interface RecordedPayment {
  strategy: Payment["strategy"];
  status: Payment["status"];
  paypal_order_id: string | null;
  capture_id: string | null;
  payout_batch_id: string | null;
  amount_cents: number;
  currency: string;
  error: string | null;
  reconciled: Payment["reconciled"];
  reconciled_at: number | null;
  reconcile_note: string | null;
  created_at: number;
  updated_at: number;
}
export interface RecordedRequest {
  display_id: string;
  agent: string;
  mandate_version: number;
  client_request_id: string;
  merchant: string;
  amount_cents: number;
  currency: string;
  items: string;
  reason: string;
  category: string | null;
  status: PurchaseRequest["status"];
  final_decision: PurchaseRequest["finalDecision"];
  risk: number | null;
  reason_en: string | null;
  reason_ko: string | null;
  anomalies: PurchaseRequest["anomalies"];
  created_at: number;
  updated_at: number;
  decisions: RecordedDecision[];
  payment: RecordedPayment | null;
}
export interface RecordedRun {
  about: string;
  recorded_at: string;
  run: Record<string, unknown>;
  requests: RecordedRequest[];
}

export function loadFixture(path = FIXTURE_PATH): RecordedRun {
  const run = JSON.parse(readFileSync(path, "utf8")) as RecordedRun;
  if (!Array.isArray(run.requests) || run.requests.length === 0) throw new Error(`${path}: no recorded requests`);
  return run;
}

/** Latest timestamp anywhere in the run (request, decision or payment): the shift puts it END_BEFORE_NOW_MS before now. */
function runEnd(run: RecordedRun): number {
  let end = 0;
  for (const r of run.requests) {
    end = Math.max(end, r.created_at, r.updated_at, ...r.decisions.map((d) => d.created_at), r.payment?.updated_at ?? 0, r.payment?.reconciled_at ?? 0);
  }
  return end;
}

export interface SeedOptions {
  /** Wipe seed rows even when the DB also contains non-seed data. */
  force?: boolean;
  now?: number;
  /** Mark the workspace as connected to the demo merchant (public demo: every screen shows the PayPal badge). */
  connectDemoMerchant?: boolean;
  /** Environment that decides which PayPal the demo merchant is on (default process.env); see seedPayPal. */
  env?: Record<string, string | undefined>;
  /** Agents and mandates only (v1, plus Research Scout's v2), no history, nobody paused: the base a recorded run starts from. */
  configOnly?: boolean;
  /** Recorded run to replay (default: the committed fixture). */
  fixture?: RecordedRun;
}

/**
 * Which PayPal the seeded workspace is connected to: the same test as the server's paypalFromEnv, so the labels match the
 * client that really runs. With PayPal credentials (and not PAYPAL_ENV=fake) the server talks to the real sandbox, so the
 * workspace says "sandbox"; otherwise the in-memory fake ("Simulated PayPal").
 */
export function seedPayPal(env: Record<string, string | undefined> = process.env): { paypalEnv: "sandbox" | "fake"; merchantEmail: string } {
  const real = env.PAYPAL_ENV !== "fake" && Boolean(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET);
  return real ? { paypalEnv: "sandbox", merchantEmail: env.PAYPAL_SANDBOX_MERCHANT_EMAIL || DEMO_MERCHANT_EMAIL } : { paypalEnv: "fake", merchantEmail: DEMO_MERCHANT_EMAIL };
}

/**
 * Payment mode of the connected demo workspace: PAYPAL_PAYMENT_MODE=treasury pays from the sandbox business balance with
 * Payouts (no buyer login), but only with a payee (TREASURY_PAYEE_EMAIL); otherwise supervised checkout. Never vaulted
 * (the seed has no vault id).
 */
export function seedPaymentMode(env: Record<string, string | undefined> = process.env): PaymentMode {
  const mode = usablePaymentMode(env.PAYPAL_PAYMENT_MODE === "treasury" ? "treasury" : "supervised", env.TREASURY_PAYEE_EMAIL);
  if (env.PAYPAL_PAYMENT_MODE === "treasury" && mode !== "treasury") console.warn("seed: PAYPAL_PAYMENT_MODE=treasury but TREASURY_PAYEE_EMAIL is not set; the demo uses supervised checkout");
  return mode;
}

export interface SeedResult {
  agents: number;
  mandates: number;
  requests: number;
  replaced: number;
  thisMonthSpentCents: number;
  thisMonthLimitCents: number;
}

export class SeedRefusal extends Error {}

async function seedAgentIds(db: ReinsDb): Promise<string[]> {
  return (await listAgents(db)).filter((a) => a.keyPrefix.startsWith(SEED_KEY_PREFIX)).map((a) => a.id);
}

/** Dashboard numbers exactly as the app computes them (core agentBudgets: per-agent month spend vs. active mandate limit). */
export async function dashboardTotals(db: ReinsDb, now = Date.now()) {
  const budgets = await agentBudgets(db, now);
  return { spentCents: budgets.reduce((s, a) => s + a.spent_cents, 0), limitCents: budgets.reduce((s, a) => s + (a.limit_cents ?? 0), 0), agents: budgets.length };
}

export async function seedDemo(db: ReinsDb, opts: SeedOptions = {}): Promise<SeedResult> {
  const now = opts.now ?? Date.now();
  const existingSeed = await seedAgentIds(db);
  const allAgents = await listAgents(db);
  const foreignAgents = allAgents.length - existingSeed.length;
  const foreignRequests = await countRequestsOutside(db, existingSeed);
  const webhooks = await countWebhookEvents(db);
  if ((foreignAgents > 0 || foreignRequests > 0 || webhooks > 0) && !opts.force) {
    throw new SeedRefusal(
      `Refusing to seed: the database has non-seed data (${foreignAgents} agent(s), ${foreignRequests} request(s), ${webhooks} webhook event(s)). ` +
        "Use --db <path> for a scratch file, or --force to replace only the seed rows and keep the rest.",
    );
  }
  await purgeAgents(db, existingSeed);

  const run = opts.configOnly ? null : (opts.fixture ?? loadFixture());
  const shift = run ? now - END_BEFORE_NOW_MS - runEnd(run) : 0;
  const firstAt = run ? Math.min(...run.requests.map((r) => r.created_at)) + shift : now;
  // agents predate the history they own (and stay inside this month when the run allows it)
  const agentsAt = Math.max(Math.min(firstAt - 60 * MIN, now - 60 * MIN), Math.min(monthStartUtc(now), firstAt - MIN));

  // Agents + mandate v1 each, Research Scout v2 (+huggingface.co) before the run. The key is generated by the real key
  // code and dropped on purpose.
  const agents = new Map<AgentKey, Agent>();
  const mandates = new Map<AgentKey, Mandate[]>();
  const mandateInput = (key: AgentKey, extra: { allowed?: string[]; blocked?: string[] } = {}) => {
    const m = AGENTS[key].mandate;
    return {
      monthlyLimitCents: toCents(m.monthly),
      autoApproveLimitCents: toCents(m.auto),
      perTxCapCents: toCents(m.cap),
      allowedMerchants: [...m.allowed, ...(extra.allowed ?? [])],
      blockedMerchants: extra.blocked ?? [],
      categories: m.categories,
      purpose: m.purpose,
      validFrom: null,
      validUntil: null,
    };
  };
  for (const [i, key] of (Object.keys(AGENTS) as AgentKey[]).entries()) {
    const def = AGENTS[key];
    const k = generateApiKey(SEED_KEY_PREFIX);
    const agent = await insertAgent(db, { name: def.name, keyHash: k.hash, keyPrefix: k.displayPrefix });
    const list = [await createMandateVersion(db, agent.id, mandateInput(key))];
    if (key === "scout") list.push(await createMandateVersion(db, agent.id, mandateInput(key, { allowed: SCOUT_V2_ALLOWED })));
    mandates.set(key, list);
    await setTimestamps(db, { agent: agent.id }, agentsAt + (i + 1) * 1000);
    agents.set(key, agent);
  }

  let n = 0;
  if (run) {
    const byName = new Map([...agents.entries()].map(([key, a]) => [a.name, key] as const));
    // keep the recorded display ids (R-0129 … R-0143) on an empty table; otherwise the next free numbers
    const fixedSeq = (await countRequestsOutside(db, [])) === 0;
    for (const rec of [...run.requests].sort((a, b) => a.created_at - b.created_at)) {
      const key = byName.get(rec.agent);
      if (!key) throw new Error(`fixture request ${rec.display_id}: unknown agent ${rec.agent}`);
      const mandate = mandates.get(key)!.find((m) => m.version === rec.mandate_version);
      if (!mandate) throw new Error(`fixture request ${rec.display_id}: ${rec.agent} has no mandate v${rec.mandate_version}`);
      await replayRecorded(db, agents.get(key)!, mandate, rec, shift, fixedSeq ? Number(rec.display_id.slice(2)) : undefined);
      n++;
    }
    // Configuration after the run (not events): Research Scout v3 blocks fiverr.com for new requests, Desk Restock Bot is
    // paused. Neither is presented as something that happened during the recorded run.
    await createMandateVersion(db, agents.get("scout")!.id, mandateInput("scout", { allowed: SCOUT_V2_ALLOWED, blocked: ["fiverr.com"] }));
    await setAgentPaused(db, agents.get("office")!.id, now - END_BEFORE_NOW_MS + 1000);
  }

  if (opts.connectDemoMerchant) {
    await updateWorkspace(db, { ...seedPayPal(opts.env), paymentMode: seedPaymentMode(opts.env ?? process.env), connectedAt: now });
  }

  const totals = await dashboardTotals(db, now);
  return {
    agents: agents.size,
    mandates: mandates.size,
    requests: n,
    replaced: existingSeed.length,
    thisMonthSpentCents: totals.spentCents,
    thisMonthLimitCents: totals.limitCents,
  };
}

/** One recorded request, as recorded, with every time moved by `shift`. Its first decision carries `recorded_at`. */
async function replayRecorded(db: ReinsDb, agent: Agent, mandate: Mandate, rec: RecordedRequest, shift: number, seq?: number) {
  const at = (t: number) => t + shift;
  const { request } = await insertRequest(db, {
    agentId: agent.id,
    mandateId: mandate.id,
    clientRequestId: `${RECORDED_REQUEST_PREFIX}${rec.client_request_id}`,
    merchant: rec.merchant,
    amountCents: rec.amount_cents,
    currency: rec.currency,
    items: rec.items,
    reason: rec.reason,
    category: rec.category,
    createdAt: at(rec.created_at),
    ...(seq ? { seq } : {}),
  });
  for (const [i, d] of rec.decisions.entries()) {
    const details = i === 0 ? { ...(d.details ?? {}), recorded_at: new Date(d.created_at).toISOString(), time_shift_ms: shift } : d.details;
    await insertDecision(db, { requestId: request.id, stage: d.stage, decision: d.decision, risk: d.risk, reasonEn: d.reason_en, reasonKo: d.reason_ko, details, actor: d.actor, createdAt: at(d.created_at) });
  }
  await updateRequest(db, request.id, { status: rec.status, finalDecision: rec.final_decision, risk: rec.risk, reasonEn: rec.reason_en, reasonKo: rec.reason_ko, anomalies: rec.anomalies ?? [] });
  await setTimestamps(db, { request: request.id }, at(rec.updated_at));
  const p = rec.payment;
  if (!p) return;
  const payment = await insertPayment(db, {
    requestId: request.id,
    strategy: p.strategy,
    status: p.status,
    paypalOrderId: p.paypal_order_id,
    captureId: p.capture_id,
    payoutBatchId: p.payout_batch_id,
    approveUrl: null,
    amountCents: p.amount_cents,
    currency: p.currency,
    error: p.error,
  });
  await updatePayment(db, payment.id, { reconciled: p.reconciled, reconciledAt: p.reconciled_at == null ? null : at(p.reconciled_at), reconcileNote: p.reconcile_note });
  await setTimestamps(db, { payment: payment.id, paymentCreatedAt: at(p.created_at) }, at(p.updated_at));
}

/**
 * First-boot seed (#38 Render deploy): seeds only a database without any agent, so restarts and redeploys never touch
 * live data or re-seed. Never forces. Returns null when it skipped.
 */
export async function seedIfEmpty(db: ReinsDb, opts: Omit<SeedOptions, "force"> = {}): Promise<SeedResult | null> {
  if ((await listAgents(db)).length > 0) return null;
  return seedDemo(db, { now: opts.now, connectDemoMerchant: opts.connectDemoMerchant, env: opts.env, fixture: opts.fixture, configOnly: opts.configOnly });
}

// ---------------- CLI ----------------

function parseArgs(argv: string[]) {
  const args = argv.filter((a) => a !== "--");
  const force = args.includes("--force");
  const ifEmpty = args.includes("--if-empty");
  const configOnly = args.includes("--config-only");
  if (force && ifEmpty) throw new Error("--if-empty never forces; drop --force");
  const i = args.indexOf("--db");
  const db = i >= 0 ? args[i + 1] : undefined;
  if (i >= 0 && !db) throw new Error("--db needs a path");
  return { force, ifEmpty, db, configOnly };
}

function toUrl(db: string | undefined): string {
  if (!db) return DEFAULT_DB_URL;
  if (/^(file|libsql|https?|wss?):/.test(db) || db === ":memory:") return db;
  return `file:${resolve(process.cwd(), db)}`;
}

async function main() {
  const { force, ifEmpty, db: dbArg, configOnly } = parseArgs(process.argv.slice(2));
  const url = toUrl(dbArg);
  // The demo merchant is connected on every seed so a judge sees "PayPal Sandbox Connected" from the first screen; REINS_FIRST_RUN=1 keeps the unconnected S1 story.
  const connectDemoMerchant = process.env.REINS_FIRST_RUN !== "1";
  const db = createDb(url);
  await migrateDb(db, process.env.REINS_MIGRATIONS_DIR ?? resolve(ROOT, "packages/db/drizzle"));
  const r = ifEmpty ? await seedIfEmpty(db, { connectDemoMerchant, configOnly }) : await seedDemo(db, { force, connectDemoMerchant, configOnly });
  if (!r) {
    console.log(`seed: skipped (--if-empty: the database already has ${(await listAgents(db)).length} agent(s))`);
    process.exit(0);
  }
  const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
  const where = url.startsWith("file:") ? url.slice(5) : url;
  console.log(`seed: ${r.agents} agents, ${r.mandates} mandates, ${r.requests} requests -> ${existsSync(where) ? where : url}`);
  console.log(`seed: This month ${usd(r.thisMonthSpentCents)} of ${usd(r.thisMonthLimitCents)} across ${r.agents} agents${r.replaced ? ` (replaced ${r.replaced} earlier seed agents)` : ""}`);
  if (!configOnly) console.log("seed: the history is the recorded real sandbox run (scripts/demo/fixtures/real-sandbox-run.json), times shifted to end just now");
  console.log("seed: pending approvals expire after REINS_APPROVAL_TTL_MINUTES (default 30); re-run `pnpm seed` before a demo.");
  process.exit(0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`seed failed: ${err instanceof Error ? err.message : "error"}`);
    process.exit(1);
  });
}
