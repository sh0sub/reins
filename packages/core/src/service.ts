import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  CLAIM_STATUSES,
  MERCHANT_RESERVED_STATUSES,
  RESERVED_STATUSES,
  claimForPayment,
  countRequestsSince,
  createMandateVersion,
  findAgentByKeyHash,
  getActiveMandate,
  getAgent,
  getMandate,
  getPaymentByRequest,
  getRequest,
  getWorkspace,
  insertAgent,
  insertDecision,
  insertPayment,
  insertRequest,
  insertRequestMessage,
  listRequestMessages,
  listAgents,
  listDecisions,
  listRequests,
  reservedSpendSinceCents,
  spendAtMerchantSinceCents,
  spendScopeOf,
  spendSinceCents,
  transitionRequest,
  updatePayment,
  updateRequest,
  PLAYGROUND_SCOPE_PREFIX,
  type Agent,
  type Mandate,
  type PurchaseRequest,
  type ReinsDb,
  type RequestStatus,
} from "@reins/db";
import { buildAuditInput, runAudit, RECENT_LIMIT, type AuditProvider } from "./policy/audit.ts";
import { evaluateHardRules, MERCHANT_WINDOW_MS, monthStartUtc, VELOCITY_WINDOW_MS, type HardRuleOutcome } from "./policy/hardRules.ts";
import { anomalySummary, applyAnomalies, detectAnomalies, type QuietHours } from "./policy/anomalies.ts";
import { writeRuleSentence, type RuleWriter } from "./policy/ruleWriter.ts";
import { summarizeAnswer, type AnswerSummarizer } from "./policy/answerSummary.ts";
import { generateApiKey, hashApiKey, parseBearer } from "./keys.ts";
import { lookupDemoKey } from "./demoKeys.ts";
import { InvalidMerchantError, isPublicSuffix, merchantInList, normalizeMerchant, parseMerchant, registrableDomain } from "./merchant.ts";
import { centsToValue, toCents } from "./money.ts";
import { STRATEGIES, type PaymentMode, type StrategyResult } from "./pay/strategies.ts";
import type { PayPalClient } from "./paypal/types.ts";
import type { CategorySuggester } from "./policy/categories.ts";
import type { WeeklySummarizer } from "./weeklySummary.ts";
import { ReinsEvents, type Notifier } from "./events.ts";
import { latestClarification, toLedgerRow, toRequestView, type LedgerRow, type RequestView } from "./views.ts";

export interface ReinsConfig {
  publicBaseUrl: string;
  /** REST base URL the MCP server should call (shown in the MCP snippet). */
  apiBaseUrl?: string;
  paypalWebhookId?: string;
  treasuryPayeeEmail?: string | null;
  vaultStoredCredential?: boolean;
  approvalTtlMs: number;
  /** After a hard-rule DENY, still ask the auditor for a one-line explanation (decision stays DENY). */
  explainDenials: boolean;
  auditTimeoutMs?: number;
  /** S3 late-night check. Unset = off (tests); the web context sets it from REINS_TIMEZONE / REINS_QUIET_HOURS. */
  quietHours?: QuietHours | null;
  /** Overrides the velocity rule's max requests per 10 minutes (only the /try playground sets this). */
  velocityMax?: number;
  /** H5: an awaiting_buyer checkout older than this stops counting as committed spend (default 3 hours). */
  checkoutTtlMs?: number;
}

export const DEFAULT_CHECKOUT_TTL_MS = 3 * 60 * 60 * 1000;

export interface ReinsContext {
  db: ReinsDb;
  paypal: PayPalClient;
  auditor: AuditProvider;
  /** M3 category suggestions; keyword fallback when absent. */
  categorySuggester?: CategorySuggester;
  /** S1 AI weekly summary; template fallback when absent. */
  summarizer?: WeeklySummarizer;
  /** S5 rule sentence ("Research Scout can now buy from statista.com up to $59.00…"); template when absent. */
  ruleWriter?: RuleWriter;
  /** S2 one-line summary of long agent answers; template when absent. */
  answerSummarizer?: AnswerSummarizer;
  events: ReinsEvents;
  notifiers: Notifier[];
  config: ReinsConfig;
  now: () => number;
}

export class ReinsError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ReinsError";
  }
}

// ---------------- input schemas ----------------

const money = z.union([z.string(), z.number()]).transform((v, ctx) => {
  try {
    return toCents(v);
  } catch {
    ctx.addIssue({ code: "custom", message: "Amount must look like 12.98" });
    return z.NEVER;
  }
});

/** H1: strict merchant hostname (lowercase, no port, trailing dot or path, punycode, at least two valid labels). */
const merchantHost = z.string().max(300).transform((v, ctx) => {
  try {
    return parseMerchant(v);
  } catch (err) {
    ctx.addIssue({ code: "custom", message: err instanceof InvalidMerchantError ? err.message : "invalid merchant" });
    return z.NEVER;
  }
});

/** H2: allow-list entries and merchant rules must name a registrable domain, never a public suffix like com or github.io. */
const registrableHost = merchantHost.refine((h) => !isPublicSuffix(h), { message: "must be a registrable domain such as vercel.com, not a public suffix" });

export const PurchaseInputSchema = z.object({
  merchant: merchantHost,
  amount: money,
  currency: z.string().trim().length(3).default("USD").transform((s) => s.toUpperCase()),
  items: z.string().trim().min(1).max(500),
  reason: z.string().trim().min(1).max(1000),
  category: z.string().trim().min(1).max(64).optional(),
  client_request_id: z.string().trim().min(1).max(128).optional(),
});
export type PurchaseInput = z.input<typeof PurchaseInputSchema>;

