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

export function callbackData(kind: typeof CB_APPROVE | typeof CB_DENY, requestId: string): string {
  const data = `${kind}:${requestId}`;
  if (Buffer.byteLength(data) > 64) throw new Error("callback_data exceeds Telegram's 64-byte limit");
  return data;
}

export function parseCallback(data: string): { action: "approve" | "deny"; requestId: string } | null {
  const m = /^(ap|dn):([A-Za-z0-9_]{1,60})$/.exec(data);
  if (!m) return null;
  return { action: m[1] === CB_APPROVE ? "approve" : "deny", requestId: m[2]! };
}

const shortId = (id: string | null | undefined) => (id ? `${id.slice(0, 6)}…` : "—");

/** Approval card sent when a request needs a human (plan flow B-5). */
export function approvalCard(view: RequestView, agentName: string, ttlMinutes: number): Card {
  const lines = [
    `Approval needed · ${view.display_id}`,
    `${agentName} wants to pay $${view.amount} to ${view.merchant}`,
    `Items: ${view.items}`,
    `Risk ${view.risk ?? "?"}/10 · ${view.reason ?? "No auditor reason"}`,
    `Expires in ${ttlMinutes} min`,
  ];
  return {
    text: lines.join("\n"),
    buttons: [[
      { text: "Approve", callback_data: callbackData(CB_APPROVE, view.request_id) },
      { text: "Deny", callback_data: callbackData(CB_DENY, view.request_id) },
    ]],
  };
}

/** Text the card is edited to once the request leaves pending_human (flow B-6). */
export function resultCard(row: Pick<LedgerRow, "status" | "display_id" | "amount" | "merchant" | "receipt" | "reason"> & { payment?: LedgerRow["payment"] }): Card {
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
      return { text: `Denied · ${row.display_id} · $${row.amount} to ${row.merchant}\n${row.reason ?? ""}`.trim(), buttons: [] };
    case "expired":
      return { text: `Expired · ${row.display_id} · no decision in time`, buttons: [] };
    case "failed":
      return { text: `Payment failed · ${row.display_id} · ${row.payment?.error ?? "see the web inbox"}`, buttons: [] };
    default:
      return { text: `${row.display_id} · ${row.status}`, buttons: [] };
  }
}
