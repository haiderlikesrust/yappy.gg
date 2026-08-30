import { card } from '../cards.js';
import { chart } from './chart.js';
import { list } from './list.js';
import { pick } from './pick.js';
import { remind } from './remind.js';
import { time } from './time.js';
import { timer } from './timer.js';
import type { Command, Ctx } from './types.js';

const help: Command = {
  name: 'help',
  description: 'What this bot can do',
  usage: '/help',

  async run(ctx: Ctx) {
    const embed = card('Utility bot');
    for (const command of ORDER) {
      embed.field(command.usage ?? `/${command.name}`, command.description);
    }
    await ctx.bot.reply(ctx.conversationId, ctx.message.id, { embeds: [embed.build()] });
  },
};

/** Reading order, which is also the order `/help` prints. */
const ORDER: Command[] = [remind, list, timer, time, chart, pick, help];

export const COMMANDS = new Map<string, Command>(ORDER.map((c) => [c.name, c]));

/** What the composer is told, so `/rem…` autocompletes before the bot has
 *  ever spoken in that group. */
export const DECLARATIONS = ORDER.map((c) => ({
  name: c.name,
  description: c.description,
  ...(c.usage ? { usage: c.usage } : {}),
}));

export type { Command, Ctx } from './types.js';