const isoOrNull = z
  .union([z.string().datetime({ offset: true }), z.null()])
  .optional()
  .transform((v) => (v ? Date.parse(v) : null));

export const MandateInputSchema = z
  .object({
    monthly_limit: money,
    auto_approve_limit: money,
    per_purchase_cap: z.union([money, z.null()]).optional().transform((v) => v ?? null),
    currency: z.string().length(3).default("USD"),
    allowed_merchants: z.array(registrableHost).max(100).default([]),
    blocked_merchants: z.array(merchantHost).max(100).default([]),
    categories: z.array(z.string().trim().min(1).max(64)).max(30).default([]),
    /** S5 merchant rules: { "statista.com": "59.00" } raises the auto-approve limit for that merchant only. */
    merchant_auto_limits: z
      .record(z.string().trim().min(1).max(253), money)
      .default({})
      .refine((r) => Object.keys(r).length <= 50, { message: "at most 50 merchant rules" })
      .superRefine((r, ctx) => {
        for (const k of Object.keys(r)) {
          const parsed = registrableHost.safeParse(k);
          if (!parsed.success) ctx.addIssue({ code: "custom", message: `${k}: ${parsed.error.issues[0]?.message ?? "invalid merchant"}` });
        }
      }),
    purpose: z.string().trim().min(1).max(500),
    valid_from: isoOrNull,
    valid_until: isoOrNull,
  })
  .refine((m) => m.auto_approve_limit <= m.monthly_limit, {
    message: "auto_approve_limit must not exceed monthly_limit",
    path: ["auto_approve_limit"],
  })
  .refine((m) => m.valid_from == null || m.valid_until == null || m.valid_from < m.valid_until, {
    message: "valid_until must be after valid_from",
    path: ["valid_until"],
  })
  .refine((m) => Object.values(m.merchant_auto_limits).every((c) => c > 0 && c <= m.monthly_limit), {
    message: "each merchant auto-approve limit must be above 0 and not exceed monthly_limit",
    path: ["merchant_auto_limits"],
  });
export type MandateInput = z.input<typeof MandateInputSchema>;

function parseOr400<T extends z.ZodTypeAny>(schema: T, input: unknown): z.output<T> {
  const r = schema.safeParse(input);
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
    throw new ReinsError(400, "invalid_input", msg);
  }
  return r.data;
}

// ---------------- agents & mandates (M2, M3) ----------------

export async function authenticateAgent(ctx: ReinsContext, authorization: string | null | undefined): Promise<Agent> {
  return (await authenticateAgentScoped(ctx, authorization)).agent;
}

/**
 * Like authenticateAgent, plus the playground scope of a per-visitor demo key (demoKeys.ts): requests made with such a
 * key only see that visitor's rows. `scope` is undefined for ordinary agent keys.
 */
export async function authenticateAgentScoped(ctx: ReinsContext, authorization: string | null | undefined): Promise<{ agent: Agent; scope?: string }> {
  const key = parseBearer(authorization);
  if (!key) throw new ReinsError(401, "missing_key", "Missing Authorization: Bearer <agent key>");
  const demo = lookupDemoKey(ctx.db, key, ctx.now());
  if (demo?.state === "expired") throw new ReinsError(401, "expired_key", "This demo key has expired. Reload /try for a new one.");
  if (demo) {
    const agent = await getAgent(ctx.db, demo.entry.agentId);
    if (!agent || agent.revokedAt) throw new ReinsError(401, "invalid_key", "Invalid or revoked agent key");
    return { agent, scope: demo.entry.scope };
  }
  const agent = await findAgentByKeyHash(ctx.db, hashApiKey(key));
  if (!agent || agent.revokedAt) throw new ReinsError(401, "invalid_key", "Invalid or revoked agent key");
  return { agent };
}

export function mcpSnippet(apiBaseUrl: string, apiKey: string) {
  return {
    mcpServers: {
      reins: {
        command: "npx",
        args: ["-y", "tsx", "/ABSOLUTE/PATH/TO/reins/apps/mcp/src/stdio.ts"],
        env: { REINS_URL: apiBaseUrl, REINS_API_KEY: apiKey },
      },
    },
  };
}

/** Issues a new agent with a one-time key. Only the hash is persisted. */
export async function createAgent(ctx: ReinsContext, name: string) {
  const clean = name.trim();
  if (!clean || clean.length > 80) throw new ReinsError(400, "invalid_input", "name: 1-80 characters");
  const { key, hash, displayPrefix } = generateApiKey();
  const agent = await insertAgent(ctx.db, { name: clean, keyHash: hash, keyPrefix: displayPrefix });
  return {
    agent: { id: agent.id, name: agent.name, key_prefix: agent.keyPrefix, created_at: new Date(agent.createdAt).toISOString() },
    api_key: key,
    mcp_snippet: mcpSnippet(ctx.config.apiBaseUrl ?? ctx.config.publicBaseUrl, key),
  };
}

