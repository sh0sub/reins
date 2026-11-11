import { timingSafeEqual } from "node:crypto";
import { webhookCallback, type Bot } from "grammy";
import { getActiveMandate, getAgent, getRequest, getWorkspace, listAgents, listMandateVersions, REQUEST_STATUSES, type RequestStatus } from "@reins/db";
import {
  HttpPayPalClient,
  usablePaymentMode,
  PLAYGROUND_AGENT,
  PLAYGROUND_COOKIE,
  ReinsError,
  cancelCheckout,
  isPlaygroundVisitor,
  newPlaygroundVisitor,
  playgroundScope,
  returnFromCheckout,
  agentStatus,
  getAgentEvents,
  getRequestDetail,
  markPatternExpected,
  pauseAgent,
  pauseAgentForRequest,
  resumeAgent,
  rotateAgentKey,
  answerClarification,
  approveAndAllowMerchant,
  askAgent,
  authenticateAgent,
  authenticateAgentScoped,
  completeVaultSetup,
  connectPayPal,
  createAgent,
  decideRequest,
  getInbox,
  getLedger,
  getLedgerRow,
  getOverview,
  parsePeriod,
  judgeMode,
  playgroundConnect,
  playgroundEnabled,
  resetPlayground,
  runPlayground,
  getReceipt,
  getWeeklySummary,
  getRequestForAgent,
  handlePayPalWebhook,
  issueTelegramLinkToken,
  listAgentSummaries,
  listTransactionsForAgent,
  mandateView,
  reconcileNow,
  saveMandate,
  setPaymentMode,
  startVaultSetup,
  suggestCategories,
  submitPurchase,
  type ReinsContext,
} from "@reins/core";

type Params = Record<string, string>;
/** `rt.locked`: the public-demo lock applies to this caller (C1). */
type Handler = (req: Request, ctx: ReinsContext, params: Params, url: URL, rt: { locked: boolean }) => Promise<Response>;
interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  auth: "agent" | "admin" | "cron" | "public";
  handler: Handler;
  /** C1: on the public demo (REINS_PUBLIC_DEMO=1) mutating admin routes are refused unless marked "allow". */
  demo?: "allow";
  /** M1: per-IP token bucket name (see RATE_LIMITS). */
  limit?: keyof typeof RATE_LIMITS;
}

import { DEMO_MERCHANT_EMAIL, workspaceView } from "./workspace.ts";
import { RATE_LIMITS, RateLimiter, clientIp } from "./rateLimit.ts";

/** Seeded agents of the public demo (scripts/seed.ts); with the Playground Agent the only ones a judge may decide for. */
export const DEMO_AGENT_NAMES = new Set(["Claude Code – DevOps", "Research Scout", "Desk Restock Bot", PLAYGROUND_AGENT]);

export const PUBLIC_DEMO_REFUSAL = "This action is disabled on the public demo. Run Reins locally (pnpm judge) to try it.";
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

function toRoute(method: string, path: string, auth: Route["auth"], handler: Handler, extra: Pick<Route, "demo" | "limit"> = {}): Route {
  const keys: string[] = [];
  const pattern = new RegExp(
    `^${path.replace(/:([a-zA-Z_]+)/g, (_, k: string) => {
      keys.push(k);
      return "([A-Za-z0-9_-]+)";
    })}$`,
  );
  return { method, pattern, keys, auth, handler, ...extra };
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

const readCookie = (req: Request, name: string) => {
  const raw = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.get("cookie") ?? "")?.[1] ?? "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return "";
  }
};

/** True when the caller presented REINS_ADMIN_TOKEN (header, Bearer or the reins_admin cookie). */
function hasAdminToken(req: Request, token: string | undefined): boolean {
  if (!token) return false;
  const header = req.headers.get("x-reins-admin") ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  return safeEqual(header, token) || safeEqual(readCookie(req, "reins_admin"), token);
}

/** Optional dashboard guard: when REINS_ADMIN_TOKEN is set, admin routes need it. Unset = open demo mode. */
function checkAdmin(req: Request, token: string | undefined) {
  if (!token) return;
  if (!hasAdminToken(req, token)) throw new ReinsError(401, "admin_required", "Admin token required");
}

