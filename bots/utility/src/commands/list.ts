import { button, row } from '@yappydotgg/bot-sdk';
import { card } from '../cards.js';
import { formatDuration, formatStamp } from '../clock.js';
import { say, type Command } from './types.js';

/** Five is what fits in one row of buttons, and more than anyone has pending. */
const SHOWN = 5;

export const list: Command = {
  name: 'reminders',
  description: 'What you have pending, and a way to call it off',
  usage: '/reminders',

  async run(ctx) {
    const userId = ctx.message.senderId ?? ctx.message.sender?.id;
    if (!userId) return;

    const mine = ctx.reminders.list(userId);
    if (mine.length === 0) {
      await say(ctx, 'Nothing pending. `/remind 20m something` sets one.');
      return;
    }

    const shown = mine.slice(0, SHOWN);
    const embed = card(mine.length === 1 ? 'Your reminder' : `Your reminders (${mine.length})`);
    shown.forEach((reminder, i) => {
      embed.field(
        `${i + 1}. ${formatStamp(ctx.zone, new Date(reminder.dueAt))}`,
        `${reminder.text} — in ${formatDuration(reminder.dueAt - Date.now())}`,
      );
    });
    if (mine.length > shown.length) {
      embed.footer(`${mine.length - shown.length} more not shown`);
    }

    await ctx.bot.reply(ctx.conversationId, ctx.message.id, {
      embeds: [embed.build()],
      components: [
        row(
          ...shown.map((reminder, i) =>
            button(`rem:cancel:${reminder.id}`, `Cancel ${i + 1}`, 'secondary', { onlyUserId: userId }),
          ),
        ),
      ],
    });
  },
};