export async function listAgentSummaries(ctx: ReinsContext) {
  const agents = await listAgents(ctx.db);
  const since = monthStartUtc(ctx.now());
  return Promise.all(
    agents.map(async (a) => {
      const m = await getActiveMandate(ctx.db, a.id);
      return {
        id: a.id,
        name: a.name,
        key_prefix: a.keyPrefix,
        revoked: a.revokedAt != null,
        /** S2: active / paused / revoked. */
        status: a.revokedAt != null ? ("revoked" as const) : a.pausedAt != null ? ("paused" as const) : ("active" as const),
        paused_at: a.pausedAt == null ? null : new Date(a.pausedAt).toISOString(),
        key_rotated_at: a.keyRotatedAt == null ? null : new Date(a.keyRotatedAt).toISOString(),
        created_at: new Date(a.createdAt).toISOString(),
        mandate_version: m?.version ?? null,
        month_spent_cents: await spendSinceCents(ctx.db, a.id, since),
        monthly_limit_cents: m?.monthlyLimitCents ?? null,
      };
    }),
  );
}

export async function saveMandate(ctx: ReinsContext, agentId: string, raw: unknown): Promise<Mandate> {
  const agent = await getAgent(ctx.db, agentId);
  if (!agent) throw new ReinsError(404, "not_found", "Agent not found");
  const m = parseOr400(MandateInputSchema, raw);
  return createMandateVersion(ctx.db, agentId, {
    monthlyLimitCents: m.monthly_limit,
    autoApproveLimitCents: m.auto_approve_limit,
    perTxCapCents: m.per_purchase_cap,
    currency: m.currency.toUpperCase(),
    allowedMerchants: m.allowed_merchants,
    blockedMerchants: m.blocked_merchants,
    categories: m.categories,
    merchantAutoLimits: Object.fromEntries(Object.entries(m.merchant_auto_limits).map(([k, v]) => [parseMerchant(k), v])),
    purpose: m.purpose,
    validFrom: m.valid_from,
    validUntil: m.valid_until,
  });
}

// ---------------- purchase flow (M5 -> M6 -> M7/M8) ----------------

async function viewOf(ctx: ReinsContext, r: PurchaseRequest): Promise<RequestView> {
  return toRequestView(r, await getPaymentByRequest(ctx.db, r.id), await listRequestMessages(ctx.db, r.id), ctx.config.publicBaseUrl);
}

/**
 * Auto-approve limit for this merchant: the mandate's general limit, raised by an S5 merchant rule when one
 * matches (exact domain or subdomain).
 */
export function effectiveAutoLimitCents(mandate: Pick<Mandate, "autoApproveLimitCents" | "merchantAutoLimits">, merchant: string): number {
  let limit = mandate.autoApproveLimitCents;
  for (const [m, cents] of Object.entries(mandate.merchantAutoLimits ?? {})) {
    if (merchantInList(merchant, [m])) limit = Math.max(limit, cents);
  }
  return limit;
}

async function publish(ctx: ReinsContext, r: PurchaseRequest, type: "request.created" | "request.updated" = "request.updated") {
  const view = await viewOf(ctx, r);
  ctx.events.emit({ type, request: view });
  return view;
}

async function notify(ctx: ReinsContext, kind: "pendingHuman" | "resolved" | "updated", view: RequestView) {
  await Promise.all(ctx.notifiers.map((n) => n[kind]?.(view).catch(() => undefined)));
}

/**
 * Entry point for `request_purchase`. Idempotent on (agent, client_request_id): a retry returns the
 * existing request instead of paying twice.
 */
