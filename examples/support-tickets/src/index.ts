/**
 * A support desk in ninety lines.
 *
 * Posts one card with a button. Pressing it opens a private channel that only
 * the presser and the space's staff can see, admits any support agents you
 * name, says hello in there, and tells the presser where it went — privately,
 * so the room the button lives in learns nothing.
 *
 * This is the whole point of the install grant. The bot holds
 * MANAGE_CONVERSATION and MANAGE_ROLES and nothing else: it cannot kick, ban,
 * mute, or read a private channel it was not admitted to. It never has to be
 * promoted up the member ladder to do any of this.
 *
 *   YAPPY_BOT_TOKEN=... YAPPY_SPACE=... YAPPY_CHANNEL=... pnpm --filter @yappy/example-support-tickets start
 *
 * Optional: YAPPY_AGENTS as a comma-separated list of user ids to admit to
 * every ticket. Optional: YAPPY_API and YAPPY_GATEWAY to point at a local
 * stack instead of production.
 */
import { YappyBot, connectGateway } from '@yappydotgg/bot-sdk';

const token = required('YAPPY_BOT_TOKEN');
const spaceId = required('YAPPY_SPACE');
const homeChannel = required('YAPPY_CHANNEL');
const agents = (process.env.YAPPY_AGENTS ?? '').split(',').map((s) => s.trim()).filter(Boolean);

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is not set.`);
    process.exit(1);
  }
  return value;
}

const bot = new YappyBot({ token, baseUrl: process.env.YAPPY_API });

/**
 * One ticket per person at a time.
 *
 * Claimed *before* the channel is created, not after. The first version set
 * this once the create resolved, which is a check-then-act race with an await
 * in the middle: twenty rapid presses put twenty creates in flight before any
 * of them came back, and sixteen channels appeared. A button is the easiest
 * thing in the world to hold down.
 *
 * In memory, so a restart forgets — fine for an example, and the wrong answer
 * for a real desk, which should ask the server what channels already exist.
 * The platform now rate-limits channel creation regardless, so the worst a
 * gap here can cost is a handful of rooms rather than a space's whole budget.
 */
const open = new Map<string, string>();
const PENDING = '…';

const card = {
  content: null,
  embeds: [
    {
      title: 'Need a hand?',
      description:
        'Open a ticket and a private channel appears for you. Only you and the ' +
        'staff of this space will be able to see it.',
      color: '#8B7CFF',
      fields: [],
    },
  ],
  components: [
    {
      type: 'row' as const,
      components: [
        {
          type: 'button' as const,
          customId: 'ticket:open',
          label: 'Open a ticket',
          style: 'primary' as const,
        },
      ],
    },
  ],
};

const posted = await bot.send(homeChannel, card);
console.log(`Ticket desk is open. Card posted as ${posted.message.id}.`);

connectGateway(bot, {
  url: process.env.YAPPY_GATEWAY,
  onReady: () => console.log('Listening for presses.'),
  onError: (err) => console.error('handler failed:', err),

  async onInteraction({ customId, invoker }) {
    if (customId !== 'ticket:open') return;

    const existing = open.get(invoker.userId);
    if (existing) {
      return {
        kind: 'ephemeral',
        content:
          existing === PENDING
            ? 'Opening one for you now.'
            : `You already have a ticket open — it is in #${existing}.`,
      };
    }
    // Claim the slot synchronously, before the first await. Everything below
    // this line is a chance for a second press to overtake the first.
    open.set(invoker.userId, PENDING);

    try {
    const { user } = await bot.user(invoker.userId);
    const who = user.username ?? user.displayName ?? 'someone';
    const title = `ticket-${who}`.slice(0, 60);

    /*
     * Filed under "Tickets" as it is made.
     *
     * A bot that opens one channel per ticket is the fastest way there is to
     * turn a sidebar into a wall — six tickets in and the space's real rooms
     * are below the fold. `ensureCategory` is idempotent, so this survives a
     * restart without collecting a second "Tickets".
     *
     * Best-effort on purpose: filing is cosmetic and opening the ticket is
     * not, so a bot that cannot make categories still opens tickets — they
     * just land loose.
     */
    const categoryId = await bot.ensureCategory(spaceId, 'Tickets').catch(() => undefined);

    /*
     * One call: created, floored, filed, and the right people admitted, inside
     * a single transaction. The channel is never briefly readable by the
     * whole space, which a create-then-lock sequence could not promise.
     *
     * The bot admits itself implicitly by creating it. Everyone in `agents`
     * is admitted explicitly; the space's own moderators and admins can see
     * it regardless, because a lowered base does not hide anything from the
     * staff ladder — which is exactly what makes a ticket answerable.
     */
    const { channel } = await bot.createChannel(spaceId, {
      title,
      isPrivate: true,
      members: [invoker.userId, ...agents],
      categoryId,
    });
    open.set(invoker.userId, channel.title);

    const greeting = `Hi @${who} — tell us what you need and someone will pick this up.`;
    await bot.send(channel.id, {
      content: greeting,
      entities: [
        {
          type: 'mention',
          offset: greeting.indexOf(`@${who}`),
          length: who.length + 1,
          userId: invoker.userId,
        },
      ],
    });

    // Ephemeral, so the room full of people who did not press the button is
    // not told that this person opened a ticket.
    return {
      kind: 'ephemeral',
      content: `Opened #${channel.title} for you. Only you and the staff here can see it.`,
    };
    } catch (err) {
      // Release the claim, or a failed create locks this person out of ever
      // opening one for the life of the process.
      open.delete(invoker.userId);
      throw err;
    }
  },
});
