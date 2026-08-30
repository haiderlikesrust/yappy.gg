import { card } from '../cards.js';
import { WORLD, formatClock, parseWhen, resolveZone } from '../clock.js';
import { say, type Command } from './types.js';

export const time: Command = {
  name: 'time',
  description: 'What time that is everywhere else',
  usage: '/time 3pm PT',

  async run(ctx) {
    let at = new Date();
    let heading = 'Right now';

    if (ctx.args) {
      // A bare zone — "/time Tokyo" — is "what time is it there", which is what
      // people mean far more often than they mean a conversion.
      const bare = resolveZone(ctx.args.trim());
      if (bare) {
        await ctx.bot.reply(ctx.conversationId, ctx.message.id, {
          embeds: [
            card(`It is ${formatClock(bare, at)} in ${ctx.args.trim()}`)
              .footer(bare)
              .build(),
          ],
        });
        return;
      }

      const when = parseWhen(ctx.args, ctx.zone);
      if (!when || when.said.startsWith('in ')) {
        await say(ctx, 'Try `/time 3pm PT`, `/time 09:30`, or a place: `/time Tokyo`.');
        return;
      }
      at = when.at;
      // Head the card with the time they asked about, in the zone they asked
      // in — "10:00 PM UTC" is a true answer to a question nobody asked.
      heading = when.said.replace(/^at\s+/, '');
    }

    const embed = card(heading);
    for (const place of WORLD) {
      embed.field(place.label, formatClock(place.zone, at), true);
    }

    await ctx.bot.reply(ctx.conversationId, ctx.message.id, { embeds: [embed.build()] });
  },
};