export async function submitPurchase(ctx: ReinsContext, agent: Agent, raw: unknown, opts: { scope?: string } = {}): Promise<RequestView> {
  const input = parseOr400(PurchaseInputSchema, raw);
  if (input.client_request_id?.startsWith(PLAYGROUND_SCOPE_PREFIX) && !opts.scope) {
    throw new ReinsError(400, "invalid_input", `client_request_id must not start with "${PLAYGROUND_SCOPE_PREFIX}" (reserved for the /try playground)`);
  }
  const now = ctx.now();
  const mandate = await getActiveMandate(ctx.db, agent.id);
  // H5: abandoned PayPal checkouts stop holding this agent's budget before the new request is checked
  await expireAbandonedCheckouts(ctx, agent.id);

  const cid = input.client_request_id ?? `auto-${randomUUID()}`;
  const { created, request } = await insertRequest(ctx.db, {
    agentId: agent.id,
    mandateId: mandate?.id ?? null,
    clientRequestId: opts.scope ? `${opts.scope}${cid}` : cid,
    merchant: input.merchant,
    amountCents: input.amount,
    currency: input.currency,
    items: input.items,
    reason: input.reason,
    category: input.category ?? null,
    createdAt: now,
  });
  if (!created) {
    // M5: the same idempotency key with a different purchase is a client bug, not a retry
    if (request.merchant !== input.merchant || request.amountCents !== input.amount || request.currency !== input.currency || request.items !== input.items) {
      throw new ReinsError(409, "idempotency_conflict", "client_request_id was already used for a different purchase");
    }
    return viewOf(ctx, request);
  }
  await publish(ctx, request, "request.created");

  // ---- stage 1: hard rules ----
  // C2: the monthly limit counts reserved spend (committed + reviewing + waiting for a person), not only paid orders.
  // Playground rows only count inside the same /try visitor (spendScopeOf), so judges never fill each other's caps.
  const monthStart = monthStartUtc(now);
  const scope = spendScopeOf(request.clientRequestId);
  const [monthSpent, recentCount, merchantSpent] = await Promise.all([
    reservedSpendSinceCents(ctx.db, agent.id, monthStart, { excludeId: request.id, scope, statuses: RESERVED_STATUSES }),
    countRequestsSince(ctx.db, agent.id, now - VELOCITY_WINDOW_MS, request.id, { scope }),
    spendAtMerchantSinceCents(ctx.db, agent.id, registrableDomain(request.merchant), now - MERCHANT_WINDOW_MS, request.id, { scope, statuses: MERCHANT_RESERVED_STATUSES }),
  ]);
  const hard = evaluateHardRules({
    mandate: mandate ?? null,
    agentRevoked: agent.revokedAt != null,
    agentPaused: agent.pausedAt != null,
    request: { merchant: request.merchant, amountCents: request.amountCents, currency: request.currency },
    now,
    monthSpentCents: monthSpent,
    recentRequestCount: recentCount,
    merchantSpent24hCents: merchantSpent,
    velocityMax: ctx.config.velocityMax,
  });
  const failedText = hard.failed.map((f) => f.detail).join("; ");
  await insertDecision(ctx.db, {
    requestId: request.id,
    stage: "hard_rules",
    decision: hard.pass ? "PASS" : "DENY",
    risk: null,
    reasonEn: hard.pass ? "All hard rules passed" : failedText,
    reasonKo: null,
    details: { results: hard.results },
    actor: "policy",
  });

  const recent = (await listRequests(ctx.db, { agentId: agent.id, scope, limit: RECENT_LIMIT + 1 }))
    .filter((r) => r.id !== request.id)
    .slice(0, RECENT_LIMIT);

  // ---- S3 unusual patterns (recorded on every request; weighted only when the auditor runs) ----
  const anomalies = detectAnomalies({ request, mandate: mandate ?? null, recent, quietHours: ctx.config.quietHours });
  const autoLimit = mandate ? effectiveAutoLimitCents(mandate, request.merchant) : 0;
  const auditInput = () => {
    const input = buildAuditInput(mandate!, request, recent, monthSpent, anomalies);
    input.mandate.auto_approve_limit = centsToValue(autoLimit);
    return input;
  };

  if (!hard.pass) {
    let reasonEn = `Blocked by hard rules: ${failedText}.`;
    let reasonKo = `하드 룰에서 차단: ${hard.failed.map((f) => f.rule).join(", ")}.`;
    let risk: number | null = null;
    // A paused agent is stopped by its owner: no auditor call (and no PayPal call) at all. M1: neither for a burst
    // (velocity) or a broken amount, so a flood of requests cannot turn into a flood of paid Claude calls.
    const skipAdvice = hard.failed.some((f) => f.rule === "agent_paused" || f.rule === "velocity" || f.rule === "amount_valid");
    if (ctx.config.explainDenials && mandate && !skipAdvice) {
      // Advisory only: the decision is already DENY and cannot be changed by the auditor.
      const advice = await runAudit(ctx.auditor, auditInput(), request.amountCents, autoLimit, ctx.config.auditTimeoutMs);
      await insertDecision(ctx.db, {
        requestId: request.id,
        stage: "llm",
        decision: advice.final,
        risk: advice.risk,
        reasonEn: advice.reasonEn,
        reasonKo: advice.reasonKo,
        details: { provider: advice.provider, advisory: true, failed: advice.failed, latency_ms: advice.latencyMs, ...(advice.tokens ? { tokens: advice.tokens } : {}) },
        actor: advice.provider,
      });
      if (!advice.failed) {
        reasonEn += ` ${advice.reasonEn}`;
        reasonKo += ` ${advice.reasonKo}`;
        risk = advice.risk;
      }
    }
    const denied = await updateRequest(ctx.db, request.id, { status: "denied", finalDecision: "DENY", risk, reasonEn, reasonKo, anomalies });
    const view = await publish(ctx, denied);
    await notify(ctx, "resolved", view);
    return view;
  }

  // ---- stage 2: LLM audit (only reached when every hard rule passed) ----
  const audit = await runAudit(ctx.auditor, auditInput(), request.amountCents, autoLimit, ctx.config.auditTimeoutMs);
  await insertDecision(ctx.db, {
    requestId: request.id,
    stage: "llm",
    decision: audit.final,
    risk: audit.risk,
    reasonEn: audit.reasonEn,
    reasonKo: audit.reasonKo,
    details: {
      provider: audit.provider,
      failed: audit.failed,
      latency_ms: audit.latencyMs,
      ...(audit.tokens ? { tokens: audit.tokens } : {}),
      ...(audit.error ? { error: audit.error.slice(0, 200) } : {}),
      ...(autoLimit !== mandate!.autoApproveLimitCents ? { merchant_auto_limit: centsToValue(autoLimit) } : {}),
    },
    actor: audit.provider,
  });

  // S3: patterns weigh the risk and turn AUTO into ASK_HUMAN, recorded as their own step in the decision trail.
  const weighed = applyAnomalies(audit.final, audit.risk, anomalies);
  let reasonEn = audit.reasonEn;
  let reasonKo = audit.reasonKo;
  if (anomalies.length) {
    await insertDecision(ctx.db, {
      requestId: request.id,
      stage: "system",
      decision: weighed.final,
      risk: weighed.risk,
      reasonEn: anomalySummary(anomalies, "en"),
      reasonKo: anomalySummary(anomalies, "ko"),
      details: { anomalies, escalated: weighed.escalated, auditor_risk: audit.risk },
      actor: "patterns",
    });
    reasonEn = `${reasonEn} ${anomalySummary(anomalies, "en")}`;
    reasonKo = `${reasonKo} ${anomalySummary(anomalies, "ko")}`;
  }
  const decided = await updateRequest(ctx.db, request.id, {
    finalDecision: weighed.final,
    risk: weighed.risk,
    reasonEn,
    reasonKo,
    anomalies,
  });

  if (weighed.final === "DENY") {
    const denied = await updateRequest(ctx.db, decided.id, { status: "denied" });
    const view = await publish(ctx, denied);
    await notify(ctx, "resolved", view);
    return view;
  }
  if (weighed.final === "ASK_HUMAN") {
    const pending = (await transitionRequest(ctx.db, decided.id, ["reviewing"], { status: "pending_human" }))!;
    const view = await publish(ctx, pending);
    await notify(ctx, "pendingHuman", view);
    return view;
  }
  return pay(ctx, decided, ["reviewing"]);
}

