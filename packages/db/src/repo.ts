import { and, desc, eq, gte, inArray, lte, max, notInArray, sql, count } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { ReinsDb } from "./client.ts";
import {
  agentEvents,
  agents,
  decisions,
  mandates,
  payments,
  requestMessages,
  requests,
  webhookEvents,
  workspace,
  type Agent,
  type AgentEvent,
  type AgentEventType,
  type Decision,
  type Mandate,
  type Payment,
  type PurchaseRequest,
  type RequestMessage,
  type RequestStatus,
  type WebhookEvent,
  type Workspace,
} from "./schema.ts";

export const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;

/** Statuses whose amount counts against the monthly limit (Overview, budgets, Telegram card). */
export const COMMITTED_STATUSES: RequestStatus[] = ["approved", "awaiting_buyer", "paying", "paid"];

/**
 * C2 reserved spend, checked when a new request arrives: committed money plus everything still in flight
 * (reviewing, waiting for a person). Two requests that would only fit the cap one at a time cannot both pass stage 1.
 */
export const RESERVED_STATUSES: RequestStatus[] = ["reviewing", "pending_human", "approved", "awaiting_buyer", "paying", "paid"];

/**
 * Split-purchase rule at submit time: everything the agent may still get paid on its own. Requests waiting for a person
 * are left out, because once a person approves them they no longer count towards the rule.
 */
export const MERCHANT_RESERVED_STATUSES: RequestStatus[] = ["reviewing", "approved", "awaiting_buyer", "paying", "paid"];

/**
 * C2 claim statuses: what an approved request is checked against at the moment it is claimed for payment
 * (claimForPayment). Other requests still waiting for a person are left out, so approving one card never fails because
 * of a card nobody decided yet; every transition into these statuses goes through the same atomic check.
 */
export const CLAIM_STATUSES: RequestStatus[] = ["awaiting_buyer", "paying", "paid"];

/**
 * /try playground scope: requests raised from /try carry client_request_id "try:<visitor>:<id>". Spend windows,
 * velocity and the auditor's recent history only see rows of the same visitor, so every judge gets the scripted
 * outcomes. Clients cannot pick this prefix themselves (submitPurchase refuses it).
 */
export const PLAYGROUND_SCOPE_PREFIX = "try:";

/** "try:abc123:9f" -> "try:abc123:"; anything else -> null (not a playground-visitor row). */
export function spendScopeOf(clientRequestId: string): string | null {
  if (!clientRequestId.startsWith(PLAYGROUND_SCOPE_PREFIX)) return null;
  const end = clientRequestId.indexOf(":", PLAYGROUND_SCOPE_PREFIX.length);
  return end > PLAYGROUND_SCOPE_PREFIX.length ? clientRequestId.slice(0, end + 1) : null;
}

/** undefined = every row; null = rows outside any playground visitor; "try:x:" = that visitor's rows only. */
export type SpendScope = string | null | undefined;

function scopeCond(scope: SpendScope, col = requests.clientRequestId) {
  if (scope === undefined) return undefined;
  if (scope === null) return sql`substr(${col}, 1, ${PLAYGROUND_SCOPE_PREFIX.length}) <> ${PLAYGROUND_SCOPE_PREFIX}`;
  return sql`substr(${col}, 1, ${scope.length}) = ${scope}`;
}

/** Same merchant group as `domain` (H3): the registrable domain itself or any subdomain of it. Hostnames are [a-z0-9.-]. */
function merchantGroupCond(domain: string, col = requests.merchant) {
  return sql`(${col} = ${domain} or ${col} like ${`%.${domain}`})`;
}

// ---------- workspace ----------

export async function getWorkspace(db: ReinsDb): Promise<Workspace> {
  const row = await db.query.workspace.findFirst({ where: eq(workspace.id, 1) });
  if (row) return row;
  await db.insert(workspace).values({ id: 1 }).onConflictDoNothing();
  return (await db.query.workspace.findFirst({ where: eq(workspace.id, 1) }))!;
}

export async function updateWorkspace(db: ReinsDb, patch: Partial<Omit<Workspace, "id">>): Promise<Workspace> {
  await getWorkspace(db);
  await db.update(workspace).set(patch).where(eq(workspace.id, 1));
  return getWorkspace(db);
}

// ---------- agents ----------

