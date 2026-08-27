import { button, row } from '@yappydotgg/bot-sdk';
import { nameOf } from '../cards.js';
import { parseWhen } from '../clock.js';
import { MAX_AHEAD_MS, confirmation } from '../reminders.js';
import { say, type Command } from './types.js';

export const remind: Command = {
  name: 'remind',
  description: 'Remind you of something later',
  usage: '/remind 20m take the pizza out',

  async run(ctx) {
    if (!ctx.args) {
      await say(ctx, 'Usage: `/remind 20m take the pizza out`, or `/remind at 9pm call mum`.');
      return;
    }

    const when = parseWhen(ctx.args, ctx.zone);
    if (!when) {
      await say(
        ctx,
        `I could not read a time in that. Try \`20m\`, \`1h30m\`, \`at 9pm\`, or \`tomorrow 8am\` — the time goes first, then what to remind you of.`,
      );
      return;
    }
    if (!when.rest) {
      await say(ctx, `Remind you of what? Try \`/remind ${ctx.args.trim()} feed the cat\`.`);
      return;
    }
    if (when.at.getTime() - Date.now() > MAX_AHEAD_MS) {
      await say(ctx, 'That is more than a month out. Past about that, a calendar is the right tool.');
      return;
    }

    const userId = ctx.message.senderId ?? ctx.message.sender?.id;
    if (!userId) return;

    const reminder = await ctx.reminders.add({
      conversationId: ctx.conversationId,
      userId,
      label: nameOf(ctx.message.sender),
      messageId: ctx.message.id,
      text: when.rest,
      dueAt: when.at.getTime(),
    });

    await ctx.bot.reply(ctx.conversationId, ctx.message.id, {
      embeds: [confirmation(reminder, when.said, ctx.zone)],
      // Only the person who set it can call it off. The server enforces this
      // at press time; the handler checks again on the way through.
      components: [
        row(button(`rem:cancel:${reminder.id}`, 'Cancel', 'secondary', { onlyUserId: userId })),
      ],
    });
  },
};