/**
 * C2 pay-time re-check: the agent, mandate and budget may have changed while the request waited (pause, revoke, a lower
 * cap, an edited allow/block list, other orders paid meanwhile). Hard rules run again against the CURRENT agent and
 * mandate, then the request is claimed for payment in one atomic statement (claimForPayment) that re-checks the monthly
 * limit and, for agent-paid orders, the split-purchase total. Anything that no longer fits is denied with
 * "Limits changed since the request".
 */
async function recheckForPayment(ctx: ReinsContext, r: PurchaseRequest, human: boolean): Promise<{ hard: HardRuleOutcome; guard: Parameters<typeof claimForPayment>[3] | null }> {
  const now = ctx.now();
  const [agent, mandate] = await Promise.all([getAgent(ctx.db, r.agentId), getActiveMandate(ctx.db, r.agentId)]);
  const scope = spendScopeOf(r.clientRequestId);
  const monthStart = monthStartUtc(now);
  const domain = registrableDomain(r.merchant);
  const since = now - MERCHANT_WINDOW_MS;
  const [monthSpent, merchantSpent] = await Promise.all([
    reservedSpendSinceCents(ctx.db, r.agentId, monthStart, { excludeId: r.id, scope, statuses: CLAIM_STATUSES }),
    human ? Promise.resolve(undefined) : spendAtMerchantSinceCents(ctx.db, r.agentId, domain, since, r.id, { scope, statuses: CLAIM_STATUSES }),
  ]);
  const hard = evaluateHardRules({
    mandate: mandate ?? null,
    agentRevoked: !agent || agent.revokedAt != null,
    agentPaused: agent?.pausedAt != null,
    request: { merchant: r.merchant, amountCents: r.amountCents, currency: r.currency },
    now,
    monthSpentCents: monthSpent,
    recentRequestCount: 0, // velocity is about how fast requests arrive, not when a person approves them
    merchantSpent24hCents: merchantSpent,
  });
  if (!hard.pass || !mandate) return { hard, guard: null };
  return {
    hard,
    guard: {
      agentId: r.agentId,
      amountCents: r.amountCents,
      monthStart,
      monthlyLimitCents: mandate.monthlyLimitCents,
      scope,
      ...(!human && mandate.perTxCapCents != null ? { merchant: { domain, since, capCents: mandate.perTxCapCents } } : {}),
    },
  };
}

export const LIMITS_CHANGED = "Limits changed since the request";

async function denyAtPayTime(ctx: ReinsContext, r: PurchaseRequest, from: RequestStatus[], detail: string, results: unknown): Promise<RequestView> {
  const reasonEn = `${LIMITS_CHANGED}: ${detail}.`;
  const denied = await transitionRequest(ctx.db, r.id, from, {
    status: "denied",
    finalDecision: "DENY",
    reasonEn,
    reasonKo: `요청 이후 한도가 바뀜: ${detail}.`,
  });
  if (!denied) return viewOf(ctx, (await getRequest(ctx.db, r.id))!);
  await insertDecision(ctx.db, { requestId: r.id, stage: "system", decision: "DENY", risk: null, reasonEn, reasonKo: null, details: { recheck: "payment", results }, actor: "policy" });
  const view = await publish(ctx, denied);
  await notify(ctx, "resolved", view);
  return view;
}

/** Moves an approved request through the workspace's payment strategy. `human`: a person approved it (split rule skipped). */
async function pay(ctx: ReinsContext, r: PurchaseRequest, from: RequestStatus[], opts: { human?: boolean } = {}): Promise<RequestView> {
  const { hard, guard } = await recheckForPayment(ctx, r, opts.human === true);
  if (!guard) return denyAtPayTime(ctx, r, from, hard.failed.map((f) => f.detail).join("; ") || "no active mandate", hard.results);
  const claimed = await claimForPayment(ctx.db, r.id, from, guard);
  if (!claimed) {
    const cur = (await getRequest(ctx.db, r.id))!;
    // still claimable, so the atomic budget check is what failed (another order took the room a moment ago)
    if (from.includes(cur.status)) return denyAtPayTime(ctx, cur, from, "the monthly limit or the per-merchant total no longer fits", hard.results);
    return viewOf(ctx, cur);
  }
  await publish(ctx, claimed);
  return executePayment(ctx, claimed);
}