export async function insertAgent(
  db: ReinsDb,
  input: { name: string; keyHash: string; keyPrefix: string },
): Promise<Agent> {
  const [row] = await db
    .insert(agents)
    .values({ id: newId("agt"), ...input, createdAt: Date.now() })
    .returning();
  return row!;
}

export async function listAgents(db: ReinsDb): Promise<Agent[]> {
  return db.select().from(agents).orderBy(agents.createdAt);
}

export async function getAgent(db: ReinsDb, id: string): Promise<Agent | undefined> {
  return db.query.agents.findFirst({ where: eq(agents.id, id) });
}

export async function findAgentByKeyHash(db: ReinsDb, keyHash: string): Promise<Agent | undefined> {
  return db.query.agents.findFirst({ where: eq(agents.keyHash, keyHash) });
}

export async function revokeAgent(db: ReinsDb, id: string): Promise<void> {
  await db.update(agents).set({ revokedAt: Date.now() }).where(eq(agents.id, id));
}

/** Sets or clears the pause flag. Returns the updated agent (undefined when it does not exist). */
export async function setAgentPaused(db: ReinsDb, id: string, pausedAt: number | null): Promise<Agent | undefined> {
  const [row] = await db.update(agents).set({ pausedAt }).where(eq(agents.id, id)).returning();
  return row;
}

/** Replaces the key hash (old key stops working immediately). Refuses revoked agents. */
export async function replaceAgentKey(db: ReinsDb, id: string, input: { keyHash: string; keyPrefix: string; at: number }): Promise<Agent | undefined> {
  const [row] = await db
    .update(agents)
    .set({ keyHash: input.keyHash, keyPrefix: input.keyPrefix, keyRotatedAt: input.at })
    .where(and(eq(agents.id, id), sql`${agents.revokedAt} is null`))
    .returning();
  return row;
}

export async function insertAgentEvent(
  db: ReinsDb,
  input: { agentId: string; type: AgentEventType; actor: string; detail?: string | null; createdAt?: number },
): Promise<AgentEvent> {
  const [row] = await db
    .insert(agentEvents)
    .values({ id: newId("aev"), detail: null, createdAt: Date.now(), ...input })
    .returning();
  return row!;
}

export async function listAgentEvents(db: ReinsDb, agentId: string, limit = 50): Promise<AgentEvent[]> {
  return db.select().from(agentEvents).where(eq(agentEvents.agentId, agentId)).orderBy(desc(agentEvents.createdAt), desc(agentEvents.id)).limit(limit);
}

// ---------- mandates ----------

export type MandateInput = Omit<Mandate, "id" | "agentId" | "version" | "createdAt" | "currency" | "merchantAutoLimits"> & {
  currency?: string;
  merchantAutoLimits?: Record<string, number>;
};

/** Inserts a new mandate version (max+1). Old versions stay for audit snapshots. */
export async function createMandateVersion(db: ReinsDb, agentId: string, input: MandateInput): Promise<Mandate> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const [cur] = await db
      .select({ v: max(mandates.version) })
      .from(mandates)
      .where(eq(mandates.agentId, agentId));
    const version = (cur?.v ?? 0) + 1;
    try {
      const [row] = await db
        .insert(mandates)
        .values({ id: newId("mdt"), agentId, version, ...input, createdAt: Date.now() })
        .returning();
      return row!;
    } catch (err) {
      if (attempt === 2 || !String(err).includes("UNIQUE")) throw err;
    }
  }
  throw new Error("unreachable");
}

export async function getActiveMandate(db: ReinsDb, agentId: string): Promise<Mandate | undefined> {
  return db.query.mandates.findFirst({
    where: eq(mandates.agentId, agentId),
    orderBy: desc(mandates.version),
  });
}

export async function getMandate(db: ReinsDb, id: string): Promise<Mandate | undefined> {
  return db.query.mandates.findFirst({ where: eq(mandates.id, id) });
}

export async function listMandateVersions(db: ReinsDb, agentId: string): Promise<Mandate[]> {
  return db.select().from(mandates).where(eq(mandates.agentId, agentId)).orderBy(desc(mandates.version));
}

// ---------- requests ----------

export type NewRequestInput = Pick<
  PurchaseRequest,
  "agentId" | "mandateId" | "clientRequestId" | "merchant" | "amountCents" | "currency" | "items" | "reason" | "category"
