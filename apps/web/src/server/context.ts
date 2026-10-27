import { resolve } from "node:path";
import { createDb, getAgent, getWorkspace, migrateDb, updateWorkspace } from "@reins/db";
import {
  ClaudeAuditor,
  ClaudeCategorySuggester,
  FakePayPalClient,
  HttpPayPalClient,
  MockAuditor,
  ReinsEvents,
  decideRequest,
  getLedgerRow,
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
  if (!ws.connectedAt && mode && mode !== ws.paymentMode) await updateWorkspace(db, { paymentMode: mode });

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

  if (env.TELEGRAM_BOT_TOKEN) {
    const bot = createBot(env.TELEGRAM_BOT_TOKEN, {
      linkChat: (t, c) => linkTelegramChat(ctx, t, c),
      linkedChatId: async () => (await getWorkspace(db)).telegramChatId,
      decide: async (id, action, actor) => {
        await decideRequest(ctx, id, action, actor);
        return getLedgerRow(ctx, id);
      },
    });
    const notifier: Notifier = new TelegramNotifier(grammyApi(bot), {
      linkedChatId: async () => (await getWorkspace(db)).telegramChatId,
      agentName: async (id) => (await getAgent(db, id))?.name ?? id,
      ttlMinutes,
    });
    ctx.notifiers.push(notifier);
    (ctx as ReinsContext & { telegramBot?: unknown }).telegramBot = bot;
  }
  return ctx;
}

const g = globalThis as unknown as { __reinsCtx?: Promise<ReinsContext> };

/** Process-wide singleton (survives Next.js dev hot reloads). */
export function getContext(): Promise<ReinsContext> {
  g.__reinsCtx ??= createContextFromEnv();
  return g.__reinsCtx;
}