/** Runs the payment strategy for a request already in `paying` and records the outcome. Idempotent on PayPal's side. */
async function executePayment(ctx: ReinsContext, claimed: PurchaseRequest): Promise<RequestView> {
  const ws = await getWorkspace(ctx.db);
  const existing = await getPaymentByRequest(ctx.db, claimed.id);
  const mode = (existing?.strategy ?? ws.paymentMode) as PaymentMode;
  const result = await STRATEGIES[mode].execute(claimed, {
    paypal: ctx.paypal,
    publicBaseUrl: ctx.config.publicBaseUrl,
    vaultId: ws.vaultId,
    treasuryPayeeEmail: ctx.config.treasuryPayeeEmail,
    vaultStoredCredential: ctx.config.vaultStoredCredential,
  });
  const fields = {
    status: paymentStatusOf(result),
    paypalOrderId: result.orderId ?? existing?.paypalOrderId ?? null,
    captureId: result.captureId ?? null,
    payoutBatchId: result.payoutBatchId ?? null,
    approveUrl: result.approveUrl ?? null,
    error: result.status === "unknown" ? `${UNKNOWN_PREFIX}${result.error ?? ""}`.slice(0, 500) : (result.error?.slice(0, 500) ?? null),
  };
  if (existing) await updatePayment(ctx.db, existing.id, fields);
  else await insertPayment(ctx.db, { requestId: claimed.id, strategy: mode, amountCents: claimed.amountCents, currency: claimed.currency, ...fields });
  // H4: "unknown" (timeout, network error or PayPal 5xx after one retry) stays paying, still committed, until
  // resolvePendingPayments asks PayPal again. Only a definite failure releases the budget.
  const next: RequestStatus =
    result.status === "completed" ? "paid" : result.status === "awaiting_buyer" ? "awaiting_buyer" : result.status === "pending" || result.status === "unknown" ? "paying" : "failed";
  const updated = next === "paying" ? ((await getRequest(ctx.db, claimed.id)) ?? claimed) : ((await transitionRequest(ctx.db, claimed.id, ["paying"], { status: next })) ?? (await getRequest(ctx.db, claimed.id))!);
  const view = await publish(ctx, updated);
  if (next !== "paying") await notify(ctx, "resolved", view);
  return view;
}

/** Marks a payment whose PayPal outcome is not known yet (H4). */
export const UNKNOWN_PREFIX = "unknown: ";

function paymentStatusOf(r: StrategyResult): "completed" | "awaiting_buyer" | "pending" | "failed" {
  return r.status === "completed" ? "completed" : r.status === "awaiting_buyer" ? "awaiting_buyer" : r.status === "pending" || r.status === "unknown" ? "pending" : "failed";
}

/** Human decision from the web inbox or Telegram. First writer wins; the loser gets 409. */
export async function decideRequest(
  ctx: ReinsContext,
  requestId: string,
  action: "approve" | "deny",
  actor: string,
  note?: string,
): Promise<RequestView> {
  const r = await getRequest(ctx.db, requestId);
  if (!r) throw new ReinsError(404, "not_found", "Request not found");
  if (r.status === "pending_human" && ctx.now() - r.updatedAt > ctx.config.approvalTtlMs) {
    await expireRequest(ctx, r);
    throw new ReinsError(409, "expired", "This approval request has expired");
  }
  if (action === "deny") {
    const why = note?.trim().slice(0, 200);
    const denied = await transitionRequest(ctx.db, requestId, ["pending_human"], {
      status: "denied",
      finalDecision: "DENY",
      reasonEn: `Denied by ${actor}${why ? `: ${why}` : ""}. ${r.reasonEn ?? ""}`.trim(),
      reasonKo: `${actor}이(가) 거절함${why ? `: ${why}` : ""}. ${r.reasonKo ?? ""}`.trim(),
    });
    if (!denied) throw new ReinsError(409, "already_decided", `Request is already ${r.status}`);
    await insertDecision(ctx.db, { requestId, stage: "human", decision: "DENY", risk: null, reasonEn: why ?? null, reasonKo: null, details: null, actor });
    const view = await publish(ctx, denied);
    await notify(ctx, "resolved", view);
    return view;
  }
  const approved = await transitionRequest(ctx.db, requestId, ["pending_human"], { status: "approved" });
  if (!approved) throw new ReinsError(409, "already_decided", `Request is already ${r.status}`);
  await insertDecision(ctx.db, { requestId, stage: "human", decision: "APPROVE", risk: null, reasonEn: null, reasonKo: null, details: null, actor });
  return pay(ctx, approved, ["approved"], { human: true });
}

export interface MerchantRule {
  merchant: string;
  limit: string;
  mandate_version: number;
  sentence: string;
  /** "template" or the Claude model that wrote the sentence. */
  source: string;
}

/**
 * S5 "Approve + always allow this merchant" (one tap on the web inbox or Telegram): approves the request, then
 * saves a new mandate version whose merchant rule auto-approves this merchant up to this amount. Hard rules
 * (monthly cap, per-purchase cap, block list) and the auditor still run on every later request. The approval is
 * claimed first, so a request someone else already decided never changes the mandate.
 */