> & { createdAt?: number; /** Fixed display number (the demo seed starts at R-0120); default is max + 1. */ seq?: number };

export async function findRequestByClientId(
  db: ReinsDb,
  agentId: string,
  clientRequestId: string,
): Promise<PurchaseRequest | undefined> {
  return db.query.requests.findFirst({
    where: and(eq(requests.agentId, agentId), eq(requests.clientRequestId, clientRequestId)),
  });
}

/** Inserts a request; returns { created: false } with the existing row on an idempotency-key collision. */
export async function insertRequest(
  db: ReinsDb,
  input: NewRequestInput,
): Promise<{ created: boolean; request: PurchaseRequest }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    // next display number computed inside the INSERT, so concurrent submits do not race for the same seq
    const seq = input.seq ?? sql<number>`(select coalesce(max(${requests.seq}), 0) + 1 from ${requests})`;
    const ts = input.createdAt ?? Date.now();
    try {
      const [row] = await db
        .insert(requests)
        .values({ id: newId("req"), seq, status: "reviewing", ...input, createdAt: ts, updatedAt: ts })
        .returning();
      return { created: true, request: row! };
    } catch (err) {
      const msg = String((err as { cause?: unknown }).cause ?? err);
      if (msg.includes("requests.agent_id, requests.client_request_id") || msg.includes("requests_idempotency")) {
        const existing = await findRequestByClientId(db, input.agentId, input.clientRequestId);
        if (existing) return { created: false, request: existing };
      }
      if (!msg.includes("UNIQUE") || attempt === 4) throw err;
    }
  }
  throw new Error("unreachable");
}

export async function getRequest(db: ReinsDb, id: string): Promise<PurchaseRequest | undefined> {
  return db.query.requests.findFirst({ where: eq(requests.id, id) });
}

/** Lookup by the display number (R-0143 -> 143). */
export async function getRequestBySeq(db: ReinsDb, seq: number): Promise<PurchaseRequest | undefined> {
  return db.query.requests.findFirst({ where: eq(requests.seq, seq) });
}

export async function updateRequest(
  db: ReinsDb,
  id: string,
  patch: Partial<Omit<PurchaseRequest, "id" | "seq">>,
): Promise<PurchaseRequest> {
  const [row] = await db
    .update(requests)
    .set({ ...patch, updatedAt: Date.now() })
    .where(eq(requests.id, id))
    .returning();
  return row!;
}

/**
 * Atomic compare-and-set on status. Returns the updated row, or undefined if the request was not in
 * one of `from` (e.g. Telegram and the web inbox racing to approve the same card).
 */
export async function transitionRequest(
  db: ReinsDb,
  id: string,
  from: RequestStatus[],
  patch: Partial<Omit<PurchaseRequest, "id" | "seq">> & { status: RequestStatus },
): Promise<PurchaseRequest | undefined> {
  const [row] = await db
    .update(requests)
    .set({ ...patch, updatedAt: Date.now() })
    .where(and(eq(requests.id, id), inArray(requests.status, from)))
    .returning();
  return row;
}

export interface PaymentClaimGuard {
  agentId: string;
  amountCents: number;
  monthStart: number;
  monthlyLimitCents: number;
  scope: SpendScope;
  /** Split-purchase guard (agent-paid orders only): registrable domain, window start and the per-purchase cap. */
  merchant?: { domain: string; since: number; capCents: number };
}

/**
 * C2 atomic claim for payment: moves the request from `from` to `paying` only if, at that instant, the agent's
 * CLAIM_STATUSES spend this month plus this amount still fits the monthly limit (and, when `merchant` is given, the
 * agent-paid spend at that merchant group still fits the per-purchase cap). One UPDATE statement, so SQLite serialises
 * concurrent claims and two approvals can never overspend the cap together. Undefined = not claimed (status changed or
 * the budget no longer fits; re-read the row to tell which).
 */
