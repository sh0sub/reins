import { existsSync, readFileSync } from "node:fs";
import { setDefaultAutoSelectFamily } from "node:net";
import { resolve } from "node:path";
import { createDb, getActiveMandate, getAgent, getWorkspace, migrateDb, spendSinceCents, updateWorkspace } from "@reins/db";
import {
  ClaudeAuditor,
  ClaudeCategorySuggester,
  FakePayPalClient,
  HttpPayPalClient,
  MockAuditor,
  ReinsEvents,
  askAgent,
  decideRequest,
  expireStale,
  getLedgerRow,
  monthStartUtc,
  linkTelegramChat,
  type Notifier,
  type PayPalClient,
  type ReinsContext,
} from "@reins/core";
import { TelegramNotifier, createBot, grammyApi } from "@reins/bot";

type Env = Record<string, string | undefined>;

export function paypalFromEnv(env: Env): { client: PayPalClient; env: "sandbox" | "fake" } {
  if (env.PAYPAL_ENV !== "fake" && env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET) {
    return { client: new HttpPayPalClient({ clientId: env.PAYPAL_CLIENT_ID, clientSecret: env.PAYPAL_CLIENT_SECRET, env: "sandbox" }), env: "sandbox" };
  }
  if (env.PAYPAL_ENV !== "fake") console.warn("[reins] PAYPAL_CLIENT_ID/SECRET missing: using the in-memory fake PayPal client");
  return { client: new FakePayPalClient(), env: "fake" };
}

/** Builds the runtime context from environment variables (see .env.example). */
export async function createContextFromEnv(env: Env = process.env): Promise<ReinsContext> {
  const db = createDb(env.DATABASE_URL ?? "file:./.local/reins.db");
  await migrateDb(db, env.REINS_MIGRATIONS_DIR ?? resolve(process.cwd(), "../../packages/db/drizzle"));
  const paypal = paypalFromEnv(env);
  const ttlMinutes = Number(env.REINS_APPROVAL_TTL_MINUTES ?? 30);

  const ws = await getWorkspace(db);
  const mode = env.PAYPAL_PAYMENT_MODE as "vaulted" | "supervised" | "treasury" | undefined;
  // PAYPAL_PAYMENT_MODE seeds a fresh workspace. "vaulted" needs a saved vault_id (Setup step 2); without one
  // every automatic payment would fail, so fall back to supervised checkout until the vault exists.
  const seeded = mode === "vaulted" && !ws.vaultId ? "supervised" : mode;
  if (!ws.connectedAt && seeded && seeded !== ws.paymentMode) await updateWorkspace(db, { paymentMode: seeded });

  const ctx: ReinsContext = {
    db,
    paypal: paypal.client,
    auditor: env.ANTHROPIC_API_KEY ? new ClaudeAuditor({ apiKey: env.ANTHROPIC_API_KEY }) : new MockAuditor(),
    categorySuggester: env.ANTHROPIC_API_KEY ? new ClaudeCategorySuggester({ apiKey: env.ANTHROPIC_API_KEY }) : undefined,
    events: new ReinsEvents(),
    notifiers: [],
    now: Date.now,
    config: {
      publicBaseUrl: env.PUBLIC_BASE_URL ?? "http://localhost:3000",
      apiBaseUrl: env.REINS_API_URL ?? env.PUBLIC_BASE_URL ?? "http://localhost:3000",
      paypalWebhookId: env.PAYPAL_WEBHOOK_ID,
      treasuryPayeeEmail: env.TREASURY_PAYEE_EMAIL ?? null,
      vaultStoredCredential: env.PAYPAL_VAULT_STORED_CREDENTIAL === "1",
      approvalTtlMs: ttlMinutes * 60_000,
      explainDenials: env.REINS_EXPLAIN_DENIALS !== "0",
    },
  };

  if (env.TELEGRAM_BOT_TOKEN && telegramMode(env) !== "off") await wireTelegram(ctx, env, ttlMinutes);

  // Approval expiry timer (M9 "만료 타이머"): pending_human cards expire after REINS_APPROVAL_TTL_MINUTES and
  // the Telegram card is edited to "Expired". Also runs lazily before /api/inbox.
  const sweep = setInterval(() => void expireStale(ctx).catch(() => undefined), Number(env.REINS_EXPIRY_SWEEP_MS ?? 60_000));
  sweep.unref?.();
  return ctx;
}