export async function approveAndAllowMerchant(ctx: ReinsContext, requestId: string, actor: string): Promise<{ view: RequestView; rule: MerchantRule }> {
  const r = await getRequest(ctx.db, requestId);
  if (!r) throw new ReinsError(404, "not_found", "Request not found");
  if (r.status === "pending_human" && ctx.now() - r.updatedAt > ctx.config.approvalTtlMs) {
    await expireRequest(ctx, r);
    throw new ReinsError(409, "expired", "This approval request has expired");
  }
  const current = await getActiveMandate(ctx.db, r.agentId);
  if (!current) throw new ReinsError(409, "no_mandate", "This agent has no mandate to add the rule to");
  if (merchantInList(r.merchant, current.blockedMerchants)) throw new ReinsError(409, "merchant_blocked", `${r.merchant} is blocked in the mandate`);
  if (isPublicSuffix(r.merchant)) throw new ReinsError(409, "public_suffix", `${r.merchant} is a public suffix; a merchant rule needs a registrable domain`);

  const approved = await transitionRequest(ctx.db, requestId, ["pending_human"], { status: "approved" });
  if (!approved) throw new ReinsError(409, "already_decided", `Request is already ${r.status}`);

  const merchant = normalizeMerchant(r.merchant);
  const existing = current.merchantAutoLimits?.[merchant] ?? 0;
  // never lower an existing rule, never exceed the monthly cap
  const limitCents = Math.min(Math.max(existing, r.amountCents), current.monthlyLimitCents);
  const allowlist = current.allowedMerchants.length && !merchantInList(merchant, current.allowedMerchants) ? [...current.allowedMerchants, merchant] : current.allowedMerchants;
  const next = await createMandateVersion(ctx.db, r.agentId, {
    monthlyLimitCents: current.monthlyLimitCents,
    autoApproveLimitCents: current.autoApproveLimitCents,
    perTxCapCents: current.perTxCapCents,
    currency: current.currency,
    allowedMerchants: allowlist,
    blockedMerchants: current.blockedMerchants,
    categories: current.categories,
    merchantAutoLimits: { ...current.merchantAutoLimits, [merchant]: limitCents },
    purpose: current.purpose,
    validFrom: current.validFrom,
    validUntil: current.validUntil,
  });
  const agent = await getAgent(ctx.db, r.agentId);
  const written = await writeRuleSentence(ctx.ruleWriter, {
    agent: agent?.name ?? "This agent",
    merchant,
    limitCents,
    baseAutoLimitCents: current.autoApproveLimitCents,
    mandateVersion: next.version,
  });
  const rule: MerchantRule = { merchant, limit: centsToValue(limitCents), mandate_version: next.version, sentence: written.sentence, source: written.source };
  await insertDecision(ctx.db, {
    requestId,
    stage: "human",
    decision: "APPROVE",
    risk: null,
    reasonEn: rule.sentence,
    reasonKo: null,
    details: { merchant_rule: rule },
    actor,
  });
  return { view: await pay(ctx, approved, ["approved"], { human: true }), rule };
}

async function expireRequest(ctx: ReinsContext, r: PurchaseRequest) {
  const expired = await transitionRequest(ctx.db, r.id, ["pending_human"], { status: "expired" });
  if (!expired) return;
  await insertDecision(ctx.db, { requestId: r.id, stage: "system", decision: "EXPIRE", risk: null, reasonEn: "No decision before the approval timer ran out", reasonKo: "승인 시간 만료", details: null, actor: "timer" });
  const view = await publish(ctx, expired);
  await notify(ctx, "resolved", view);
}

/**
 * H5: a supervised checkout the buyer never finished (no return, no webhook) stops counting as committed spend after
 * checkoutTtlMs (default 3 h). A capture that still arrives later is applied by the authoritative webhook (M2).
 */
export async function expireAbandonedCheckouts(ctx: ReinsContext, agentId?: string): Promise<number> {
  const waiting = await listRequests(ctx.db, { status: ["awaiting_buyer"], agentId, limit: 500 });
  const cutoff = ctx.now() - (ctx.config.checkoutTtlMs ?? DEFAULT_CHECKOUT_TTL_MS);
  let n = 0;
  for (const r of waiting) {
    if (r.updatedAt >= cutoff) continue;
    const expired = await transitionRequest(ctx.db, r.id, ["awaiting_buyer"], { status: "expired" });
    if (!expired) continue;
    n++;
    const payment = await getPaymentByRequest(ctx.db, r.id);
    if (payment?.status === "awaiting_buyer") await updatePayment(ctx.db, payment.id, { status: "failed", error: "checkout_expired" });
    await insertDecision(ctx.db, { requestId: r.id, stage: "system", decision: "EXPIRE", risk: null, reasonEn: "PayPal checkout was not finished in time; the amount no longer counts against the budget", reasonKo: "PayPal 결제가 제때 끝나지 않아 예산에서 뺐습니다", details: null, actor: "timer" });
    const view = await publish(ctx, expired);
    await notify(ctx, "resolved", view);
  }
  return n;
}

/** Expires pending_human requests older than the TTL. Run on an interval (bot/web) or before listing the inbox. */
export async function expireStale(ctx: ReinsContext): Promise<number> {
  await expireAbandonedCheckouts(ctx).catch(() => 0);
  const pending = await listRequests(ctx.db, { status: ["pending_human"], limit: 500 });
  const cutoff = ctx.now() - ctx.config.approvalTtlMs;
  let n = 0;
  for (const r of pending) {
    if (r.updatedAt < cutoff) {
      await expireRequest(ctx, r);
      n++;
    }
  }
  return n;
}

// ---------------- S2 Ask agent (M10 "에이전트에게 질문") ----------------

const QuestionSchema = z.string().trim().min(1, "question must not be empty").max(500);

async function nextMessageTime(ctx: ReinsContext, requestId: string): Promise<number> {
  const last = (await listRequestMessages(ctx.db, requestId)).at(-1);
  return Math.max(ctx.now(), (last?.createdAt ?? 0) + 1);
}

/**
 * Human asks the agent a question about a pending request (web inbox or Telegram). The request stays
 * pending_human; the approval timer restarts so the agent has time to answer.
 */
