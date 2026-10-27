import { and, desc, eq, gte, inArray, max, sql, count } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { ReinsDb } from "./client.ts";
import {
  agents,
  decisions,
  mandates,
  payments,
  requests,
  webhookEvents,
  workspace,
  type Agent,
  type Decision,
  type Mandate,
  type Payment,
  type PurchaseRequest,
  type RequestStatus,
  type Workspace,
} from "./schema.ts";

export const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;

/** Statuses whose amount counts against the monthly limit. */
export const COMMITTED_STATUSES: RequestStatus[] = ["approved", "awaiting_buyer", "paying", "paid"];

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

// ---------- mandates ----------

export type MandateInput = Omit<Mandate, "id" | "agentId" | "version" | "createdAt" | "currency"> & {
  currency?: string;
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
> & { createdAt?: number };

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
    const [cur] = await db.select({ s: max(requests.seq) }).from(requests);
    const seq = (cur?.s ?? 0) + 1;
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

export async function listRequests(
  db: ReinsDb,
  filter: { agentId?: string; status?: RequestStatus[]; limit?: number } = {},
): Promise<PurchaseRequest[]> {
  const conds = [];
  if (filter.agentId) conds.push(eq(requests.agentId, filter.agentId));
  if (filter.status?.length) conds.push(inArray(requests.status, filter.status));
  return db
    .select()
    .from(requests)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(requests.createdAt), desc(requests.seq))
    .limit(filter.limit ?? 100);
}

/** Requests created at or after `since`, excluding `excludeId` (velocity rule). */
export async function countRequestsSince(
  db: ReinsDb,
  agentId: string,
  since: number,
  excludeId?: string,
): Promise<number> {
  const conds = [eq(requests.agentId, agentId), gte(requests.createdAt, since)];
  if (excludeId) conds.push(sql`${requests.id} <> ${excludeId}`);
  const [row] = await db
    .select({ n: count() })
    .from(requests)
    .where(and(...conds));
  return row?.n ?? 0;
}

/** Sum of committed spend since `since` (monthly-limit rule). */
export async function spendSinceCents(db: ReinsDb, agentId: string, since: number): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${requests.amountCents}), 0)` })
    .from(requests)
    .where(
      and(eq(requests.agentId, agentId), gte(requests.createdAt, since), inArray(requests.status, COMMITTED_STATUSES)),
    );
  return Number(row?.total ?? 0);
}

// ---------- decisions ----------

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
  input: Omit<Payment, "id" | "createdAt" | "updatedAt" | "reconciled"> & { reconciled?: Payment["reconciled"] },
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

export async function countWebhookEvents(db: ReinsDb): Promise<number> {
  const [row] = await db.select({ n: count() }).from(webhookEvents);
  return row?.n ?? 0;
}
