import { timingSafeEqual } from "node:crypto";
import { webhookCallback, type Bot } from "grammy";
import { getActiveMandate, getWorkspace, listMandateVersions, REQUEST_STATUSES, type RequestStatus } from "@reins/db";
import {
  HttpPayPalClient,
  ReinsError,
  answerClarification,
  askAgent,
  authenticateAgent,
  completeVaultSetup,
  connectPayPal,
  createAgent,
  decideRequest,
  getInbox,
  getLedger,
  getLedgerRow,
  getRequestForAgent,
  handlePayPalWebhook,
  issueTelegramLinkToken,
  listAgentSummaries,
  listTransactionsForAgent,
  mandateView,
  reconcilePayments,
  saveMandate,
  setPaymentMode,
  startVaultSetup,
  suggestCategories,
  submitPurchase,
  type ReinsContext,
} from "@reins/core";

type Params = Record<string, string>;
type Handler = (req: Request, ctx: ReinsContext, params: Params, url: URL) => Promise<Response>;
interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  auth: "agent" | "admin" | "public";
  handler: Handler;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

async function readJson(req: Request): Promise<unknown> {
  const text = await req.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ReinsError(400, "invalid_json", "Body must be JSON");
  }
}

function toRoute(method: string, path: string, auth: Route["auth"], handler: Handler): Route {
  const keys: string[] = [];
  const pattern = new RegExp(
    `^${path.replace(/:([a-zA-Z_]+)/g, (_, k: string) => {
      keys.push(k);
      return "([A-Za-z0-9_-]+)";
    })}$`,
  );
  return { method, pattern, keys, auth, handler };
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Optional dashboard guard: when REINS_ADMIN_TOKEN is set, admin routes need it. Unset = open demo mode. */
function checkAdmin(req: Request, token: string | undefined) {
  if (!token) return;
  const header = req.headers.get("x-reins-admin") ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const cookie = /(?:^|;\s*)reins_admin=([^;]+)/.exec(req.headers.get("cookie") ?? "")?.[1] ?? "";
  if (!safeEqual(header, token) && !safeEqual(decodeURIComponent(cookie), token)) {
    throw new ReinsError(401, "admin_required", "Admin token required");
  }
}

const statusFilter = (url: URL): RequestStatus[] | undefined => {
  const raw = url.searchParams.get("status");
  if (!raw) return undefined;
  const list = raw.split(",").filter((s): s is RequestStatus => (REQUEST_STATUSES as readonly string[]).includes(s));
  return list.length ? list : undefined;
};

const routes: Route[] = [
  toRoute("GET", "/api/health", "public", async () => json({ ok: true })),

  // ---- agent API (MCP server calls these with the agent's Bearer key) ----
  toRoute("GET", "/api/mandate", "agent", async (req, ctx) => {
    const agent = await authenticateAgent(ctx, req.headers.get("authorization"));
    const m = await getActiveMandate(ctx.db, agent.id);
    if (!m) throw new ReinsError(404, "no_mandate", "No mandate configured for this agent yet");
    return json({ agent: { id: agent.id, name: agent.name }, mandate: mandateView(m) });
  }),
  toRoute("POST", "/api/requests", "agent", async (req, ctx) => {
    const agent = await authenticateAgent(ctx, req.headers.get("authorization"));
    const body = (await readJson(req)) as Record<string, unknown>;
    const idem = req.headers.get("idempotency-key");
    return json(await submitPurchase(ctx, agent, idem && !body.client_request_id ? { ...body, client_request_id: idem } : body), 201);
  }),
  toRoute("GET", "/api/requests/:id", "agent", async (req, ctx, p) => {
    const agent = await authenticateAgent(ctx, req.headers.get("authorization"));
    return json(await getRequestForAgent(ctx, agent, p.id!));
  }),
  toRoute("POST", "/api/requests/:id/answer", "agent", async (req, ctx, p) => {
    const agent = await authenticateAgent(ctx, req.headers.get("authorization"));
    const { answer } = (await readJson(req)) as { answer?: unknown };
    return json(await answerClarification(ctx, agent, p.id!, answer));
  }),
  toRoute("GET", "/api/transactions", "agent", async (req, ctx, _p, url) => {
    const agent = await authenticateAgent(ctx, req.headers.get("authorization"));
    return json({ transactions: await listTransactionsForAgent(ctx, agent, Number(url.searchParams.get("limit") ?? 20)) });
  }),

  // ---- dashboard / admin ----
  toRoute("GET", "/api/agents", "admin", async (_r, ctx) => json({ agents: await listAgentSummaries(ctx) })),
  toRoute("POST", "/api/agents", "admin", async (req, ctx) => {
    const body = (await readJson(req)) as { name?: string; mandate?: unknown };
    const created = await createAgent(ctx, String(body.name ?? ""));
    const mandate = body.mandate ? mandateView(await saveMandate(ctx, created.agent.id, body.mandate)) : null;
    return json({ ...created, mandate }, 201);
  }),
  toRoute("GET", "/api/agents/:id/mandates", "admin", async (_r, ctx, p) =>
    json({ versions: (await listMandateVersions(ctx.db, p.id!)).map(mandateView) }),
  ),
  toRoute("POST", "/api/agents/:id/mandates", "admin", async (req, ctx, p) =>
    json({ mandate: mandateView(await saveMandate(ctx, p.id!, await readJson(req))) }, 201),
  ),
  toRoute("POST", "/api/mandates/suggest-categories", "admin", async (req, ctx) => {
    const { purpose } = (await readJson(req)) as { purpose?: string };
    return json(await suggestCategories(ctx.categorySuggester, String(purpose ?? "")));
  }),
  toRoute("GET", "/api/inbox", "admin", async (_r, ctx) => json({ items: await getInbox(ctx) })),
  toRoute("POST", "/api/requests/:id/decision", "admin", async (req, ctx, p) => {
    const { action, note } = (await readJson(req)) as { action?: string; note?: unknown };
    if (action !== "approve" && action !== "deny") throw new ReinsError(400, "invalid_input", "action must be approve or deny");
    await decideRequest(ctx, p.id!, action, "web", typeof note === "string" ? note : undefined);
    return json(await getLedgerRow(ctx, p.id!));
  }),
  toRoute("POST", "/api/requests/:id/ask", "admin", async (req, ctx, p) => {
    const { question } = (await readJson(req)) as { question?: unknown };
    await askAgent(ctx, p.id!, question, "web");
    return json(await getLedgerRow(ctx, p.id!));
  }),
  toRoute("GET", "/api/ledger", "admin", async (_r, ctx, _p, url) =>
    json({
      rows: await getLedger(ctx, {
        status: statusFilter(url),
        agentId: url.searchParams.get("agent_id") ?? undefined,
        limit: Math.min(Number(url.searchParams.get("limit") ?? 200), 500),
      }),
    }),
  ),
  toRoute("POST", "/api/reconcile", "admin", async (req, ctx) => {
    const { days } = (await readJson(req)) as { days?: number };
    const span = Math.min(Math.max(Number(days ?? 2), 1), 31) * 86_400_000;
    try {
      return json(await reconcilePayments(ctx, { start: ctx.now() - span }));
    } catch (err) {
      const status = (err as { status?: number }).status;
      throw new ReinsError(502, "reconcile_failed", `Couldn't sync with PayPal Transaction Search${status ? ` (HTTP ${status})` : ""}. Showing cached data.`);
    }
  }),
  toRoute("GET", "/api/ledger/:id", "admin", async (_r, ctx, p) => json(await getLedgerRow(ctx, p.id!))),
  toRoute("GET", "/api/workspace", "admin", async (_r, ctx) => {
    const ws = await getWorkspace(ctx.db);
    // vault id and link token never leave the server
    return json({
      name: ws.name,
      paypal_env: ws.paypalEnv,
      merchant_email: ws.merchantEmail,
      payment_mode: ws.paymentMode,
      has_vault: Boolean(ws.vaultId),
      telegram_linked: Boolean(ws.telegramChatId),
      telegram_bot: process.env.TELEGRAM_BOT_USERNAME ?? "ReinsApproveBot",
      connected_at: ws.connectedAt ? new Date(ws.connectedAt).toISOString() : null,
    });
  }),
  toRoute("POST", "/api/workspace/mode", "admin", async (req, ctx) => {
    const { mode } = (await readJson(req)) as { mode?: string };
    if (mode !== "vaulted" && mode !== "supervised" && mode !== "treasury") throw new ReinsError(400, "invalid_input", "mode must be vaulted, supervised or treasury");
    const ws = await setPaymentMode(ctx, mode);
    return json({ payment_mode: ws.paymentMode });
  }),
  toRoute("POST", "/api/paypal/connect", "admin", async (req, ctx) => {
    const body = (await readJson(req)) as { demo?: boolean; client_id?: string; client_secret?: string; merchant_email?: string };
    if (body.demo) {
      const ws = await connectPayPal(ctx, ctx.paypal, { env: ctx.paypal instanceof HttpPayPalClient ? "sandbox" : "fake", merchantEmail: body.merchant_email ?? process.env.PAYPAL_SANDBOX_MERCHANT_EMAIL ?? null });
      return json({ connected: true, merchant_email: ws.merchantEmail, paypal_env: ws.paypalEnv });
    }
    if (!body.client_id || !body.client_secret) throw new ReinsError(400, "invalid_input", "client_id and client_secret are required");
    const client = new HttpPayPalClient({ clientId: body.client_id, clientSecret: body.client_secret, env: "sandbox" });
    const ws = await connectPayPal(ctx, client, { env: "sandbox", merchantEmail: body.merchant_email ?? null });
    ctx.paypal = client; // in memory only; secrets are never persisted
    return json({ connected: true, merchant_email: ws.merchantEmail, paypal_env: ws.paypalEnv });
  }),
  toRoute("POST", "/api/paypal/vault/start", "admin", async (_r, ctx) => json(await startVaultSetup(ctx))),
  toRoute("POST", "/api/paypal/vault/complete", "admin", async (req, ctx) => {
    const { order_id } = (await readJson(req)) as { order_id?: string };
    if (!order_id) throw new ReinsError(400, "invalid_input", "order_id is required");
    const ws = await completeVaultSetup(ctx, order_id);
    return json({ payment_mode: ws.paymentMode, has_vault: Boolean(ws.vaultId) });
  }),
  toRoute("POST", "/api/telegram/link", "admin", async (_r, ctx) => {
    const token = await issueTelegramLinkToken(ctx);
    const bot = process.env.TELEGRAM_BOT_USERNAME ?? "ReinsApproveBot";
    return json({ url: `https://t.me/${bot}?start=${token}` });
  }),
  toRoute("GET", "/api/events", "admin", async (req, ctx) => sseResponse(req, ctx, sseHeartbeatMs)),

  // ---- inbound webhooks ----
  toRoute("POST", "/api/webhooks/paypal", "public", async (req, ctx) => {
    const r = await handlePayPalWebhook(ctx, req.headers, await req.text());
    return json(r.body, r.status);
  }),
  toRoute("POST", "/api/telegram/webhook", "public", async (req, ctx) => {
    const bot = (ctx as ReinsContext & { telegramBot?: Bot }).telegramBot;
    if (!bot) return json({ ok: false, error: "Telegram bot not configured" }, 503);
    return webhookCallback(bot, "std/http", { secretToken: process.env.TELEGRAM_WEBHOOK_SECRET })(req);
  }),
];

let sseHeartbeatMs = 15_000;

/**
 * Server-Sent Events: pushes request.created / request.updated to the inbox, ledger and nav badge.
 * - `retry: 3000` tells EventSource how long to wait before reconnecting
 * - a named `ping` event every heartbeat lets the client detect a dead connection (comments are invisible to JS)
 * - every event carries an increasing `id`; after a reconnect the client simply refetches
 */
function sseResponse(req: Request, ctx: ReinsContext, heartbeatMs: number): Response {
  const enc = new TextEncoder();
  let cleanup = () => {};
  let seq = 0;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (chunk: string) => {
        try {
          controller.enqueue(enc.encode(chunk));
        } catch {
          cleanup();
        }
      };
      send(`retry: 3000\nevent: ready\nid: ${seq++}\ndata: {"heartbeat_ms":${heartbeatMs}}\n\n`);
      const unsubscribe = ctx.events.subscribe((e) => send(`event: ${e.type}\nid: ${seq++}\ndata: ${JSON.stringify(e.request)}\n\n`));
      const ping = setInterval(() => send(`event: ping\ndata: ${Date.now()}\n\n`), heartbeatMs);
      cleanup = () => {
        clearInterval(ping);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      req.signal.addEventListener("abort", () => cleanup());
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store, no-transform", connection: "keep-alive", "x-accel-buffering": "no" },
  });
}

export function createRouter(getCtx: () => Promise<ReinsContext>, opts: { adminToken?: string; sseHeartbeatMs?: number } = {}) {
  if (opts.sseHeartbeatMs) sseHeartbeatMs = opts.sseHeartbeatMs;
  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const candidates = routes.filter((r) => r.pattern.test(url.pathname));
    if (!candidates.length) return json({ error: "not_found", message: "No such route" }, 404);
    const route = candidates.find((r) => r.method === req.method);
    if (!route) return json({ error: "method_not_allowed" }, 405);
    const match = route.pattern.exec(url.pathname)!;
    const params = Object.fromEntries(route.keys.map((k, i) => [k, match[i + 1]!]));
    try {
      if (route.auth === "admin") checkAdmin(req, opts.adminToken);
      return await route.handler(req, await getCtx(), params, url);
    } catch (err) {
      if (err instanceof ReinsError) return json({ error: err.code, message: err.message }, err.status);
      console.error("[reins] unhandled", req.method, url.pathname, err instanceof Error ? err.message : "error");
      return json({ error: "internal", message: "Internal error" }, 500);
    }
  };
}
