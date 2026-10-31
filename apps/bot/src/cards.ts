import type { LedgerRow, RequestView } from "@reins/core";

export interface InlineButton {
  text: string;
  callback_data?: string;
  url?: string;
}
export interface Card {
  text: string;
  buttons: InlineButton[][];
}

export const CB_APPROVE = "ap";
export const CB_DENY = "dn";
export const CB_ASK = "ak";
/** S5: approve + always allow this merchant up to this amount. */
export const CB_APPROVE_ALLOW = "aa";
/** S3/S6: pause the agent that made this request (its next requests are denied by a hard rule). */
export const CB_PAUSE = "pa";
type CbKind = typeof CB_APPROVE | typeof CB_DENY | typeof CB_ASK | typeof CB_APPROVE_ALLOW | typeof CB_PAUSE;
export type CallbackAction = "approve" | "deny" | "ask" | "approve_allow" | "pause";
const ACTIONS: Record<CbKind, CallbackAction> = { ap: "approve", dn: "deny", ak: "ask", aa: "approve_allow", pa: "pause" };

export function callbackData(kind: CbKind, requestId: string): string {
  const data = `${kind}:${requestId}`;
  if (Buffer.byteLength(data) > 64) throw new Error("callback_data exceeds Telegram's 64-byte limit");
  return data;
}

export function parseCallback(data: string): { action: CallbackAction; requestId: string } | null {
  const m = /^(ap|dn|ak|aa|pa):([A-Za-z0-9_]{1,60})$/.exec(data);
  if (!m) return null;
  return { action: ACTIONS[m[1] as CbKind], requestId: m[2]! };
}

/**
 * User-facing failure text: only a PayPal issue code (e.g. INSTRUMENT_DECLINED) is shown, never the raw
 * internal error (which can contain ids, URLs or config hints).
 */
