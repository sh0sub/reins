import { Bot, InlineKeyboard } from "grammy";
import type { Card } from "./cards.ts";
import { handleAskReply, handleDecisionCallback, handleStart, isNotModified, type BotDeps } from "./handlers.ts";
import type { TelegramApi } from "./notifier.ts";

/** Opt-in trace (REINS_TELEGRAM_LOG=1): Bot API method + first line of the card. Never logs chat ids or tokens. */
function trace(method: string, card: Card) {
  if (process.env.REINS_TELEGRAM_LOG === "1") console.log(`[reins-bot] ${method}: ${card.text.split("\n")[0]}`);
}

export function keyboard(card: Card): InlineKeyboard | undefined {
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
  /** force-reply prompt message id -> request id (S2 Ask agent from Telegram). In memory only. */
  const askPrompts = new Map<number, string>();
  bot.command("start", async (ctx) => {
    await ctx.reply(await handleStart(deps, String(ctx.chat.id), ctx.match || undefined));
  });
  bot.on("callback_query:data", async (ctx) => {
    const chatId = String(ctx.chat?.id ?? "");
    const r = await handleDecisionCallback(deps, chatId, ctx.callbackQuery.data, {
      answer: async (text) => {
        await ctx.answerCallbackQuery(text ? { text } : undefined).catch(() => undefined);
      },
      edit: async (card) => {
        trace("callback edit", card);
        await ctx.editMessageText(card.text, { reply_markup: keyboard(card) ?? { inline_keyboard: [] } });
      },
      prompt: async (text) => (await ctx.reply(text, { reply_markup: { force_reply: true, input_field_placeholder: "Your question" } })).message_id,
    });
    if (r && r.askPrompt) {
      askPrompts.set(r.askPrompt.messageId, r.askPrompt.requestId);
      if (askPrompts.size > 200) askPrompts.delete(askPrompts.keys().next().value!);
    }
  });
  bot.on("message:text", async (ctx) => {
    const replyTo = ctx.message.reply_to_message?.message_id;
    const requestId = replyTo ? askPrompts.get(replyTo) : undefined;
    if (!requestId) return;
    askPrompts.delete(replyTo!);
    await ctx.reply(await handleAskReply(deps, String(ctx.chat.id), requestId, ctx.message.text));
  });
  bot.catch((err) => console.error("[reins-bot]", err.message.replace(/bot\d+:[\w-]+/g, "bot<redacted>")));
  return bot;
}

export function grammyApi(bot: Bot): TelegramApi {
  return {
    async send(chatId, card) {
      trace("send", card);
      const m = await bot.api.sendMessage(chatId, card.text, { reply_markup: keyboard(card) });
      return { messageId: m.message_id };
    },
    async edit(chatId, messageId, card) {
      trace("notifier edit", card);
      try {
        await bot.api.editMessageText(chatId, messageId, card.text, { reply_markup: keyboard(card) ?? { inline_keyboard: [] } });
      } catch (err) {
        if (!isNotModified(err)) throw err; // identical content = already up to date
      }
    },
  };
}
