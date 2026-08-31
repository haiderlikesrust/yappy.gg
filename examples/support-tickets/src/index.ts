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

/** One ticket per person at a time, so a double-tap does not open two. */
const open = new Map<string, string>();

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
        content: `You already have a ticket open — it is in #${existing}.`,
      };
    }

    const { user } = await bot.user(invoker.userId);
    const who = user.username ?? user.displayName ?? 'someone';
    const title = `ticket-${who}`.slice(0, 60);

    /*
     * One call: created, floored, and the right people admitted, inside a
     * single transaction. The channel is never briefly readable by the
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
  },
});