/** Telegram mode: webhook when PUBLIC_BASE_URL is https (setWebhook done once), long polling otherwise (local dev). */
export function telegramMode(env: Env): "webhook" | "polling" | "off" {
  if (env.TELEGRAM_MODE === "off") return "off";
  if (env.TELEGRAM_MODE === "webhook" || env.TELEGRAM_MODE === "polling") return env.TELEGRAM_MODE;
  return /^https:\/\//.test(env.PUBLIC_BASE_URL ?? "") ? "webhook" : "polling";
}

async function wireTelegram(ctx: ReinsContext, env: Env, ttlMinutes: number) {
  const { db } = ctx;
  // Some networks (this dev Mac) have a broken IPv6 route to api.telegram.org; Node's happy-eyeballs then
  // times out. Sequential connect fixes it. Opt out with REINS_NET_AUTOSELECT=1.
  if (env.REINS_NET_AUTOSELECT !== "1") setDefaultAutoSelectFamily(false);

  // Dev convenience: a chat id captured by scripts/telegram-check.ts links the workspace if it is not linked yet.
  const chatFile = resolve(env.REINS_ROOT ?? resolve(process.cwd(), "../.."), ".local/telegram-chat-id.txt");
  if (!(await getWorkspace(db)).telegramChatId && existsSync(chatFile)) {
    const id = readFileSync(chatFile, "utf8").trim();
    if (/^-?\d+$/.test(id)) await updateWorkspace(db, { telegramChatId: id });
  }

  const bot = createBot(env.TELEGRAM_BOT_TOKEN!, {
    linkChat: (t, c) => linkTelegramChat(ctx, t, c),
    linkedChatId: async () => (await getWorkspace(db)).telegramChatId,
    decide: async (id, action, actor) => {
      await decideRequest(ctx, id, action, actor);
      return getLedgerRow(ctx, id);
    },
    ask: async (id, question, actor) => {
      await askAgent(ctx, id, question, actor);
      return getLedgerRow(ctx, id);
    },
    describe: async (id) => {
      const row = await getLedgerRow(ctx, id).catch(() => null);
      return row ? { agentName: row.agent_name, displayId: row.display_id } : null;
    },
  });
  const notifier: Notifier = new TelegramNotifier(grammyApi(bot), {
    linkedChatId: async () => (await getWorkspace(db)).telegramChatId,
    agentName: async (id) => (await getAgent(db, id))?.name ?? id,
    budget: async (agentId) => {
      const m = await getActiveMandate(db, agentId);
      return { monthSpentCents: await spendSinceCents(db, agentId, monthStartUtc(ctx.now())), monthlyLimitCents: m?.monthlyLimitCents ?? null };
    },
    webBaseUrl: env.PUBLIC_BASE_URL,
    ttlMinutes,
  });
  ctx.notifiers.push(notifier);
  (ctx as ReinsContext & { telegramBot?: unknown }).telegramBot = bot;

  if (telegramMode(env) === "polling") {
    // bot.start() deletes any webhook first, then long-polls; errors are logged without the token.
    bot.start({ drop_pending_updates: false, onStart: (me) => console.log(`[reins] Telegram @${me.username} polling`) }).catch((err: Error) =>
      console.error("[reins] Telegram polling stopped:", err.message.replace(/bot\d+:[\w-]+/g, "bot<redacted>")),
    );
  }
}

const g = globalThis as unknown as { __reinsCtx?: Promise<ReinsContext> };

/** Process-wide singleton (survives Next.js dev hot reloads). */
export function getContext(): Promise<ReinsContext> {
  g.__reinsCtx ??= createContextFromEnv();
  return g.__reinsCtx;
}