export async function claimForPayment(db: ReinsDb, id: string, from: RequestStatus[], g: PaymentClaimGuard): Promise<PurchaseRequest | undefined> {
  const other = sql.raw("r2");
  const statuses = sql.join(CLAIM_STATUSES.map((s) => sql`${s}`), sql`, `);
  const scope =
    g.scope === undefined
      ? sql``
      : g.scope === null
        ? sql` and substr(${other}.client_request_id, 1, ${PLAYGROUND_SCOPE_PREFIX.length}) <> ${PLAYGROUND_SCOPE_PREFIX}`
        : sql` and substr(${other}.client_request_id, 1, ${g.scope.length}) = ${g.scope}`;
  const monthly = sql`(select coalesce(sum(${other}.amount_cents), 0) from requests ${other} where ${other}.agent_id = ${g.agentId} and ${other}.created_at >= ${g.monthStart} and ${other}.status in (${statuses}) and ${other}.id <> ${id}${scope}) + ${g.amountCents} <= ${g.monthlyLimitCents}`;
  const conds = [eq(requests.id, id), inArray(requests.status, from), monthly];
  if (g.merchant) {
    const m = g.merchant;
    const prior = sql`(select coalesce(sum(${other}.amount_cents), 0) from requests ${other} where ${other}.agent_id = ${g.agentId} and ${other}.created_at >= ${m.since} and ${other}.status in (${statuses}) and ${other}.id <> ${id}${scope} and (${other}.merchant = ${m.domain} or ${other}.merchant like ${`%.${m.domain}`}) and not exists (select 1 from decisions d where d.request_id = ${other}.id and d.stage = 'human' and d.decision = 'APPROVE'))`;
    conds.push(sql`(${prior} = 0 or ${prior} + ${g.amountCents} <= ${m.capCents})`);
  }
  const [row] = await db
    .update(requests)
    .set({ status: "paying", updatedAt: Date.now() })
    .where(and(...conds))
    .returning();
  return row;
}

export async function listRequests(
  db: ReinsDb,
  filter: { agentId?: string; status?: RequestStatus[]; limit?: number; scope?: SpendScope } = {},
): Promise<PurchaseRequest[]> {
  const conds = [];
  if (filter.agentId) conds.push(eq(requests.agentId, filter.agentId));
  const sc = scopeCond(filter.scope);
  if (sc) conds.push(sc);
  if (filter.status?.length) conds.push(inArray(requests.status, filter.status));
  return db
    .select()
    .from(requests)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(requests.createdAt), desc(requests.seq))
    .limit(filter.limit ?? 100);
}

/** Clears S3 unusual-pattern flags without touching status or timestamps ("Mark as expected"). */
export async function clearRequestAnomalies(db: ReinsDb, ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  const rows = await db.update(requests).set({ anomalies: [] }).where(inArray(requests.id, ids)).returning({ id: requests.id });
  return rows.length;
}

/** Requests created at or after `since`, excluding `excludeId` (velocity rule). */
export async function countRequestsSince(
  db: ReinsDb,
  agentId: string,
  since: number,
  excludeId?: string,
  opts: { scope?: SpendScope } = {},
): Promise<number> {
  const conds = [eq(requests.agentId, agentId), gte(requests.createdAt, since)];
  if (excludeId) conds.push(sql`${requests.id} <> ${excludeId}`);
  const sc = scopeCond(opts.scope);
  if (sc) conds.push(sc);
  const [row] = await db
    .select({ n: count() })
    .from(requests)
    .where(and(...conds));
  return row?.n ?? 0;
}

/** Sum of committed spend since `since` (Overview and budget displays). */
export async function spendSinceCents(db: ReinsDb, agentId: string, since: number): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${requests.amountCents}), 0)` })
    .from(requests)
    .where(
      and(eq(requests.agentId, agentId), gte(requests.createdAt, since), inArray(requests.status, COMMITTED_STATUSES)),
    );
  return Number(row?.total ?? 0);
}

/** C2 monthly-limit input: spend in `statuses` (default RESERVED_STATUSES) since `since`, excluding `excludeId`, inside `scope`. */
export async function reservedSpendSinceCents(
  db: ReinsDb,
  agentId: string,
  since: number,
  opts: { excludeId?: string; scope?: SpendScope; statuses?: RequestStatus[] } = {},
): Promise<number> {
  const conds = [eq(requests.agentId, agentId), gte(requests.createdAt, since), inArray(requests.status, opts.statuses ?? RESERVED_STATUSES)];
  if (opts.excludeId) conds.push(sql`${requests.id} <> ${opts.excludeId}`);
  const sc = scopeCond(opts.scope);
  if (sc) conds.push(sc);
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${requests.amountCents}), 0)` })
    .from(requests)
    .where(and(...conds));
  return Number(row?.total ?? 0);
}