export function publicFailure(error: string | null | undefined): string {
  const code = error?.match(/\b([A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+)\b/)?.[1];
  return code ? `PayPal declined (${code}).` : "PayPal did not complete the payment.";
}

const shortId = (id: string | null | undefined) => (id ? `${id.slice(0, 6)}…` : "—");
const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** First sentence of the auditor reason, capped so the card stays 7-9 lines (plan: "심사 사유 1줄"). */
export function oneLine(reason: string | null | undefined, max = 160): string {
  if (!reason) return "No auditor reason";
  const first = reason.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s/)[0] ?? reason;
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

/** Telegram only accepts public http(s) URLs on inline url buttons; localhost is rejected by the Bot API. */
export function publicLink(baseUrl: string | undefined, path: string): string | undefined {
  if (!baseUrl || !/^https:\/\//.test(baseUrl) || /localhost|127\.0\.0\.1/.test(baseUrl)) return undefined;
  return `${baseUrl.replace(/\/$/, "")}${path}`;
}

export interface CardOptions {
  ttlMinutes: number;
  /** Month-to-date spend and cap for "Budget: $41.00 left of $60 this month after this". */
  budget?: { monthSpentCents: number; monthlyLimitCents: number | null } | null;
  /** Public web base URL for the "Open in Reins" button (https only). */
  webBaseUrl?: string;
}

function body(view: RequestView, agentName: string, opts: CardOptions): string[] {
  const amountCents = Math.round(Number(view.amount) * 100);
  const lines = [
    `Agent: ${agentName}`,
    `Item: ${view.items}`,
    `Merchant: ${view.merchant} · $${view.amount} ${view.currency ?? "USD"}`,
  ];
  if (view.agent_reason) lines.push(`Why (agent): "${oneLine(view.agent_reason, 120)}"`);
  if (opts.budget?.monthlyLimitCents != null) {
    const left = opts.budget.monthlyLimitCents - opts.budget.monthSpentCents - amountCents;
    lines.push(`Budget: ${usd(Math.max(left, 0))} left of ${usd(opts.budget.monthlyLimitCents)} this month after this`);
  }
  lines.push(`Reins check: ${oneLine(view.reason)} Risk ${view.risk ?? "?"}/10.`);
  const pattern = patternLine(view);
  if (pattern) lines.push(pattern);
  if (view.clarification) {
    lines.push(`You asked: "${view.clarification.question}"`);
    const c = view.clarification;
    lines.push(c.answer ? (c.answer_summary ? `Agent (summary): "${c.answer_summary}"` : `Agent: "${c.answer}"`) : "Waiting for the agent to answer…");
  }
  return lines;
}

/** S3 warning line, e.g. "Pattern alert: 4th request to statista.com in 24 hours; requested at 02:14 (Asia/Seoul)…". */
export function patternLine(view: Pick<RequestView, "anomalies">): string | null {
  const list = view.anomalies ?? [];
  if (!list.length) return null;
  const text = list.map((a) => a.detail_en).join("; ");
  return `Pattern alert: ${text.length > 200 ? `${text.slice(0, 199)}…` : text}`;
}

/** Approval card sent when a request needs a human (plan flow B-5, screen S3 state 1). */
export function approvalCard(view: RequestView, agentName: string, ttlOrOpts: number | CardOptions): Card {
  const opts: CardOptions = typeof ttlOrOpts === "number" ? { ttlMinutes: ttlOrOpts } : ttlOrOpts;
  const text = [`Purchase request ${view.display_id}`, ...body(view, agentName, opts), `Expires in ${opts.ttlMinutes} min`].join("\n");
  const open = publicLink(opts.webBaseUrl, `/inbox?r=${view.request_id}`);
  const second: InlineButton[] = [{ text: "Ask agent", callback_data: callbackData(CB_ASK, view.request_id) }];
  if (open) second.push({ text: "Open in Reins", url: open });
  return {
    text,
    buttons: [
      [
        { text: `Approve $${view.amount}`, callback_data: callbackData(CB_APPROVE, view.request_id) },
        { text: "Deny", callback_data: callbackData(CB_DENY, view.request_id) },
      ],
      [{ text: `Approve + always allow ${view.merchant}`, callback_data: callbackData(CB_APPROVE_ALLOW, view.request_id) }],
      second,
      [{ text: "Pause this agent", callback_data: callbackData(CB_PAUSE, view.request_id) }],
    ],
  };
}

/** Hard-rule / auditor block warning (flow B-8, S3 "Blocked" message): no approve button, ends with reassurance. */
export function blockedCard(view: RequestView, agentName: string, webBaseUrl?: string): Card {
  const open = publicLink(webBaseUrl, `/ledger?r=${view.request_id}`);
  return {
    text: [
      `Blocked ${view.display_id}`,
      `Agent: ${agentName} tried ${view.merchant} · $${view.amount}`,
      `Item: ${view.items}`,
      `Why blocked: ${oneLine(view.reason, 220)}`,
      ...(patternLine(view) ? [patternLine(view)!] : []),
      view.risk != null ? `Risk ${view.risk}/10. Nothing was charged.` : "Nothing was charged.",
    ].join("\n"),
    // S3: a block never offers Approve; "Review in Reins" (https only) + "Pause this agent"
    buttons: [[...(open ? [{ text: "Review in Reins", url: open }] : []), { text: "Pause this agent", callback_data: callbackData(CB_PAUSE, view.request_id) }]],
  };
}

/** Text the card is edited to once the request leaves pending_human (flow B-6). */
export function resultCard(
  row: Pick<LedgerRow, "status" | "display_id" | "amount" | "merchant" | "receipt" | "reason"> & { payment?: LedgerRow["payment"] },
  rule?: { sentence: string } | null,
): Card {
  const card = resultCardBase(row);
  // S5: the merchant rule saved with this approval, shown under the result
  return rule ? { ...card, text: `${card.text}\nRule added: ${oneLine(rule.sentence, 240)}` } : card;
}

function resultCardBase(row: Pick<LedgerRow, "status" | "display_id" | "amount" | "merchant" | "receipt" | "reason"> & { payment?: LedgerRow["payment"] }): Card {
  switch (row.status) {
    case "paid":
      return { text: `Paid $${row.amount} · Capture ${shortId(row.receipt?.capture_id ?? row.receipt?.payout_batch_id)}\n${row.display_id} · ${row.merchant}`, buttons: [] };
    case "paying":
    case "approved":
      return { text: `Paying… ${row.display_id} · $${row.amount} to ${row.merchant}`, buttons: [] };
    case "awaiting_buyer": {
      const url = row.payment?.approve_url;
      return {
        text: `Approved · finish checkout on PayPal\n${row.display_id} · $${row.amount} to ${row.merchant}`,
        buttons: url ? [[{ text: "Open PayPal", url }]] : [],
      };
    }
    case "denied":
      return { text: `Denied · ${row.display_id} · $${row.amount} to ${row.merchant}\n${oneLine(row.reason, 220)}`.trim(), buttons: [] };
    case "expired":
      return { text: `Expired · ${row.display_id} · agent told to ask again`, buttons: [] };
    case "failed":
      return { text: `Payment failed · ${row.display_id} · $${row.amount} to ${row.merchant}\n${publicFailure(row.payment?.error)} Nothing was charged. Agent notified.`, buttons: [] };
    default:
      return { text: `${row.display_id} · ${row.status}`, buttons: [] };
  }
}
