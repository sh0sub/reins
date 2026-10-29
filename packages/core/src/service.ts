import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
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
  spendSinceCents,
  transitionRequest,
  updateRequest,
  type Agent,
  type Mandate,
  type PurchaseRequest,
  type ReinsDb,
  type RequestStatus,
} from "@reins/db";
import { buildAuditInput, runAudit, RECENT_LIMIT, type AuditProvider } from "./policy/audit.ts";
import { evaluateHardRules, monthStartUtc, VELOCITY_WINDOW_MS } from "./policy/hardRules.ts";
import { generateApiKey, hashApiKey, parseBearer } from "./keys.ts";
import { normalizeMerchant } from "./merchant.ts";
import { toCents } from "./money.ts";
import { STRATEGIES, type PaymentMode, type StrategyResult } from "./pay/strategies.ts";
import type { PayPalClient } from "./paypal/types.ts";
import type { CategorySuggester } from "./policy/categories.ts";
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
}

export interface ReinsContext {
  db: ReinsDb;
  paypal: PayPalClient;
  auditor: AuditProvider;
  /** M3 category suggestions; keyword fallback when absent. */
  categorySuggester?: CategorySuggester;
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

export const PurchaseInputSchema = z.object({
  merchant: z.string().trim().min(1).max(253),
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
    allowed_merchants: z.array(z.string().trim().min(1).max(253)).max(100).default([]),
    blocked_merchants: z.array(z.string().trim().min(1).max(253)).max(100).default([]),
    categories: z.array(z.string().trim().min(1).max(64)).max(30).default([]),
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
  const key = parseBearer(authorization);
  if (!key) throw new ReinsError(401, "missing_key", "Missing Authorization: Bearer <agent key>");
  const agent = await findAgentByKeyHash(ctx.db, hashApiKey(key));
  if (!agent || agent.revokedAt) throw new ReinsError(401, "invalid_key", "Invalid or revoked agent key");
  return agent;
}

export function mcpSnippet(apiBaseUrl: string, apiKey: string) {
  return {
    mcpServers: {
      reins: {
        command: "npx",
        args: ["-y", "tsx", "apps/mcp/src/stdio.ts"],
        env: { REINS_API_URL: apiBaseUrl, REINS_API_KEY: apiKey },
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
    allowedMerchants: m.allowed_merchants.map(normalizeMerchant),
    blockedMerchants: m.blocked_merchants.map(normalizeMerchant),
    categories: m.categories,
    purpose: m.purpose,
    validFrom: m.valid_from,
    validUntil: m.valid_until,
  });
}

// ---------------- purchase flow (M5 -> M6 -> M7/M8) ----------------

async function viewOf(ctx: ReinsContext, r: PurchaseRequest): Promise<RequestView> {
  return toRequestView(r, await getPaymentByRequest(ctx.db, r.id), await listRequestMessages(ctx.db, r.id));
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
export async function submitPurchase(ctx: ReinsContext, agent: Agent, raw: unknown): Promise<RequestView> {
  const input = parseOr400(PurchaseInputSchema, raw);
  const now = ctx.now();
  const mandate = await getActiveMandate(ctx.db, agent.id);

  const { created, request } = await insertRequest(ctx.db, {
    agentId: agent.id,
    mandateId: mandate?.id ?? null,
    clientRequestId: input.client_request_id ?? `auto-${randomUUID()}`,
    merchant: normalizeMerchant(input.merchant),
    amountCents: input.amount,
    currency: input.currency,
    items: input.items,
    reason: input.reason,
    category: input.category ?? null,
    createdAt: now,
  });
  if (!created) return viewOf(ctx, request);
  await publish(ctx, request, "request.created");

  // ---- stage 1: hard rules ----
  const monthStart = monthStartUtc(now);
  const [monthSpent, recentCount] = await Promise.all([
    spendSinceCents(ctx.db, agent.id, monthStart),
    countRequestsSince(ctx.db, agent.id, now - VELOCITY_WINDOW_MS, request.id),
  ]);
  const hard = evaluateHardRules({
    mandate: mandate ?? null,
    agentRevoked: agent.revokedAt != null,
    request: { merchant: request.merchant, amountCents: request.amountCents, currency: request.currency },
    now,
    monthSpentCents: monthSpent,
    recentRequestCount: recentCount,
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

  const recent = (await listRequests(ctx.db, { agentId: agent.id, limit: RECENT_LIMIT + 1 }))
    .filter((r) => r.id !== request.id)
    .slice(0, RECENT_LIMIT);

  if (!hard.pass) {
    let reasonEn = `Blocked by hard rules: ${failedText}.`;
    let reasonKo = `하드 룰에서 차단: ${hard.failed.map((f) => f.rule).join(", ")}.`;
    let risk: number | null = null;
    if (ctx.config.explainDenials && mandate) {
      // Advisory only: the decision is already DENY and cannot be changed by the auditor.
      const advice = await runAudit(
        ctx.auditor,
        buildAuditInput(mandate, request, recent, monthSpent),
        request.amountCents,
        mandate.autoApproveLimitCents,
        ctx.config.auditTimeoutMs,
      );
      await insertDecision(ctx.db, {
        requestId: request.id,
        stage: "llm",
        decision: advice.final,
        risk: advice.risk,
        reasonEn: advice.reasonEn,
        reasonKo: advice.reasonKo,
        details: { provider: advice.provider, advisory: true, failed: advice.failed },
        actor: advice.provider,
      });
      if (!advice.failed) {
        reasonEn += ` ${advice.reasonEn}`;
        reasonKo += ` ${advice.reasonKo}`;
        risk = advice.risk;
      }
    }
    const denied = await updateRequest(ctx.db, request.id, { status: "denied", finalDecision: "DENY", risk, reasonEn, reasonKo });
    const view = await publish(ctx, denied);
    await notify(ctx, "resolved", view);
    return view;
  }

  // ---- stage 2: LLM audit (only reached when every hard rule passed) ----
  const m = mandate!;
  const audit = await runAudit(
    ctx.auditor,
    buildAuditInput(m, request, recent, monthSpent),
    request.amountCents,
    m.autoApproveLimitCents,
    ctx.config.auditTimeoutMs,
  );
  await insertDecision(ctx.db, {
    requestId: request.id,
    stage: "llm",
    decision: audit.final,
    risk: audit.risk,
    reasonEn: audit.reasonEn,
    reasonKo: audit.reasonKo,
    details: { provider: audit.provider, failed: audit.failed, ...(audit.error ? { error: audit.error.slice(0, 200) } : {}) },
    actor: audit.provider,
  });
  const decided = await updateRequest(ctx.db, request.id, {
    finalDecision: audit.final,
    risk: audit.risk,
    reasonEn: audit.reasonEn,
    reasonKo: audit.reasonKo,
  });

  if (audit.final === "DENY") {
    const denied = await updateRequest(ctx.db, decided.id, { status: "denied" });
    const view = await publish(ctx, denied);
    await notify(ctx, "resolved", view);
    return view;
  }
  if (audit.final === "ASK_HUMAN") {
    const pending = (await transitionRequest(ctx.db, decided.id, ["reviewing"], { status: "pending_human" }))!;
    const view = await publish(ctx, pending);
    await notify(ctx, "pendingHuman", view);
    return view;
  }
  return pay(ctx, decided, ["reviewing"]);
}

/** Moves an approved request through the workspace's payment strategy. */
async function pay(ctx: ReinsContext, r: PurchaseRequest, from: RequestStatus[]): Promise<RequestView> {
  const claimed = await transitionRequest(ctx.db, r.id, from, { status: "paying" });
  if (!claimed) return viewOf(ctx, (await getRequest(ctx.db, r.id))!);
  await publish(ctx, claimed);

  const ws = await getWorkspace(ctx.db);
  const mode = ws.paymentMode as PaymentMode;
  const result = await STRATEGIES[mode].execute(claimed, {
    paypal: ctx.paypal,
    publicBaseUrl: ctx.config.publicBaseUrl,
    vaultId: ws.vaultId,
    treasuryPayeeEmail: ctx.config.treasuryPayeeEmail,
    vaultStoredCredential: ctx.config.vaultStoredCredential,
  });
  await insertPayment(ctx.db, {
    requestId: claimed.id,
    strategy: mode,
    status: paymentStatusOf(result),
    paypalOrderId: result.orderId ?? null,
    captureId: result.captureId ?? null,
    payoutBatchId: result.payoutBatchId ?? null,
    approveUrl: result.approveUrl ?? null,
    amountCents: claimed.amountCents,
    currency: claimed.currency,
    error: result.error?.slice(0, 500) ?? null,
  });
  const next: RequestStatus =
    result.status === "completed" ? "paid" : result.status === "awaiting_buyer" ? "awaiting_buyer" : result.status === "pending" ? "paying" : "failed";
  const updated = next === "paying" ? claimed : await updateRequest(ctx.db, claimed.id, { status: next });
  const view = await publish(ctx, updated);
  if (next !== "paying") await notify(ctx, "resolved", view);
  return view;
}

function paymentStatusOf(r: StrategyResult) {
  return r.status === "completed" ? "completed" : r.status === "awaiting_buyer" ? "awaiting_buyer" : r.status === "pending" ? "pending" : "failed";
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
  return pay(ctx, approved, ["approved"]);
}

async function expireRequest(ctx: ReinsContext, r: PurchaseRequest) {
  const expired = await transitionRequest(ctx.db, r.id, ["pending_human"], { status: "expired" });
  if (!expired) return;
  await insertDecision(ctx.db, { requestId: r.id, stage: "system", decision: "EXPIRE", risk: null, reasonEn: "No decision before the approval timer ran out", reasonKo: "승인 시간 만료", details: null, actor: "timer" });
  const view = await publish(ctx, expired);
  await notify(ctx, "resolved", view);
}

/** Expires pending_human requests older than the TTL. Run on an interval (bot/web) or before listing the inbox. */
export async function expireStale(ctx: ReinsContext): Promise<number> {
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
export async function answerClarification(ctx: ReinsContext, agent: Agent, requestId: string, rawAnswer: unknown): Promise<RequestView> {
  const answer = parseOr400(QuestionSchema, rawAnswer);
  const r = await getRequest(ctx.db, requestId);
  if (!r || r.agentId !== agent.id) throw new ReinsError(404, "not_found", "Request not found");
  if (r.status !== "pending_human") throw new ReinsError(409, "already_decided", `Request is already ${r.status}`);
  const current = latestClarification(await listRequestMessages(ctx.db, requestId));
  if (!current || current.answer != null) throw new ReinsError(409, "no_question", "There is no open question for this request");
  await insertRequestMessage(ctx.db, { requestId, role: "agent", body: answer, actor: agent.name, createdAt: await nextMessageTime(ctx, requestId) });
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
      };
    }),
  );
}
export type InboxItem = Awaited<ReturnType<typeof getInbox>>[number];

// ---------------- reads ----------------

export async function getRequestForAgent(ctx: ReinsContext, agent: Agent, requestId: string): Promise<RequestView> {
  const r = await getRequest(ctx.db, requestId);
  if (!r || r.agentId !== agent.id) throw new ReinsError(404, "not_found", "Request not found");
  return viewOf(ctx, r);
}

export async function listTransactionsForAgent(ctx: ReinsContext, agent: Agent, limit = 20): Promise<RequestView[]> {
  const rows = await listRequests(ctx.db, { agentId: agent.id, limit: Math.min(Math.max(limit, 1), 100) });
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
  );
}

// used by webhook processing
export { publish as publishRequest, notify as notifyChannels };