/**
 * Spend by one agent at one merchant group since `since` (split-purchase rule). `domain` is the registrable domain
 * (H3: shop.vercel.com and api.vercel.com add up under vercel.com). Orders a person approved by hand are not counted:
 * the rule is about what the agent got paid on its own. Excludes `excludeId`. `statuses` defaults to committed.
 */
export async function spendAtMerchantSinceCents(
  db: ReinsDb,
  agentId: string,
  domain: string,
  since: number,
  excludeId?: string,
  opts: { scope?: SpendScope; statuses?: RequestStatus[] } = {},
): Promise<number> {
  const conds = [eq(requests.agentId, agentId), gte(requests.createdAt, since), inArray(requests.status, opts.statuses ?? COMMITTED_STATUSES), merchantGroupCond(domain),
    sql`not exists (select 1 from ${decisions} where ${decisions.requestId} = ${requests.id} and ${decisions.stage} = 'human' and ${decisions.decision} = 'APPROVE')`];
  if (excludeId) conds.push(sql`${requests.id} <> ${excludeId}`);
  const sc = scopeCond(opts.scope);
  if (sc) conds.push(sc);
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${requests.amountCents}), 0)` })
    .from(requests)
    .where(and(...conds));
  return Number(row?.total ?? 0);
}

/** Every request created at or after `since`, newest first (overview dashboard: month-to-date, no row limit). */
export async function listRequestsSince(db: ReinsDb, since: number): Promise<PurchaseRequest[]> {
  return db
    .select()
    .from(requests)
    .where(gte(requests.createdAt, since))
    .orderBy(desc(requests.createdAt), desc(requests.seq));
}

// ---------- decisions ----------

/** Decisions for many requests in one query, oldest first. */
export async function listDecisionsFor(db: ReinsDb, requestIds: string[]): Promise<Decision[]> {
  if (!requestIds.length) return [];
  return db.select().from(decisions).where(inArray(decisions.requestId, requestIds)).orderBy(decisions.createdAt);
}

export async function insertDecision(
  db: ReinsDb,
  input: Omit<Decision, "id" | "createdAt"> & { createdAt?: number },
): Promise<Decision> {
  const [row] = await db
    .insert(decisions)
    .values({ id: newId("dec"), createdAt: Date.now(), ...input })
    .returning();
  return row!;
}

export async function listDecisions(db: ReinsDb, requestId: string): Promise<Decision[]> {
  return db.select().from(decisions).where(eq(decisions.requestId, requestId)).orderBy(decisions.createdAt);
}

// ---------- payments ----------

export async function insertPayment(
  db: ReinsDb,
  input: Omit<Payment, "id" | "createdAt" | "updatedAt" | "reconciled" | "reconciledAt" | "reconcileNote"> & { reconciled?: Payment["reconciled"] },
): Promise<Payment> {
  const ts = Date.now();
  const [row] = await db
    .insert(payments)
    .values({ id: newId("pay"), createdAt: ts, updatedAt: ts, ...input })
    .returning();
  return row!;
}

export async function updatePayment(
  db: ReinsDb,
  id: string,
  patch: Partial<Omit<Payment, "id" | "requestId">>,
): Promise<Payment> {
  const [row] = await db
    .update(payments)
    .set({ ...patch, updatedAt: Date.now() })
    .where(eq(payments.id, id))
    .returning();
  return row!;
}

export async function getPaymentByRequest(db: ReinsDb, requestId: string): Promise<Payment | undefined> {
  return db.query.payments.findFirst({ where: eq(payments.requestId, requestId) });
}

export async function getPaymentByOrderId(db: ReinsDb, orderId: string): Promise<Payment | undefined> {
  return db.query.payments.findFirst({ where: eq(payments.paypalOrderId, orderId) });
}

export async function getPaymentByBatchId(db: ReinsDb, batchId: string): Promise<Payment | undefined> {
  return db.query.payments.findFirst({ where: eq(payments.payoutBatchId, batchId) });
}

/** Payments with a PayPal transaction id created in [from, to] — candidates for Transaction Search. */
export async function listPaymentsForReconcile(db: ReinsDb, from: number, to: number): Promise<Payment[]> {
  return db
    .select()
    .from(payments)
    .where(and(eq(payments.status, "completed"), gte(payments.createdAt, from), lte(payments.createdAt, to)))
    .orderBy(payments.createdAt);
}

// ---------- request messages (S2 Ask agent) ----------

export async function insertRequestMessage(
  db: ReinsDb,
  input: { requestId: string; role: RequestMessage["role"]; body: string; summary?: string | null; actor?: string | null; createdAt?: number },
): Promise<RequestMessage> {
  const [row] = await db
    .insert(requestMessages)
    .values({ id: newId("msg"), actor: null, createdAt: Date.now(), ...input })
    .returning();
  return row!;
}

export async function listRequestMessages(db: ReinsDb, requestId: string): Promise<RequestMessage[]> {
  return db
    .select()
    .from(requestMessages)
    .where(eq(requestMessages.requestId, requestId))
    .orderBy(requestMessages.createdAt, requestMessages.id);
}

// ---------- webhook events ----------

/**
 * Records a webhook event id. "new" = first delivery; "duplicate" = already processed (skip);
 * "retry" = seen before but processing never finished (process again).
 */
export async function recordWebhookEvent(
  db: ReinsDb,
  input: { id: string; eventType: string; resourceId?: string | null },
): Promise<"new" | "duplicate" | "retry"> {
  const inserted = await db
    .insert(webhookEvents)
    .values({ id: input.id, eventType: input.eventType, resourceId: input.resourceId ?? null, receivedAt: Date.now() })
    .onConflictDoNothing()
    .returning({ id: webhookEvents.id });
  if (inserted.length) return "new";
  const existing = await db.query.webhookEvents.findFirst({ where: eq(webhookEvents.id, input.id) });
  return existing?.processedAt ? "duplicate" : "retry";
}

export async function markWebhookProcessed(db: ReinsDb, id: string, outcome: string): Promise<void> {
  await db.update(webhookEvents).set({ processedAt: Date.now(), outcome }).where(eq(webhookEvents.id, id));
}

/** Webhook deliveries about any of these PayPal resource ids (order, capture or payout batch), oldest first. */
export async function listWebhookEventsFor(db: ReinsDb, resourceIds: string[]): Promise<WebhookEvent[]> {
  const ids = resourceIds.filter(Boolean);
  if (!ids.length) return [];
  return db.select().from(webhookEvents).where(inArray(webhookEvents.resourceId, ids)).orderBy(webhookEvents.receivedAt);
}

export async function countWebhookEvents(db: ReinsDb): Promise<number> {
  const [row] = await db.select({ n: count() }).from(webhookEvents);
  return row?.n ?? 0;
}

// ---------- seed support (scripts/seed.ts) ----------

/** Deletes agents and everything hanging off them (messages, decisions, payments, requests, mandates). */
export async function purgeAgents(db: ReinsDb, agentIds: string[]): Promise<void> {
  if (!agentIds.length) return;
  const reqIds = db.select({ id: requests.id }).from(requests).where(inArray(requests.agentId, agentIds));
  await db.delete(requestMessages).where(inArray(requestMessages.requestId, reqIds));
  await db.delete(decisions).where(inArray(decisions.requestId, reqIds));
  await db.delete(payments).where(inArray(payments.requestId, reqIds));
  await db.delete(requests).where(inArray(requests.agentId, agentIds));
  await db.delete(mandates).where(inArray(mandates.agentId, agentIds));
  await db.delete(agentEvents).where(inArray(agentEvents.agentId, agentIds));
  await db.delete(agents).where(inArray(agents.id, agentIds));
}

/** Requests whose agent is not in `agentIds` (detects non-seed data before a wipe). */
export async function countRequestsOutside(db: ReinsDb, agentIds: string[]): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(requests)
    .where(agentIds.length ? notInArray(requests.agentId, agentIds) : undefined);
  return row?.n ?? 0;
}

/** Repo updates stamp updatedAt with Date.now(); this restores a believable timeline for seeded history. */
export async function setTimestamps(db: ReinsDb, target: { request?: string; payment?: string; agent?: string }, ts: number): Promise<void> {
  if (target.agent) await db.update(agents).set({ createdAt: ts }).where(eq(agents.id, target.agent));
  if (target.request) await db.update(requests).set({ updatedAt: ts }).where(eq(requests.id, target.request));
  if (target.payment) await db.update(payments).set({ createdAt: ts, updatedAt: ts }).where(eq(payments.id, target.payment));
}
