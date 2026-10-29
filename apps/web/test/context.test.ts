import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getWorkspace } from "@reins/db";
import { createContextFromEnv, telegramMode } from "../src/server/context.ts";

const base = { DATABASE_URL: ":memory:", REINS_MIGRATIONS_DIR: resolve(__dirname, "../../../packages/db/drizzle"), PAYPAL_ENV: "fake" };

describe("runtime context from env", () => {
  it("regression (live 10/29): PAYPAL_PAYMENT_MODE=vaulted without a saved vault seeds supervised mode", async () => {
    const ctx = await createContextFromEnv({ ...base, PAYPAL_PAYMENT_MODE: "vaulted" });
    expect((await getWorkspace(ctx.db)).paymentMode).toBe("supervised");
  });
  it("other modes are seeded as given", async () => {
    const ctx = await createContextFromEnv({ ...base, PAYPAL_PAYMENT_MODE: "treasury" });
    expect((await getWorkspace(ctx.db)).paymentMode).toBe("treasury");
  });
  it("Telegram uses long polling locally and webhooks behind https", () => {
    expect(telegramMode({ PUBLIC_BASE_URL: "http://localhost:3000" })).toBe("polling");
    expect(telegramMode({ PUBLIC_BASE_URL: "https://reins-demo.onrender.com" })).toBe("webhook");
    expect(telegramMode({ PUBLIC_BASE_URL: "https://x.dev", TELEGRAM_MODE: "off" })).toBe("off");
  });
});