export async function askAgent(ctx: ReinsContext, requestId: string, rawQuestion: unknown, actor: string): Promise<RequestView> {
  const question = parseOr400(QuestionSchema, rawQuestion);
  const r = await getRequest(ctx.db, requestId);
  if (!r) throw new ReinsError(404, "not_found", "Request not found");
  if (r.status !== "pending_human") throw new ReinsError(409, "already_decided", `Request is already ${r.status}`);
  const current = latestClarification(await listRequestMessages(ctx.db, requestId));
  if (current && current.answer == null) throw new ReinsError(409, "question_open", "Still waiting for the agent to answer the last question");
  await insertRequestMessage(ctx.db, { requestId, role: "human", body: question, actor, createdAt: await nextMessageTime(ctx, requestId) });
  const touched = await updateRequest(ctx.db, requestId, {});
  const view = await publish(ctx, touched);
  await notify(ctx, "updated", view);
  return view;
}

/** Agent answers the open question through MCP get_request_status(answer). */
export async function answerClarification(ctx: ReinsContext, agent: Agent, requestId: string, rawAnswer: unknown, scope?: string): Promise<RequestView> {
  const answer = parseOr400(QuestionSchema, rawAnswer);
  const r = await getRequest(ctx.db, requestId);
  if (!r || r.agentId !== agent.id || (scope && !r.clientRequestId.startsWith(scope))) throw new ReinsError(404, "not_found", "Request not found");
  if (r.status !== "pending_human") throw new ReinsError(409, "already_decided", `Request is already ${r.status}`);
  const current = latestClarification(await listRequestMessages(ctx.db, requestId));
  if (!current || current.answer != null) throw new ReinsError(409, "no_question", "There is no open question for this request");
  const summary = await summarizeAnswer(ctx.answerSummarizer, { question: current.question, answer });
  await insertRequestMessage(ctx.db, { requestId, role: "agent", body: answer, summary: summary?.summary ?? null, actor: agent.name, createdAt: await nextMessageTime(ctx, requestId) });
  const touched = await updateRequest(ctx.db, requestId, {});
  const view = await publish(ctx, touched);
  await notify(ctx, "updated", view);
  return view;
}

/** Inbox items with the agent's month-to-date budget, for "After approval: $41 of $60 left". */
export async function getInbox(ctx: ReinsContext) {
  await expireStale(ctx);
  const rows = await getLedger(ctx, { status: ["pending_human"] });
  const since = monthStartUtc(ctx.now());
  return Promise.all(
    rows.map(async (row) => {
      const m = await getActiveMandate(ctx.db, row.agent_id);
      return {
        ...row,
        budget: {
          month_spent_cents: await spendSinceCents(ctx.db, row.agent_id, since),
          monthly_limit_cents: m?.monthlyLimitCents ?? null,
          auto_approve_limit_cents: m?.autoApproveLimitCents ?? null,
        },
        /** Active mandate summary for the S5 "Mandate v3 · Monthly · Auto · Per purchase · Allowed" strip. */
        mandate: m
          ? { version: m.version, monthly_limit_cents: m.monthlyLimitCents, auto_approve_limit_cents: m.autoApproveLimitCents, per_tx_cap_cents: m.perTxCapCents, allowed_merchants: m.allowedMerchants }
          : null,
      };
    }),
  );
}
export type InboxItem = Awaited<ReturnType<typeof getInbox>>[number];

// ---------------- reads ----------------

/** `scope` (a per-visitor demo key): the request must belong to that visitor too. */
export async function getRequestForAgent(ctx: ReinsContext, agent: Agent, requestId: string, scope?: string): Promise<RequestView> {
  const r = await getRequest(ctx.db, requestId);
  if (!r || r.agentId !== agent.id || (scope && !r.clientRequestId.startsWith(scope))) throw new ReinsError(404, "not_found", "Request not found");
  return viewOf(ctx, r);
}

export async function listTransactionsForAgent(ctx: ReinsContext, agent: Agent, limit = 20, scope?: string): Promise<RequestView[]> {
  const rows = await listRequests(ctx.db, { agentId: agent.id, scope, limit: Math.min(Math.max(limit, 1), 100) });
  return Promise.all(rows.map((r) => viewOf(ctx, r)));
}

export async function getLedger(
  ctx: ReinsContext,
  filter: { status?: RequestStatus[]; agentId?: string; limit?: number } = {},
): Promise<LedgerRow[]> {
  const rows = await listRequests(ctx.db, filter);
  const names = new Map((await listAgents(ctx.db)).map((a) => [a.id, a.name]));
  return Promise.all(
    rows.map(async (r) =>
      toLedgerRow(
        r,
        names.get(r.agentId) ?? r.agentId,
        r.mandateId ? await getMandate(ctx.db, r.mandateId) : undefined,
        await listDecisions(ctx.db, r.id),
        await getPaymentByRequest(ctx.db, r.id),
        await listRequestMessages(ctx.db, r.id),
        ctx.config.publicBaseUrl,
      ),
    ),
  );
}

export async function getLedgerRow(ctx: ReinsContext, requestId: string): Promise<LedgerRow> {
  const r = await getRequest(ctx.db, requestId);
  if (!r) throw new ReinsError(404, "not_found", "Request not found");
  const agent = await getAgent(ctx.db, r.agentId);
  return toLedgerRow(
    r,
    agent?.name ?? r.agentId,
    r.mandateId ? await getMandate(ctx.db, r.mandateId) : undefined,
    await listDecisions(ctx.db, r.id),
    await getPaymentByRequest(ctx.db, r.id),
    await listRequestMessages(ctx.db, r.id),
    ctx.config.publicBaseUrl,
  );
}

// used by webhook processing and checkout return/cancel
export { publish as publishRequest, notify as notifyChannels, executePayment, viewOf as requestViewOf };
