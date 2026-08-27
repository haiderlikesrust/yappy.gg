import type { LiveDuration } from '@yappydotgg/bot-sdk';
import { card, nameOf, withMention } from '../cards.js';
import { formatClock, formatDuration, parseWhen } from '../clock.js';
import { say, type Command } from './types.js';

/** Shorter than this and the card is gone before anyone looks at it. */
const MIN_MS = 30_000;
/** Longer than this is a reminder, which is a different command. */
const MAX_MS = 6 * 3_600_000;

/** Rewrite often enough to feel live, rarely enough to stay under the edit
 *  limit. The SDK floors this at ten seconds regardless. */
function cadence(ms: number): LiveDuration {
  if (ms <= 3 * 60_000) return '10s';
  if (ms <= 20 * 60_000) return '30s';
  return '1m';
}

export const timer: Command = {
  name: 'timer',
  description: 'A countdown card that rewrites itself, then says when it is up',
  usage: '/timer 10m standup',

  async run(ctx) {
    if (!ctx.args) {
      await say(ctx, 'Usage: `/timer 10m standup`. Anything from 30 seconds to six hours.');
      return;
    }

    const when = parseWhen(ctx.args, ctx.zone);
    // A clock time is a reminder, not a timer — say so rather than counting
    // down for nine hours.
    if (!when || !when.said.startsWith('in ')) {
      await say(ctx, 'Give me a length, like `/timer 10m standup`. For a clock time use `/remind at 9pm …`.');
      return;
    }

    const total = when.at.getTime() - Date.now();
    if (total < MIN_MS) {
      await say(ctx, 'Half a minute is the shortest that is worth a card.');
      return;
    }
    if (total > MAX_MS) {
      await say(ctx, 'Six hours is the longest timer. Past that, `/remind` is the better tool.');
      return;
    }

    const label = when.rest || 'Timer';
    const endsAt = when.at.getTime();
    const userId = ctx.message.senderId ?? ctx.message.sender?.id ?? null;

    await ctx.bot.live(ctx.conversationId, {
      every: cadence(total),
      until: total,
      // The first post is the answer they asked for, so it notifies. Every
      // rewrite after it is an edit, and edits never push a phone.
      silent: false,
      replyToId: ctx.message.id,
      nonce: `timer_${ctx.message.id}`,
      render: async () => {
        const left = endsAt - Date.now();
        return {
          embeds: [
            card(label)
              .description(left > 0 ? `**${formatDuration(left)}** left` : 'Time is up.')
              .field('Ends', formatClock(ctx.zone, new Date(endsAt)), true)
              .field('Set for', formatDuration(total), true)
              .build(),
          ],
        };
      },
      onError: (err) => console.error('[timer] tick failed:', err),
    });

    // `live` stops rewriting at the deadline; something still has to say so out
    // loud, because a card that quietly stops changing is not an alarm.
    // Not unref'd: a pending alarm is a reason for this process to stay alive.
    setTimeout(
      () => {
        const done =
          userId !== null
            ? withMention(userId, nameOf(ctx.message.sender), `time is up — ${label}`)
            : { content: `Time is up — ${label}`, entities: [] };
        void ctx.bot
          .send(ctx.conversationId, {
            ...done,
            replyToId: ctx.message.id,
            nonce: `timerdone_${ctx.message.id}`,
          })
          .catch((err) => console.error('[timer] finish failed:', err));
      },
      Math.max(0, endsAt - Date.now()),
    );
  },
};
