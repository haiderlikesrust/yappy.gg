import { conversations, eq, users, verificationRequests } from '@yappy/db';
import { conflict, newId, notFound, type EmbedInput } from '@yappy/shared';
import type { FastifyInstance } from 'fastify';
import { getSystemConversationId } from './staffspace.js';
import { getYapperUserId } from './yapper.js';

const VIOLET = '#8b7cff';

/**
 * A group asking for its badge.
 *
 * The request is a queue row plus a card in front of staff — approval itself
 * stays a human act, done with `/badge <group-id> verified`, which is the same
 * command that can grant a badge unprompted. This file only carries the ask.
 *
 * The gate (owner or admin of the group, and only a group) lives in the route,
 * next to every other membership gate. What is enforced *here* is the part a
 * race could break: one open request per group, by unique index rather than by
 * checking first — two admins tapping send together must produce one card,
 * not two.
 */
export async function fileVerificationRequest(
  app: FastifyInstance,
  input: {
    conversationId: string;
    requesterId: string;
    purpose: string;
    link: string | null;
    note: string | null;
  },
): Promise<void> {
  const [conversation] = await app.db
    .select({
      title: conversations.title,
      badge: conversations.badge,
      memberCount: conversations.memberCount,
    })
    .from(conversations)
    .where(eq(conversations.id, input.conversationId))
    .limit(1);

  if (!conversation) throw notFound('Conversation');
  // Nothing to ask for. Said specifically, because "request failed" on a
  // group that is already verified reads as a bug rather than an answer.
  if (conversation.badge) throw conflict('This group is already verified');

  try {
    await app.db.insert(verificationRequests).values({
      id: newId(),
      conversationId: input.conversationId,
      requesterId: input.requesterId,
      purpose: input.purpose,
      link: input.link,
      note: input.note,
    });
  } catch (err) {
    // The partial unique index: an open request already exists. The person
    // asking twice is told the truth — it is in the queue — not given an
    // error to worry about.
    if ((err as { code?: string }).code === '23505') {
      throw conflict('Already requested — it is in the queue');
    }
    throw err;
  }

  // Best-effort, after the row is safe: the card is the notification, the row
  // is the request. A missing staff space must never lose the ask.
  try {
    await postVerificationCard(app, input, conversation.title, conversation.memberCount);
  } catch (err) {
    app.log.warn({ err }, 'verification card failed to post');
  }
}

async function postVerificationCard(
  app: FastifyInstance,
  input: { conversationId: string; requesterId: string; purpose: string; link: string | null; note: string | null },
  title: string | null,
  memberCount: number,
): Promise<void> {
  const channelId = await getSystemConversationId(app, 'staff_reports');
  const botId = await getYapperUserId(app);
  if (!channelId || !botId) return;

  const [requester] = await app.db
    .select({ name: users.displayName, handle: users.username })
    .from(users)
    .where(eq(users.id, input.requesterId))
    .limit(1);

  const embeds: EmbedInput[] = [
    {
      title: `Verification request · ${title ?? 'A group'}`,
      description: input.purpose,
      color: VIOLET,
      fields: [
        { name: 'From', value: requester?.name ?? requester?.handle ?? 'Someone', inline: true },
        { name: 'Members', value: String(memberCount), inline: true },
        ...(input.link ? [{ name: 'Link', value: input.link, inline: false }] : []),
        ...(input.note ? [{ name: 'Why', value: input.note, inline: false }] : []),
        // The id is the action: /badge takes it verbatim. On the card rather
        // than behind a lookup, so approving is copy, paste, done.
        { name: 'Approve with', value: `/badge ${input.conversationId} verified`, inline: false },
      ],
    },
  ];

  // Nonce'd on the conversation: pg-boss may retry whatever enqueued us, and
  // one request must stay one card. Same shape staffspace's own cards use.
  await app.messages.send(botId, channelId, {
    nonce: `verify_${input.conversationId}`,
    type: 'text',
    content: null,
    embeds,
    silent: false,
  } as never);
}
