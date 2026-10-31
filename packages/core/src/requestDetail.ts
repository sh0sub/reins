import { getAgent, getMandate, getPaymentByRequest, getRequest, getWorkspace, listDecisions, listRequestMessages, listWebhookEventsFor } from "@reins/db";
import type { HardRuleResult } from "./policy/hardRules.ts";
import { agentStatus, type AgentStatus } from "./agentControl.ts";
import { centsToValue } from "./money.ts";
import { ReinsError, getLedgerRow, type ReinsContext } from "./service.ts";
import { mandateView, type LedgerRow } from "./views.ts";

/** S6 request-detail drawer: why a decision happened, step by step. */

export type TimelineTone = "ok" | "bad" | "info" | "wait";
export interface TimelineStep {
  key: string;
  label: string;
  detail: string | null;
  /** Epoch ms (shown with milliseconds). */
  at_ms: number;
  at: string;
  tone: TimelineTone;
}

export interface HardRuleRow {
  rule: string;
  label: string;
  value: string | null;
  limit: string | null;
  ok: boolean;
  detail: string;
}

export const HARD_RULE_LABELS: Record<string, string> = {
  agent_active: "Agent key",
  agent_paused: "Agent status",
  mandate_present: "Mandate",
  mandate_window: "Valid dates",
  amount_valid: "Amount",
  currency: "Currency",
  per_tx_cap: "Per-purchase cap",
  monthly_limit: "Monthly cap",
  blocked_merchant: "Block list",
  allowlist: "Merchant allowlist",
  velocity: "Velocity",
};

export interface RequestDetail {
  row: LedgerRow;
  agent: { id: string; name: string; status: AgentStatus };
  timeline: TimelineStep[];
  hard_rules: HardRuleRow[];
  auditor: { provider: string | null; advisory: boolean; risk: number | null; reason_en: string | null; reason_ko: string | null; skipped: string | null } | null;
  mandate: ReturnType<typeof mandateView> | null;
  /** The request_purchase call as the agent sent it. The agent key is never stored, so nothing to leak; marked redacted. */
  raw_request: Record<string, unknown>;
  telegram_linked: boolean;
}

const usdOf = (cents: number) => `$${centsToValue(cents)}`;

