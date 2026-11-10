import { randomBytes } from "node:crypto";
import { PLAYGROUND_SCOPE_PREFIX, getWorkspace, listAgents, listRequestsSince, purgeAgents, type ReinsDb } from "@reins/db";
import { hashApiKey } from "./keys.ts";
import type { AuditProvider, AuditVerdict } from "./policy/audit.ts";
import { rotateAgentKey } from "./agentControl.ts";
import { authenticateAgent, createAgent, getLedgerRow, mcpSnippet, saveMandate, submitPurchase, type ReinsContext } from "./service.ts";
import type { LedgerRow } from "./views.ts";

/**
 * /try playground: lets a judge raise purchase requests as an AI agent without an MCP client. The request goes through
 * the same authenticateAgent + submitPurchase path as POST /api/requests (the path the MCP tool request_purchase
 * calls), with a demo agent key that is held in server memory only.
 */
export const PLAYGROUND_AGENT = "Playground Agent";
/** The playground relaxes only the velocity rule (3 requests / 10 min) so the presets can be clicked repeatedly. */
export const PLAYGROUND_VELOCITY_MAX = 100;
export const PLAYGROUND_MANDATE = {
  monthly_limit: "300.00",
  auto_approve_limit: "30.00",
  per_purchase_cap: "100.00",
  allowed_merchants: ["namecheap.com", "statista.com", "vercel.com"],
  categories: ["infrastructure", "research"],
  purpose: "Buy a domain and market research reports for a small team",
};

/** Simulates a prompt-injected or careless auditor: approves everything with low risk. Code-level rules must still hold. */
export class FooledAuditor implements AuditProvider {
  readonly name = "fooled";
  async audit(): Promise<AuditVerdict> {
    return {
      decision: "AUTO_APPROVE",
      risk: 1,
      reason_en: "Simulated fooled auditor: approves everything.",
      reason_ko: "시뮬레이션: 속은 감사기가 모든 요청을 승인합니다.",
    };
  }
}

/** Playground state per database: the demo key lives in server memory only (the DB stores its hash). */
const keys = new WeakMap<ReinsDb, string>();

export function playgroundEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.REINS_TRY === "1" || env.REINS_PUBLIC_DEMO === "1";
}

/** Judge mode = `pnpm judge` / REINS_TRY=1 on a throwaway database. The public demo is not judge mode, so it never offers a reset. */
export function judgeMode(env: Record<string, string | undefined> = process.env): boolean {
  return env.REINS_TRY === "1";
}

/**
 * Per-visitor playground scope (#2): the /try page gives every visit a random id (cookie reins_try). Requests carry it
 * in client_request_id ("try:<id>:..."), and the spend, split-purchase, velocity and auditor-history windows only see
 * that visitor's rows. Every judge therefore gets the scripted outcomes, however many judges came before.
 */
export const PLAYGROUND_COOKIE = "reins_try";
const VISITOR_ID = /^[A-Za-z0-9-]{8,40}$/;

export function newPlaygroundVisitor(): string {
  return randomBytes(12).toString("hex");
}

export function isPlaygroundVisitor(id: string | null | undefined): id is string {
  return typeof id === "string" && VISITOR_ID.test(id);
}

export function playgroundScope(visitor: string): string {
  if (!isPlaygroundVisitor(visitor)) throw new Error("invalid playground visitor id");
  return `${PLAYGROUND_SCOPE_PREFIX}${visitor}:`;
}

async function ensureAgent(ctx: ReinsContext): Promise<string> {
  const existing = (await listAgents(ctx.db)).find((a) => a.name === PLAYGROUND_AGENT && !a.revokedAt);
  const known = keys.get(ctx.db);
  // the cached key is only good while it still matches the stored hash (a key rotation on the Agents screen replaces it)
  if (existing && known && hashApiKey(known) === existing.keyHash) return known;
  if (existing) {
    // server restarted or the key was rotated elsewhere: the cached key is gone or stale, so issue a fresh one
    const { api_key } = await rotateAgentKey(ctx, existing.id, "playground");
    keys.set(ctx.db, api_key);
    return api_key;
  }
  const created = await createAgent(ctx, PLAYGROUND_AGENT);
  await saveMandate(ctx, created.agent.id, PLAYGROUND_MANDATE);
  keys.set(ctx.db, created.api_key);
  return created.api_key;
}

export interface PlaygroundResult {
  row: LedgerRow;
  auditor: "configured" | "fooled";
  /** Names of the hard rules that failed (empty when the request passed stage 1). */
  failed_rules: string[];
  /** Whether PayPal money moved (sandbox or simulated) for this request. */
  paypal: "sandbox" | "simulated" | "none";
}

export async function runPlayground(ctx: ReinsContext, raw: unknown, opts: { fooled?: boolean; visitor?: string } = {}): Promise<PlaygroundResult> {
  const key = await ensureAgent(ctx);
  const agent = await authenticateAgent(ctx, `Bearer ${key}`);
  const run: ReinsContext = {
    ...ctx,
    auditor: opts.fooled ? new FooledAuditor() : ctx.auditor,
    config: { ...ctx.config, velocityMax: PLAYGROUND_VELOCITY_MAX },
  };
  const view = await submitPurchase(run, agent, raw, { scope: playgroundScope(opts.visitor ?? "local-default") });
  const row = await getLedgerRow(ctx, view.request_id);
  const hard = row.decisions.find((d) => d.stage === "hard_rules");
  const results = (hard?.details as { results?: Array<{ rule: string; ok: boolean }> } | null)?.results ?? [];
  const ws = await getWorkspace(ctx.db);
  return {
    row,
    auditor: opts.fooled ? "fooled" : "configured",
    failed_rules: results.filter((r) => !r.ok).map((r) => r.rule),
    paypal: row.payment ? (ws.paypalEnv === "sandbox" ? "sandbox" : "simulated") : "none",
  };
}

/**
 * "Reset demo data" on /try (judge mode only): deletes the Playground Agent with all of its requests, decisions, payments
 * and messages. The seeded agents and their ledger are never touched. Returns how many requests were removed.
 */
export async function resetPlayground(ctx: ReinsContext): Promise<{ removed_requests: number }> {
  const ids = (await listAgents(ctx.db)).filter((a) => a.name === PLAYGROUND_AGENT).map((a) => a.id);
  if (!ids.length) return { removed_requests: 0 };
  const rows = await listRequestsSince(ctx.db, 0);
  const removed = rows.filter((r) => ids.includes(r.agentId)).length;
  await purgeAgents(ctx.db, ids);
  keys.delete(ctx.db);
  return { removed_requests: removed };
}

/**
 * "Connect your agent" card: the demo key of the Playground Agent (demo instances only, throwaway data), the API base URL and the
 * ready-made MCP config. Real agents get their own key on the Agents screen; this one only exists so a judge can paste and run.
 */
export async function playgroundConnect(ctx: ReinsContext) {
  const api_key = await ensureAgent(ctx);
  const api_url = ctx.config.apiBaseUrl ?? ctx.config.publicBaseUrl;
  return { agent: PLAYGROUND_AGENT, api_key, api_url, mcp_config: mcpSnippet(api_url, api_key) };
}