/**
 * M7 CSRF guard for admin writes: the body must be application/json (a cross-site form cannot send that without a CORS
 * preflight, which this API never answers) and a browser Origin, when sent, must be the deployment's own origin.
 */
function checkWrite(req: Request, url: URL, publicBaseUrl: string | undefined) {
  const type = (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json") throw new ReinsError(415, "json_required", "POST bodies must be sent as application/json");
  const origin = req.headers.get("origin");
  if (!publicBaseUrl || !origin) return;
  let expected: string;
  try {
    expected = new URL(publicBaseUrl).origin;
  } catch {
    return;
  }
  // the page's own host also counts (local dev on localhost while PUBLIC_BASE_URL points at a tunnel)
  const host = req.headers.get("host");
  const own = host ? [`http://${host}`, `https://${host}`] : [];
  if (origin !== expected && origin !== url.origin && !own.includes(origin)) throw new ReinsError(403, "bad_origin", "Cross-site request refused");
}

/** /try visitor id (cookie reins_try). A fresh one is minted when missing; the response then sets the cookie. */
function playgroundVisitor(req: Request): { id: string; fresh: boolean } {
  const id = readCookie(req, PLAYGROUND_COOKIE);
  return isPlaygroundVisitor(id) ? { id, fresh: false } : { id: newPlaygroundVisitor(), fresh: true };
}

export function playgroundCookie(id: string, secure: boolean): string {
  return `${PLAYGROUND_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400${secure ? "; Secure" : ""}`;
}

const isHttps = (req: Request, url: URL) => url.protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";

/**
 * Render Cron jobs can't mount the web service's disk, so scheduled jobs call the web service instead. These routes
 * always need REINS_CRON_SECRET (even in open demo mode without REINS_ADMIN_TOKEN); unset = disabled.
 */
function checkCron(req: Request, secret: string | undefined) {
  if (!secret) throw new ReinsError(503, "cron_disabled", "REINS_CRON_SECRET is not configured");
  const header = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!safeEqual(header, secret)) throw new ReinsError(401, "cron_secret_required", "Cron secret required");
}

async function reconcileResponse(req: Request, ctx: ReinsContext): Promise<Response> {
  const { days } = (await readJson(req)) as { days?: number };
  const span = Math.min(Math.max(Number(days ?? 2) || 2, 1), 31) * 86_400_000;
  try {
    return json(await reconcileNow(ctx, { start: ctx.now() - span }));
  } catch (err) {
    const status = (err as { status?: number }).status;
    throw new ReinsError(502, "reconcile_failed", `Couldn't sync with PayPal Transaction Search${status ? ` (HTTP ${status})` : ""}. Showing cached data.`);
  }
}

const statusFilter = (url: URL): RequestStatus[] | undefined => {
  const raw = url.searchParams.get("status");
  if (!raw) return undefined;
  const list = raw.split(",").filter((s): s is RequestStatus => (REQUEST_STATUSES as readonly string[]).includes(s));
  return list.length ? list : undefined;
};

