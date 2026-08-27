import { randomInt } from 'node:crypto';
import { say, type Command } from './types.js';

export const pick: Command = {
  name: 'pick',
  description: 'Choose one, so nobody has to',
  usage: '/pick pizza | sushi | tacos',

  async run(ctx) {
    // `|` first, because "fish and chips, curry" is two options and
    // "fish, chips" written with commas is ambiguous. Commas are the fallback.
    const raw = ctx.args.includes('|') ? ctx.args.split('|') : ctx.args.split(',');
    const options = raw.map((o) => o.trim()).filter(Boolean);

    if (options.length < 2) {
      await say(ctx, 'Give me at least two: `/pick pizza | sushi | tacos`.');
      return;
    }
    if (options.length > 20) {
      await say(ctx, 'Twenty is plenty.');
      return;
    }

    // `randomInt`, not `Math.random`: this settles arguments, and the one
    // property it has to have is that nobody can predict it.
    const chosen = options[randomInt(options.length)]!;
    await say(ctx, `**${chosen}** — out of ${options.length}.`);
  },
};
