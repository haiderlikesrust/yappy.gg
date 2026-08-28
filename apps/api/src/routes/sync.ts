import { and, conversationMembers, conversations, eq, isNull, sql as raw } from '@yappy/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

/**
 * Delta sync.
 *
 * This endpoint is what makes the app feel instant after a cold start or a
 * spell offline, and it is the reason the realtime layer is allowed to be
 * best-effort. The client sends the highest `seq` it holds per conversation;
 * the server returns only what changed.
 *
 * Two properties make it cheap:
 *   • `conversations.message_seq` is the authoritative head, so deciding
 *     whether a conversation changed is an integer comparison, not a query
 *     against the message table.
 *   • The client's cursors arrive in one request, so this is one round trip
 *     regardless of how many conversations the user is in.
 */

const syncBody = z.object({
  /** Highest seq the client holds, per conversation. Omit a conversation to
   *  say "I have nothing" — it will come back with its recent tail. */
  cursors: z
    .array(z.object({ conversationId: z.string().uuid(), seq: z.coerce.number().int().nonnegative() }))
    .max(1_000)
    .default([]),
  /** Cap on messages returned per conversation. Beyond this the client is told
   *  to page normally rather than being handed a huge payload. */
  messagesPerConversation: z.coerce.number().int().min(0).max(100).default(30),
  /** Conversations changed since this timestamp are included even if their
   *  seq did not move (title change, member left, mute state). */
  since: z.string().datetime({ offset: true }).optional(),
});

export async function syncRoutes(app: FastifyInstance) {
  app.post('/', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const body = syncBody.parse(req.body ?? {});
    const cursorMap = new Map(body.cursors.map((c) => [c.conversationId, c.seq]));

    const memberships = await app.db
      .select({ conversation: conversations, member: conversationMembers })
      .from(conversationMembers)
      .innerJoin(conversations, eq(conversations.id, conversationMembers.conversationId))
      .where(
        and(
          eq(conversationMembers.userId, req.user.id),
          isNull(conversationMembers.leftAt),
          isNull(conversations.deletedAt),
          // Hidden chats are left out deliberately, which means a client that
          // still has one cached is told below that it is gone. That is the
          // behaviour we want: hiding has to reach devices whose build has
          // never heard of hiding, and "removed" is the only word every
          // version of the client already understands.
          eq(conversationMembers.isHidden, false),
        ),
      );

    const currentIds = new Set(memberships.map((m) => m.conversation.id));

    // Conversations the client still has cached but is no longer part of.
    const removed = [...cursorMap.keys()].filter((id) => !currentIds.has(id));

    const sinceDate = body.since ? new Date(body.since) : null;

    const changed = memberships.filter(({ conversation, member }) => {
      const cursor = cursorMap.get(conversation.id);
      if (cursor === undefined) return true; // client has never seen it
      if (conversation.messageSeq > cursor) return true;
      if (sinceDate && conversation.updatedAt > sinceDate) return true;
      if (sinceDate && member.joinedAt > sinceDate) return true;
      return false;
    });

    const conversationViews = await app.conversations.list(req.user.id, {
      limit: 200,
      archived: false,
    });
    const viewById = new Map(conversationViews.conversations.map((c) => [c.id, c]));

    // Fetch the tail of each changed conversation in parallel, bounded.
    const slices = await Promise.all(
      changed.slice(0, 200).map(async ({ conversation, member }) => {
        const cursor = cursorMap.get(conversation.id);
        const gap = cursor === undefined ? body.messagesPerConversation : conversation.messageSeq - cursor;

        if (body.messagesPerConversation === 0 || gap <= 0) {
          return { conversationId: conversation.id, messages: [], truncated: false };
        }

        // A gap larger than the cap means the client fell too far behind to
        // stream; it is told to page from `latestSeq` instead.
        const truncated = gap > body.messagesPerConversation;
        const result = await app.messages.history(req.user.id, conversation.id, {
          limit: Math.min(gap, body.messagesPerConversation),
          ...(cursor !== undefined && !truncated ? { after: Math.max(cursor, member.historyStartSeq) } : {}),
          includeDeleted: cursor !== undefined,
        });

        return { conversationId: conversation.id, messages: result.messages, truncated };
      }),
    );

    const unread = (await app.db.execute(
      raw`select conversation_id, unread_count, mention_count
            from conversation_unread
           where user_id = ${req.user.id}::uuid`,
    )) as unknown as Array<{ conversation_id: string; unread_count: number; mention_count: number }>;

    return reply.send({
      serverTime: new Date().toISOString(),
      conversations: changed
        .map((c) => viewById.get(c.conversation.id))
        .filter((v): v is NonNullable<typeof v> => Boolean(v)),
      messages: slices.filter((s) => s.messages.length > 0),
      removedConversations: removed,
      unread: unread.map((u) => ({
        conversationId: u.conversation_id,
        unreadCount: u.unread_count,
        mentionCount: u.mention_count,
      })),
      // The client should do a full refetch rather than trust this delta.
      resyncRequired: changed.length > 200,
    });
  });

  /** App badge in one query, for cold start and background refresh. */
  app.get('/badge', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const rows = (await app.db.execute(
      raw`select
            coalesce(sum(case when notification_level <> 'none'
                               and (muted_until is null or muted_until < now())
                          then unread_count else 0 end), 0)::int as unread,
            coalesce(sum(mention_count), 0)::int as mentions,
            count(*) filter (where unread_count > 0)::int as conversations
          from conversation_unread
         where user_id = ${req.user.id}::uuid`,
    )) as unknown as Array<{ unread: number; mentions: number; conversations: number }>;

    const row = rows[0] ?? { unread: 0, mentions: 0, conversations: 0 };
    return reply.send({
      unreadMessages: row.unread,
      unreadMentions: row.mentions,
      unreadConversations: row.conversations,
    });
  });
}