const routes: Route[] = [
  // ?detail=1 adds booleans only (never the values): which payment mode really runs and whether a treasury payee is set
  toRoute("GET", "/api/health", "public", async (_req, ctx, _p, url) =>
    url.searchParams.get("detail") === "1"
      ? json({ ok: true, payment_mode: usablePaymentMode((await getWorkspace(ctx.db)).paymentMode, ctx.config.treasuryPayeeEmail), treasury_payee_configured: Boolean(ctx.config.treasuryPayeeEmail?.trim()) })
      : json({ ok: true }),
  ),

  // ---- agent API (MCP server calls these with the agent's Bearer key) ----
  toRoute("GET", "/api/mandate", "agent", async (req, ctx) => {
    const agent = await authenticateAgent(ctx, req.headers.get("authorization"));
    const m = await getActiveMandate(ctx.db, agent.id);
    if (!m) throw new ReinsError(404, "no_mandate", "No mandate configured for this agent yet");
    // status: "paused" means every request_purchase is denied until the owner resumes the agent
    return json({ agent: { id: agent.id, name: agent.name, status: agentStatus(agent) }, mandate: mandateView(m) });
  }),
  toRoute("POST", "/api/requests", "agent", async (req, ctx) => {
    // a per-visitor demo key carries its own playground scope (only that visitor's rows count, velocity included)
    const { agent, scope } = await authenticateAgentScoped(ctx, req.headers.get("authorization"));
    const body = (await readJson(req)) as Record<string, unknown>;
    const idem = req.headers.get("idempotency-key");
    return json(await submitPurchase(ctx, agent, idem && !body.client_request_id ? { ...body, client_request_id: idem } : body, { scope }), 201);
  }),
  toRoute("GET", "/api/requests/:id", "agent", async (req, ctx, p) => {
    const { agent, scope } = await authenticateAgentScoped(ctx, req.headers.get("authorization"));
    return json(await getRequestForAgent(ctx, agent, p.id!, scope));
  }),
  toRoute("POST", "/api/requests/:id/answer", "agent", async (req, ctx, p) => {
    const { agent, scope } = await authenticateAgentScoped(ctx, req.headers.get("authorization"));
    const { answer } = (await readJson(req)) as { answer?: unknown };
    return json(await answerClarification(ctx, agent, p.id!, answer, scope));
  }),
  toRoute("GET", "/api/transactions", "agent", async (req, ctx, _p, url) => {
    const { agent, scope } = await authenticateAgentScoped(ctx, req.headers.get("authorization"));
    return json({ transactions: await listTransactionsForAgent(ctx, agent, Number(url.searchParams.get("limit") ?? 20), scope) });
  }),

  // ---- dashboard / admin ----
  toRoute("GET", "/api/overview", "admin", async (_r, ctx, _p, url) => json(await getOverview(ctx, parsePeriod(url.searchParams.get("period")), { includePlayground: url.searchParams.get("include_playground") === "1" }))),
  toRoute("GET", "/api/overview/summary", "admin", async (_r, ctx) => json(await getWeeklySummary(ctx))),
  toRoute("GET", "/api/agents", "admin", async (_r, ctx) => json({ agents: await listAgentSummaries(ctx) })),
  toRoute("POST", "/api/agents", "admin", async (req, ctx) => {
    const body = (await readJson(req)) as { name?: string; mandate?: unknown };
    const created = await createAgent(ctx, String(body.name ?? ""));
    const mandate = body.mandate ? mandateView(await saveMandate(ctx, created.agent.id, body.mandate)) : null;
    return json({ ...created, mandate }, 201);
  }),
  toRoute("POST", "/api/agents/:id/pause", "admin", async (_r, ctx, p) => json(await pauseAgent(ctx, p.id!, "web"))),
  toRoute("POST", "/api/agents/:id/resume", "admin", async (_r, ctx, p) => json(await resumeAgent(ctx, p.id!, "web"))),
  // new key shown once; the old key stops working immediately
  toRoute("POST", "/api/agents/:id/rotate-key", "admin", async (_r, ctx, p) => json(await rotateAgentKey(ctx, p.id!, "web"), 201)),
  toRoute("GET", "/api/agents/:id/events", "admin", async (_r, ctx, p) => json({ events: await getAgentEvents(ctx, p.id!) })),
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
  // Public demo only: a judge who approved (or let expire) the seeded card can raise the same Research Scout request again
  toRoute("POST", "/api/demo/request", "admin", async (_r, ctx) => {
    if (process.env.REINS_PUBLIC_DEMO !== "1") throw new ReinsError(403, "demo_only", "Only the public demo can create sample requests");
    // #2: every sample card gets its own spend scope, so earlier approvals (this judge's or anyone's) never use up
    // Research Scout's $100 cap and the card always waits for a person
    const agents = await listAgents(ctx.db);
    const agent = agents.find((a) => a.name === "Research Scout" && !a.revokedAt && !a.pausedAt);
    if (!agent) throw new ReinsError(404, "not_found", "The demo agent Research Scout is missing or paused");
    const view = await submitPurchase(ctx, agent, {
      merchant: "statista.com",
      amount: "59.00",
      items: 'Report "Agentic Commerce 2026" (PDF)',
      reason: "Market sizing for Q4 memo (task #31)",
      category: "research",
    }, { scope: playgroundScope(newPlaygroundVisitor()) });
    return json({ request_id: view.request_id, status: view.status }, 201);
  }, { demo: "allow", limit: "demo" }),
  // /try playground: a judge raises requests as a demo agent (no MCP client needed). Off unless REINS_TRY=1 or the public demo.
  toRoute("GET", "/api/try", "admin", async () => json({ enabled: playgroundEnabled() })),
  toRoute("POST", "/api/try", "admin", async (req, ctx, _p, url) => {
    if (!playgroundEnabled()) throw new ReinsError(403, "try_disabled", "The playground is off here. Run `pnpm judge` or set REINS_TRY=1.");
    const { fooled_auditor, ...purchase } = (await readJson(req)) as Record<string, unknown>;
    // #2 per-visitor playground: spend, split-purchase and history windows only count this visitor's /try rows
    const visitor = playgroundVisitor(req);
    const res = json(await runPlayground(ctx, purchase, { fooled: fooled_auditor === true, visitor: visitor.id }), 201);
    if (visitor.fresh) res.headers.append("set-cookie", playgroundCookie(visitor.id, isHttps(req, url)));
    return res;
  }, { demo: "allow", limit: "try" }),
  // #A per-visitor demo key: each visitor (cookie reins_try) gets an own key and scope, so MCP calls of one judge never
  // count against another's velocity window. Creation is rate-limited per IP; keys expire after 24 hours.
  toRoute("GET", "/api/try/connect", "admin", async (req, ctx, _p, url) => {
    if (!playgroundEnabled()) throw new ReinsError(403, "try_disabled", "The demo key is only available on a demo instance (pnpm judge or REINS_TRY=1).");
    const visitor = playgroundVisitor(req);
    const res = json(await playgroundConnect(ctx, visitor.id));
    if (visitor.fresh) res.headers.append("set-cookie", playgroundCookie(visitor.id, isHttps(req, url)));
    return res;
  }, { limit: "connect" }),
  toRoute("POST", "/api/try/reset", "admin", async (_req, ctx) => {
    if (!judgeMode()) throw new ReinsError(403, "try_disabled", "Reset is only available in judge mode (pnpm judge or REINS_TRY=1).");
    return json(await resetPlayground(ctx));
  }, { demo: "allow" }), // guarded by judge mode itself (the public demo is never judge mode)
  toRoute("POST", "/api/requests/:id/decision", "admin", async (req, ctx, p, _url, rt) => {
    const { action, note, allow_merchant } = (await readJson(req)) as { action?: string; note?: unknown; allow_merchant?: unknown };
    if (action !== "approve" && action !== "deny") throw new ReinsError(400, "invalid_input", "action must be approve or deny");
    if (rt.locked) {
      // C1: judges decide the Playground Agent's and the seeded agents' cards only, and never rewrite a shared mandate
      const r = await getRequest(ctx.db, p.id!);
      const agent = r ? await getAgent(ctx.db, r.agentId) : undefined;
      if (r && (!agent || !DEMO_AGENT_NAMES.has(agent.name))) throw new ReinsError(403, "public_demo", PUBLIC_DEMO_REFUSAL);
      if (allow_merchant === true) throw new ReinsError(403, "public_demo", "Approve + always allow saves a new mandate, which is disabled on the public demo (other judges share it). Use Approve.");
    }
    if (allow_merchant === true) {
      // S5 one tap: approve + auto-approve this merchant up to this amount from now on
      if (action !== "approve") throw new ReinsError(400, "invalid_input", "allow_merchant only works with approve");
      const { rule } = await approveAndAllowMerchant(ctx, p.id!, "web");
      return json({ ...(await getLedgerRow(ctx, p.id!)), rule });
    }
    await decideRequest(ctx, p.id!, action, "web", typeof note === "string" ? note : undefined);
    return json(await getLedgerRow(ctx, p.id!));
  }, { demo: "allow" }),
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
  toRoute("POST", "/api/reconcile", "admin", async (req, ctx) => reconcileResponse(req, ctx)),
  // M11 nightly reconciliation for the Render Cron job (counts only in the response, like `pnpm reconcile`)
  toRoute("POST", "/api/cron/reconcile", "cron", async (req, ctx) => reconcileResponse(req, ctx)),
  toRoute("GET", "/api/ledger/:id/detail", "admin", async (_r, ctx, p) => json(await getRequestDetail(ctx, p.id!))),
  toRoute("POST", "/api/requests/:id/pause-agent", "admin", async (_r, ctx, p) => json(await pauseAgentForRequest(ctx, p.id!, "web"))),
  toRoute("POST", "/api/requests/:id/mark-expected", "admin", async (_r, ctx, p) => json(await markPatternExpected(ctx, p.id!, "web"))),
  toRoute("GET", "/api/ledger/:id", "admin", async (_r, ctx, p) => json(await getLedgerRow(ctx, p.id!))),
  toRoute("GET", "/api/receipts/:id", "admin", async (_r, ctx, p) => json(await getReceipt(ctx, p.id!))),
  toRoute("GET", "/api/workspace", "admin", async (_r, ctx) => json(await workspaceView(ctx))),
  toRoute("POST", "/api/workspace/mode", "admin", async (req, ctx) => {
    const { mode } = (await readJson(req)) as { mode?: string };
    if (mode !== "vaulted" && mode !== "supervised" && mode !== "treasury") throw new ReinsError(400, "invalid_input", "mode must be vaulted, supervised or treasury");
    if (mode === "treasury" && !ctx.config.treasuryPayeeEmail?.trim()) throw new ReinsError(409, "treasury_unavailable", "Treasury mode needs TREASURY_PAYEE_EMAIL on the server");
    const ws = await setPaymentMode(ctx, mode);
    return json({ payment_mode: ws.paymentMode });
  }),
  toRoute("POST", "/api/paypal/connect", "admin", async (req, ctx) => {
    const body = (await readJson(req)) as { demo?: boolean; client_id?: string; client_secret?: string; merchant_email?: string };
    if (body.demo) {
      const ws = await connectPayPal(ctx, ctx.paypal, { env: ctx.paypal instanceof HttpPayPalClient ? "sandbox" : "fake", merchantEmail: body.merchant_email ?? process.env.PAYPAL_SANDBOX_MERCHANT_EMAIL ?? (ctx.paypal instanceof HttpPayPalClient ? null : DEMO_MERCHANT_EMAIL) });
      return json({ connected: true, merchant_email: ws.merchantEmail, paypal_env: ws.paypalEnv });
    }
    // a public demo shares one server; visitors' credentials would replace the PayPal client for everyone
    if (process.env.REINS_PUBLIC_DEMO === "1") throw new ReinsError(403, "demo_only", "This public demo only connects the demo merchant");
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

  // ---- H5 supervised checkout: the buyer comes back from paypal.com (return_url / cancel_url of the order) ----
  toRoute("POST", "/api/pay/return", "public", async (req, ctx) => {
    const { request, token } = (await readJson(req)) as { request?: unknown; token?: unknown };
    if (typeof request !== "string" || !request) throw new ReinsError(400, "invalid_input", "request is required");
    const r = await returnFromCheckout(ctx, request, typeof token === "string" ? token : null);
    return json({ outcome: r.outcome, request: r.view });
  }, { limit: "checkout" }),
  toRoute("POST", "/api/pay/cancel", "public", async (req, ctx) => {
    const { request, token } = (await readJson(req)) as { request?: unknown; token?: unknown };
    if (typeof request !== "string" || !request) throw new ReinsError(400, "invalid_input", "request is required");
    const r = await cancelCheckout(ctx, request, typeof token === "string" ? token : null);
    return json({ outcome: r.outcome, request: r.view });
  }, { limit: "checkout" }),

  // ---- inbound webhooks ----
  toRoute("POST", "/api/webhooks/paypal", "public", async (req, ctx) => {
    const r = await handlePayPalWebhook(ctx, req.headers, await req.text());
    return json(r.body, r.status);
  }, { limit: "webhook" }),
  toRoute("POST", "/api/telegram/webhook", "public", async (req, ctx) => {
    const bot = (ctx as ReinsContext & { telegramBot?: Bot }).telegramBot;
    if (!bot) return json({ ok: false, error: "Telegram bot not configured" }, 503);
    return webhookCallback(bot, "std/http", { secretToken: process.env.TELEGRAM_WEBHOOK_SECRET })(req);
  }, { limit: "webhook" }),
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

export interface RouterOptions {
  adminToken?: string;
  cronSecret?: string;
  sseHeartbeatMs?: number;
  /** C1 public-demo lock; default REINS_PUBLIC_DEMO=1 at request time. */
  publicDemo?: boolean;
  /** M7 Origin check; default PUBLIC_BASE_URL, else RENDER_EXTERNAL_URL. */
  publicBaseUrl?: string;
  /** M1 per-IP buckets (tests inject their own). */
  rateLimiter?: RateLimiter;
  /**
   * Shared with reins-mcp (default REINS_MCP_MINT_SECRET): its keyless demo sessions mint their demo key through
   * /api/try/connect with this secret and skip the per-IP "connect" bucket (every session would otherwise share the
   * MCP server's address; reins-mcp applies its own per-client limit). Unset = no exemption.
   */
  mcpMintSecret?: string;
}

export function createRouter(getCtx: () => Promise<ReinsContext>, opts: RouterOptions = {}) {
  if (opts.sseHeartbeatMs) sseHeartbeatMs = opts.sseHeartbeatMs;
  const limiter = opts.rateLimiter ?? new RateLimiter();
  const isPublicDemo = () => opts.publicDemo ?? process.env.REINS_PUBLIC_DEMO === "1";
  // the owner with REINS_ADMIN_TOKEN can still administer a public deploy
  const locked = (req: Request) => isPublicDemo() && !hasAdminToken(req, opts.adminToken);
  const baseUrl = () => opts.publicBaseUrl ?? (process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || undefined);
  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const candidates = routes.filter((r) => r.pattern.test(url.pathname));
    if (!candidates.length) return json({ error: "not_found", message: "No such route" }, 404);
    const route = candidates.find((r) => r.method === req.method);
    if (!route) return json({ error: "method_not_allowed" }, 405);
    const match = route.pattern.exec(url.pathname)!;
    const params = Object.fromEntries(route.keys.map((k, i) => [k, match[i + 1]!]));
    try {
      const mintSecret = opts.mcpMintSecret ?? process.env.REINS_MCP_MINT_SECRET;
      const minting = route.limit === "connect" && !!mintSecret && safeEqual(req.headers.get("x-reins-mint-secret") ?? "", mintSecret);
      if (route.limit && !minting) {
        const wait = limiter.take(route.limit, clientIp(req));
        if (wait > 0) return new Response(JSON.stringify({ error: "rate_limited", message: "Too many requests. Try again in a few seconds." }), { status: 429, headers: { "content-type": "application/json; charset=utf-8", "retry-after": String(Math.ceil(wait / 1000)), "cache-control": "no-store" } });
      }
      if (route.auth === "admin") checkAdmin(req, opts.adminToken);
      if (route.auth === "cron") checkCron(req, opts.cronSecret);
      if (route.auth === "admin" && req.method !== "GET") {
        checkWrite(req, url, baseUrl());
        if (route.demo !== "allow" && locked(req)) throw new ReinsError(403, "public_demo", PUBLIC_DEMO_REFUSAL);
      }
      return await route.handler(req, await getCtx(), params, url, { locked: locked(req) });
    } catch (err) {
      if (err instanceof ReinsError) return json({ error: err.code, message: err.message }, err.status);
      console.error("[reins] unhandled", req.method, url.pathname, err instanceof Error ? err.message : "error");
      return json({ error: "internal", message: "Internal error" }, 500);
    }
  };
}
