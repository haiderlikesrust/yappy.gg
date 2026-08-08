import { and, conversationMembers, conversations, eq, isNull, users } from '@yappy/db';
import type { FastifyInstance } from 'fastify';
import { claimGrant, confirmGrant, noteBadAttempt } from '../routes/portal.js';

/**
 * yapper — the first-party bot.
 *
 * Third-party bots receive events by holding a connection or a webhook, and
 * building that out is a real piece of work. yapper does not need it: it runs
 * inside this process, so a message addressed to it is dispatched directly
 * after the send transaction commits. Being first-party is the whole reason
 * that shortcut is legitimate, and it is deliberately not exposed as a
 * mechanism anyone else can use.
 *
 * It exists mainly to be the confirmation surface for developer-portal
 * sign-ins. See `device_grants` for why approval happens here rather than in
 * the browser.
 */

export const YAPPER_USERNAME = 'yapper';

const HELP = [
  "I'm yapper. I handle developer-portal sign-ins.",
  '',
  '  /login dev <code>   claim a code shown in the portal',
  '  /login yes          approve the request I described',
  '  /login no           reject it',
  '  /whoami             which account you are',
  '  /help               this',
].join('\n');

/** Cached after the first lookup: one row that never changes during a run. */
let cachedBotId: string | null = null;

export async function getYapperUserId(app: FastifyInstance): Promise<string | null> {
  if (cachedBotId) return cachedBotId;
  const [row] = await app.db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.username, YAPPER_USERNAME), eq(users.isBot, true), isNull(users.deletedAt)))
    .limit(1);
  cachedBotId = row?.id ?? null;
  return cachedBotId;
}

/**
 * Is this conversation a DM between the sender and yapper?
 *
 * Checked rather than assumed: yapper can be added to a group, and a command
 * typed there should be ignored rather than acted on in front of an audience.
 */
async function isYapperDm(app: FastifyInstance, conversationId: string, botId: string): Promise<boolean> {
  const [conversation] = await app.db
    .select({ type: conversations.type })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (conversation?.type !== 'dm') return false;

  const [member] = await app.db
    .select({ userId: conversationMembers.userId })
    .from(conversationMembers)
    .where(
      and(
        eq(conversationMembers.conversationId, conversationId),
        eq(conversationMembers.userId, botId),
        isNull(conversationMembers.leftAt),
      ),
    )
    .limit(1);
  return Boolean(member);
}

/**
 * Handle one message sent to yapper. Returns the reply text, or null if this
 * is not for the bot.
 *
 * Never throws into the caller: this runs after a message has already been
 * accepted, and a bot that fails must not turn a delivered message into an
 * error for the person who sent it.
 */
export async function handleYapperMessage(
  app: FastifyInstance,
  input: { conversationId: string; senderId: string; content: string | null },
): Promise<string | null> {
  const text = input.content?.trim();
  if (!text || !text.startsWith('/')) return null;

  const botId = await getYapperUserId(app);
  if (!botId || botId === input.senderId) return null;
  if (!(await isYapperDm(app, input.conversationId, botId))) return null;

  const [command, ...rest] = text.split(/\s+/);

  try {
    switch (command?.toLowerCase()) {
      case '/help':
        return HELP;

      case '/whoami': {
        const [me] = await app.db
          .select({ username: users.username, displayName: users.displayName })
          .from(users)
          .where(eq(users.id, input.senderId))
          .limit(1);
        return `You are ${me?.displayName ?? 'someone'} (@${me?.username ?? 'unknown'}).`;
      }

      case '/login': {
        const sub = rest[0]?.toLowerCase();

        if (sub === 'yes' || sub === 'approve') {
          const result = await confirmGrant(app.db, input.senderId, true);
          return result.message;
        }
        if (sub === 'no' || sub === 'deny') {
          const result = await confirmGrant(app.db, input.senderId, false);
          return result.message;
        }
        if (sub !== 'dev') {
          return 'Usage: /login dev <code>, then /login yes to approve.';
        }

        const code = rest[1];
        if (!code) return 'Give me the code the portal is showing: /login dev ABCD-EFGH';

        const claim = await claimGrant(app.db, input.senderId, code);
        if (!claim.ok) {
          await noteBadAttempt(app.db, input.senderId);
          return claim.reason;
        }

        // Everything the person needs in order to notice that this is not
        // them. A prompt that just says "approve sign-in?" is one people click
        // through; naming the browser and the address is what makes a
        // relayed code fail at the last step.
        return [
          'Someone is trying to sign in to the developer portal.',
          '',
          `  Client:  ${claim.description}`,
          `  Address: ${claim.ip ?? 'unknown'}`,
          '',
          'If that is you, reply  /login yes',
          'If it is not, reply  /login no  and change nothing else.',
        ].join('\n');
      }

      default:
        return `I don't know ${command}. Try /help.`;
    }
  } catch (err) {
    app.log.error({ err }, 'yapper command failed');
    return 'Something went wrong handling that. Try again in a moment.';
  }
}