export async function getRequestDetail(ctx: ReinsContext, requestId: string): Promise<RequestDetail> {
  const r = await getRequest(ctx.db, requestId);
  if (!r) throw new ReinsError(404, "not_found", "Request not found");
  const [row, agent, decisions, payment, messages, ws, mandate] = await Promise.all([
    getLedgerRow(ctx, requestId),
    getAgent(ctx.db, r.agentId),
    listDecisions(ctx.db, requestId),
    getPaymentByRequest(ctx.db, requestId),
    listRequestMessages(ctx.db, requestId),
    getWorkspace(ctx.db),
    r.mandateId ? getMandate(ctx.db, r.mandateId) : Promise.resolve(undefined),
  ]);
  const webhooks = payment ? await listWebhookEventsFor(ctx.db, [payment.paypalOrderId, payment.captureId, payment.payoutBatchId].filter((x): x is string => Boolean(x))) : [];
  const telegram = Boolean(ws.telegramChatId);

  const steps: TimelineStep[] = [];
  const add = (key: string, label: string, at: number, tone: TimelineTone, detail: string | null = null) =>
    steps.push({ key, label, detail, at_ms: at, at: new Date(at).toISOString(), tone });

  add("received", "Request received via MCP", r.createdAt, "info", `request_purchase · ${r.merchant} · ${usdOf(r.amountCents)}`);
  const hardDec = decisions.find((d) => d.stage === "hard_rules");
  const results = ((hardDec?.details as { results?: HardRuleResult[] } | null)?.results ?? []) as HardRuleResult[];
  const failed = results.filter((x) => !x.ok);
  if (hardDec) {
    add("hard_rules", failed.length ? `Hard rules · ${failed.length} failed` : `Hard rules · ${results.length} of ${results.length} passed`, hardDec.createdAt, failed.length ? "bad" : "ok", failed.map((f) => f.detail).join("; ") || null);
  }
  const paused = failed.some((f) => f.rule === "agent_paused");
  let auditor: RequestDetail["auditor"] = null;
  for (const d of decisions) {
    if (d.stage === "llm") {
      const det = (d.details ?? {}) as { provider?: string; advisory?: boolean; failed?: boolean };
      const who = det.provider === "mock" ? "mock auditor" : det.provider ?? d.actor ?? "auditor";
      add(`llm-${d.createdAt}`, `LLM audit · ${who}${det.advisory ? " (explains only)" : ""}`, d.createdAt, d.decision === "DENY" ? "bad" : d.decision === "ASK_HUMAN" ? "wait" : "ok", `${d.decision} · risk ${d.risk ?? "?"}/10`);
      auditor = { provider: det.provider ?? d.actor, advisory: Boolean(det.advisory), risk: d.risk, reason_en: d.reasonEn, reason_ko: d.reasonKo, skipped: null };
    } else if (d.stage === "system" && d.decision !== "EXPIRE") {
      add(`patterns-${d.createdAt}`, "Unusual pattern check", d.createdAt, "wait", d.reasonEn);
    } else if (d.stage === "system") {
      add("expired", "Expired · no decision in time", d.createdAt, "bad", d.reasonEn);
    } else if (d.stage === "human") {
      add(`human-${d.createdAt}`, d.decision === "APPROVE" ? `Approved by ${d.actor ?? "you"}` : `Denied by ${d.actor ?? "you"}`, d.createdAt, d.decision === "APPROVE" ? "ok" : "bad", d.reasonEn);
    }
  }
  if (!auditor && hardDec && failed.length) auditor = { provider: null, advisory: false, risk: null, reason_en: null, reason_ko: null, skipped: paused ? "Agent paused: the auditor was not called." : "Hard rules blocked the request first." };

  // Telegram gets a card for every ASK_HUMAN and a warning for every block; only shown when a chat is linked.
  if (telegram) {
    const llmAsk = decisions.find((d) => d.stage === "llm" && d.decision === "ASK_HUMAN");
    const sys = decisions.find((d) => d.stage === "system" && d.decision === "ASK_HUMAN");
    const askAt = (sys ?? llmAsk)?.createdAt;
    if (askAt != null && (r.status === "pending_human" || decisions.some((d) => d.stage === "human") || r.status === "expired")) add("telegram", "Sent to Telegram", askAt, "info", "Approval card");
    else if (r.status === "denied" && !decisions.some((d) => d.stage === "human")) add("telegram", "Telegram notified", r.updatedAt, "info", "Blocked warning, no approve button");
  }
  for (const m of messages) add(`msg-${m.createdAt}`, m.role === "human" ? `You asked (${m.actor ?? "web"})` : `${agent?.name ?? "Agent"} answered`, m.createdAt, "info", m.body.length > 120 ? `${m.body.slice(0, 119)}…` : m.body);

  if (payment) {
    add("paypal-order", payment.payoutBatchId ? "PayPal payout created" : "PayPal order created", payment.createdAt, "info", payment.paypalOrderId ?? payment.payoutBatchId ?? null);
    if (payment.status === "completed") add("paypal-capture", payment.payoutBatchId ? "PayPal payout sent" : "PayPal capture", payment.updatedAt, "ok", payment.captureId ?? payment.payoutBatchId ?? null);
    else if (payment.status === "failed") add("paypal-failed", "PayPal payment failed · nothing charged", payment.updatedAt, "bad", null);
    else if (payment.status === "awaiting_buyer") add("paypal-buyer", "Waiting for PayPal checkout", payment.updatedAt, "wait", null);
    for (const w of webhooks) add(`webhook-${w.id}`, `Webhook ${w.eventType}`, w.receivedAt, "info", w.outcome);
    if (payment.reconciledAt != null) add("reconcile", `Reconciled · ${payment.reconciled}`, payment.reconciledAt, payment.reconciled === "mismatch" ? "bad" : "ok", payment.reconcileNote);
  }
  if (r.status === "denied") add("final", "Denied · nothing charged", Math.max(r.updatedAt, ...steps.map((s) => s.at_ms)), "bad");
  else if (r.status === "pending_human") add("final", row.needs_clarification ? "Waiting for the agent's answer" : "Waiting for you", Math.max(r.updatedAt, ...steps.map((s) => s.at_ms)), "wait");

  steps.sort((a, b) => a.at_ms - b.at_ms);

  return {
    row,
    agent: { id: r.agentId, name: agent?.name ?? r.agentId, status: agent ? agentStatus(agent) : "revoked" },
    timeline: steps,
    hard_rules: results.map((x) => ({ rule: x.rule, label: HARD_RULE_LABELS[x.rule] ?? x.rule, value: x.value ?? null, limit: x.limit ?? null, ok: x.ok, detail: x.detail })),
    auditor,
    mandate: mandate ? mandateView(mandate) : null,
    raw_request: {
      tool: "request_purchase",
      arguments: {
        merchant: r.merchant,
        amount: centsToValue(r.amountCents),
        currency: r.currency,
        items: r.items,
        reason: r.reason,
        ...(r.category ? { category: r.category } : {}),
        client_request_id: r.clientRequestId,
      },
      agent_id: r.agentId,
      authorization: "Bearer [redacted]",
    },
    telegram_linked: telegram,
  };
}
