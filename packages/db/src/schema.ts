import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, uniqueIndex, index } from "drizzle-orm/sqlite-core";

/**
 * Local schema (SQLite via libsql). Money is stored as integer cents, timestamps as epoch ms.
 * Postgres on Render (D11 #38) will mirror these tables.
 */

const now = sql`(unixepoch() * 1000)`;

/** Single-row workspace: PayPal connection + Telegram link state (M1, M8, M9). No secrets here. */
export const workspace = sqliteTable("workspace", {
  id: integer("id").primaryKey(),
  name: text("name").notNull().default("My workspace"),
  paypalEnv: text("paypal_env").notNull().default("fake"),
  merchantEmail: text("merchant_email"),
  paymentMode: text("payment_mode", { enum: ["vaulted", "supervised", "treasury"] })
    .notNull()
    .default("supervised"),
  /** Buyer vault token from the $0.01 store_in_vault order. Never sent to the LLM. */
  vaultId: text("vault_id"),
  telegramChatId: text("telegram_chat_id"),
  telegramLinkToken: text("telegram_link_token"),
  connectedAt: integer("connected_at"),
});

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** sha256 hex of the full API key. The key itself is shown once and never stored. */
  keyHash: text("key_hash").notNull().unique(),
  /** First characters of the key for display, e.g. "rk_live_7Hq2". */
  keyPrefix: text("key_prefix").notNull(),
  createdAt: integer("created_at").notNull().default(now),
  revokedAt: integer("revoked_at"),
});

/** Versioned mandates: every save inserts a new row with version+1; the highest version is active. */
export const mandates = sqliteTable(
  "mandates",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    version: integer("version").notNull(),
    monthlyLimitCents: integer("monthly_limit_cents").notNull(),
    autoApproveLimitCents: integer("auto_approve_limit_cents").notNull(),
    perTxCapCents: integer("per_tx_cap_cents"),
    currency: text("currency").notNull().default("USD"),
    allowedMerchants: text("allowed_merchants", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
    blockedMerchants: text("blocked_merchants", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
    categories: text("categories", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
    purpose: text("purpose").notNull(),
    validFrom: integer("valid_from"),
    validUntil: integer("valid_until"),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [uniqueIndex("mandates_agent_version").on(t.agentId, t.version)],
);

export const REQUEST_STATUSES = [
  "reviewing",
  "denied",
  "pending_human",
  "approved",
  "awaiting_buyer",
  "paying",
  "paid",
  "failed",
  "expired",
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const requests = sqliteTable(
  "requests",
  {
    id: text("id").primaryKey(),
    /** Monotonic number shown as R-0142. */
    seq: integer("seq").notNull().unique(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    mandateId: text("mandate_id").references(() => mandates.id),
    clientRequestId: text("client_request_id").notNull(),
    merchant: text("merchant").notNull(),
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull().default("USD"),
    items: text("items").notNull(),
    reason: text("reason").notNull(),
    category: text("category"),
    status: text("status", { enum: REQUEST_STATUSES }).notNull().default("reviewing"),
    finalDecision: text("final_decision", { enum: ["AUTO_APPROVE", "ASK_HUMAN", "DENY"] }),
    risk: integer("risk"),
    reasonEn: text("reason_en"),
    reasonKo: text("reason_ko"),
    createdAt: integer("created_at").notNull().default(now),
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("requests_idempotency").on(t.agentId, t.clientRequestId),
    index("requests_agent_created").on(t.agentId, t.createdAt),
    index("requests_status").on(t.status),
  ],
);

export const decisions = sqliteTable(
  "decisions",
  {
    id: text("id").primaryKey(),
    requestId: text("request_id")
      .notNull()
      .references(() => requests.id),
    stage: text("stage", { enum: ["hard_rules", "llm", "human", "system"] }).notNull(),
    decision: text("decision", { enum: ["PASS", "AUTO_APPROVE", "ASK_HUMAN", "DENY", "APPROVE", "EXPIRE"] }).notNull(),
    risk: integer("risk"),
    reasonEn: text("reason_en"),
    reasonKo: text("reason_ko"),
    /** Hard-rule results or auditor metadata (model id, advisory flag). */
    details: text("details", { mode: "json" }).$type<Record<string, unknown>>(),
    actor: text("actor"),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [index("decisions_request").on(t.requestId)],
);

export const payments = sqliteTable(
  "payments",
  {
    id: text("id").primaryKey(),
    requestId: text("request_id")
      .notNull()
      .references(() => requests.id)
      .unique(),
    strategy: text("strategy", { enum: ["vaulted", "supervised", "treasury"] }).notNull(),
    status: text("status", { enum: ["created", "awaiting_buyer", "completed", "pending", "failed"] }).notNull(),
    paypalOrderId: text("paypal_order_id"),
    captureId: text("capture_id"),
    payoutBatchId: text("payout_batch_id"),
    approveUrl: text("approve_url"),
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull().default("USD"),
    error: text("error"),
    reconciled: text("reconciled", { enum: ["unchecked", "matched", "mismatch"] }).notNull().default("unchecked"),
    /** Last Transaction Search reconciliation (M11 nightly cron). */
    reconciledAt: integer("reconciled_at"),
    /** Short note from reconciliation, e.g. "amount 59.00 != 58.00" or the PayPal transaction status. */
    reconcileNote: text("reconcile_note"),
    createdAt: integer("created_at").notNull().default(now),
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (t) => [index("payments_order").on(t.paypalOrderId), index("payments_batch").on(t.payoutBatchId)],
);

/**
 * S2 "Ask agent" thread on a pending request: the human asks (role human), the agent answers through MCP
 * get_request_status(answer) (role agent). The request stays pending_human while a question is open.
 */
export const requestMessages = sqliteTable(
  "request_messages",
  {
    id: text("id").primaryKey(),
    requestId: text("request_id")
      .notNull()
      .references(() => requests.id),
    role: text("role", { enum: ["human", "agent"] }).notNull(),
    body: text("body").notNull(),
    actor: text("actor"),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [index("request_messages_request").on(t.requestId, t.createdAt)],
);

export const webhookEvents = sqliteTable("webhook_events", {
  /** PayPal event id (WH-...). Primary key = idempotency guard. */
  id: text("id").primaryKey(),
  eventType: text("event_type").notNull(),
  resourceId: text("resource_id"),
  receivedAt: integer("received_at").notNull().default(now),
  processedAt: integer("processed_at"),
  outcome: text("outcome"),
});

export type Workspace = typeof workspace.$inferSelect;
export type Agent = typeof agents.$inferSelect;
export type Mandate = typeof mandates.$inferSelect;
export type NewMandate = typeof mandates.$inferInsert;
export type PurchaseRequest = typeof requests.$inferSelect;
export type Decision = typeof decisions.$inferSelect;
export type Payment = typeof payments.$inferSelect;
export type WebhookEvent = typeof webhookEvents.$inferSelect;
export type RequestMessage = typeof requestMessages.$inferSelect;
