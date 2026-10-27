import { Bot, InlineKeyboard } from "grammy";
import type { Card } from "./cards.ts";
import { handleDecisionCallback, handleStart, type BotDeps } from "./handlers.ts";
import type { TelegramApi } from "./notifier.ts";

function keyboard(card: Card): InlineKeyboard | undefined {
  if (!card.buttons.length) return undefined;
  const kb = new InlineKeyboard();
  card.buttons.forEach((row, i) => {
    for (const b of row) {
      if (b.url) kb.url(b.text, b.url);
      else if (b.callback_data) kb.text(b.text, b.callback_data);
    }
    if (i < card.buttons.length - 1) kb.row();
  });
  return kb;
}

/** grammY wiring only; all behaviour lives in handlers.ts. Not started here (needs TELEGRAM_BOT_TOKEN). */
export function createBot(token: string, deps: BotDeps): Bot {
  const bot = new Bot(token);
  bot.command("start", async (ctx) => {
    await ctx.reply(await handleStart(deps, String(ctx.chat.id), ctx.match || undefined));
  });
  bot.on("callback_query:data", async (ctx) => {
    await handleDecisionCallback(deps, String(ctx.chat?.id ?? ""), ctx.callbackQuery.data, {
      answer: async (text) => {
        await ctx.answerCallbackQuery(text ? { text } : undefined);
      },
      edit: async (card) => {
        await ctx.editMessageText(card.text, { reply_markup: keyboard(card) ?? { inline_keyboard: [] } });
      },
    });
  });
  return bot;
}

export function grammyApi(bot: Bot): TelegramApi {
  return {
    async send(chatId, card) {
      const m = await bot.api.sendMessage(chatId, card.text, { reply_markup: keyboard(card) });
      return { messageId: m.message_id };
    },
    async edit(chatId, messageId, card) {
      await bot.api.editMessageText(chatId, messageId, card.text, { reply_markup: keyboard(card) ?? { inline_keyboard: [] } });
    },
  };
}
