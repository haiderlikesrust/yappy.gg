import type { IncomingMessage, YappyBot } from '@yappydotgg/bot-sdk';
import type { Reminders } from '../reminders.js';

export interface Ctx {
  bot: YappyBot;
  conversationId: string;
  message: IncomingMessage;
  /** Everything after the command word, trimmed. */
  args: string;
  reminders: Reminders;
  /** The zone this bot thinks in when nobody says otherwise. */
  zone: string;
}

export interface Command {
  name: string;
  description: string;
  usage?: string;
  run(ctx: Ctx): Promise<void>;
}

/** A short reply to the message that asked. Every command answers in place. */
export function say(ctx: Ctx, content: string): Promise<unknown> {
  return ctx.bot.reply(ctx.conversationId, ctx.message.id, { content });
}
