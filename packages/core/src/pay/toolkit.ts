import { firstCapture, type CreateOrderBody, type Order, type PayPalClient } from "../paypal/types.ts";
import { submitPurchase, type PurchaseInput, type ReinsContext } from "../service.ts";
import type { RequestView } from "../views.ts";
import type { Agent } from "@reins/db";

/**
 * Opt-in composition with the PayPal Agent Toolkit (@paypal/agent-toolkit): Reins decides, the Toolkit executes.
 *
 * Reins stays the policy layer (mandate, hard rules, Claude audit, human approval, ledger). When a request is
 * approved, the PayPal order is created (and captured once the buyer has approved it) by calling the Toolkit's own `create_order` and
 * `pay_order` (capture) tools instead of Reins' direct Orders v2 calls. A call the gate does not approve never reaches
 * the Toolkit.
 *
 * Verified: unit tests with a fake Toolkit (packages/core/test/toolkit.test.ts) cover the gate, the call shape
 * and the denial path, and scripts/demo/toolkit-gate-run.mjs ran it against the real @paypal/agent-toolkit 1.11.0
 * in the PayPal sandbox (docs/spikes/d5-toolkit-gate.md; that run fixed the argument types and the capture tool
 * name/response shape). Only approval-link (supervised) orders are supported, because the Toolkit's create_order
 * has no vault_id option.
 */
export interface ToolkitLike {
  /** Same shape as PayPalAPI.run(method, args) in @paypal/agent-toolkit; the result may be a JSON string or an object. */
  run(method: "create_order" | "pay_order", args: Record<string, unknown>): Promise<unknown>;
}

function parseResult(raw: unknown): Record<string, unknown> {
  const v = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  if (!v || typeof v !== "object") throw new Error("Agent Toolkit returned an unreadable result");
  // PayPalAPI.run() does not throw: it returns { error: { message, type } } as a JSON string
  const err = (v as { error?: { message?: unknown } }).error;
  if (err) throw new Error(`Agent Toolkit error: ${String(typeof err === "object" ? err.message : err).replace(/\s+/g, " ").slice(0, 300)}`);
  // PayPal HTTP errors come back as { ok: false, status, code, message } (LlmError), also without throwing
  const o = v as { ok?: unknown; code?: unknown; message?: unknown };
  if (o.ok === false) throw new Error(`Agent Toolkit error ${String(o.code ?? "")}: ${String(o.message ?? "").replace(/\s+/g, " ").slice(0, 300)}`.trim());
  return v as Record<string, unknown>;
}

/** @paypal/agent-toolkit 1.11.0 exposes order capture as `pay_order` ("Process payment for an authorized order"). */
export const CAPTURE_TOOL = "pay_order" as const;

/** The Toolkit wraps a capture as { status: "success", response: <PayPal order> }; accept a bare order too. */
function unwrapCapture(res: Record<string, unknown>): Order {
  const inner = res.response;
  return (inner && typeof inner === "object" ? inner : res) as Order;
}

/**
 * PayPalClient whose order calls go through the Toolkit. Everything else (webhook verification, reconciliation)
 * stays on the base client.
 */
export function toolkitPayPalClient(toolkit: ToolkitLike, base: PayPalClient): PayPalClient {
  return {
    getAccessToken: () => base.getAccessToken(),
    getOrder: (id) => base.getOrder(id),
    createPayout: (b) => base.createPayout(b),
    verifyWebhookSignature: (h, e, w) => base.verifyWebhookSignature(h, e, w),
    searchTransactions: (p) => base.searchTransactions(p),
    async createOrder(body: CreateOrderBody): Promise<Order> {
      if (body.payment_source?.paypal.vault_id) throw new Error("Agent Toolkit create_order cannot use a saved vault_id; use supervised payment mode");
      const unit = body.purchase_units[0]!;
      const ctx = body.payment_source?.paypal.experience_context;
      const res = parseResult(
        await toolkit.run("create_order", {
          currencyCode: unit.amount.currency_code,
          items: [{ name: (unit.description ?? "Reins purchase").slice(0, 127), quantity: 1, itemCost: Number(unit.amount.value), itemTotal: Number(unit.amount.value) }],
          ...(ctx?.return_url ? { returnUrl: ctx.return_url } : {}),
          ...(ctx?.cancel_url ? { cancelUrl: ctx.cancel_url } : {}),
        }),
      );
      if (typeof res.id !== "string") throw new Error("Agent Toolkit create_order returned no order id");
      const links = Array.isArray(res.links) ? (res.links as Order["links"]) : [];
      return { id: res.id, status: (res.status as Order["status"]) ?? "CREATED", links, purchase_units: [{ ...unit }] };
    },
    async captureOrder(orderId: string): Promise<Order> {
      return unwrapCapture(parseResult(await toolkit.run(CAPTURE_TOOL, { id: orderId })));
    },
  };
}

/** The same context with PayPal order calls routed through the Toolkit. */
export function withToolkit(ctx: ReinsContext, toolkit: ToolkitLike): ReinsContext {
  return { ...ctx, paypal: toolkitPayPalClient(toolkit, ctx.paypal) };
}

export interface ToolkitCall {
  tool: "create_order";
  /** The Toolkit's own create_order arguments (currencyCode, items[{name, quantity, itemCost, itemTotal}]). */
  args: { currencyCode?: string; items: Array<{ name: string; quantity?: string | number; itemCost: string | number; itemTotal?: string | number }> };
  /** What the Toolkit call cannot say: who is paid and why. */
  merchant: string;
  reason: string;
  category?: string;
  client_request_id?: string;
}

/**
 * Pre-call hook: `reinsGate(ctx, agent, toolkit, call)` checks the Toolkit call against the agent's mandate and
 * rules first. Approved calls are executed through the Toolkit; denied ones and ones that need a person return the
 * Reins decision and the Toolkit is never called. Returns the usual request view (status, reason, receipt).
 */
export async function reinsGate(ctx: ReinsContext, agent: Agent, toolkit: ToolkitLike, call: ToolkitCall): Promise<RequestView> {
  const cents = call.args.items.reduce((sum, i) => sum + Math.round(Number(i.itemCost) * 100) * Number(i.quantity ?? 1), 0);
  if (!Number.isFinite(cents) || cents <= 0) throw new Error("Toolkit call has no payable amount");
  const input: PurchaseInput = {
    merchant: call.merchant,
    amount: (cents / 100).toFixed(2),
    currency: call.args.currencyCode ?? "USD",
    items: call.args.items.map((i) => i.name).join(", "),
    reason: call.reason,
    category: call.category,
    client_request_id: call.client_request_id,
  };
  return submitPurchase(withToolkit(ctx, toolkit), agent, input);
}

/** Capture an order the buyer approved, through the Toolkit's `pay_order` tool. */
export async function captureViaToolkit(toolkit: ToolkitLike, orderId: string) {
  const order = unwrapCapture(parseResult(await toolkit.run(CAPTURE_TOOL, { id: orderId })));
  return { order, captureId: firstCapture(order)?.id };
}
