import {
  and,
  conversationMembers,
  conversations,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  media,
  messageAttachments,
  messageReactions,
  messages,
  pinnedMessages,
  pollOptions,
  polls,
  pollVotes,
  sql as raw,
  users,
} from '@yappy/db';
import {
  Event,
  LIMITS,
  Permission,
  conflict,
  deleteMessageQuery,
  editMessageBody,
  forwardMessagesBody,
  messageHistoryQuery,
  newId,
  notFound,
  pollVoteBody,
  reactionBody,
  readAckBody,
  sendMessageBody,
  unprocessable,
} from '@yappy/shared';
import type { FastifyInstance } from 'fastify';
import { materialiseChannelMember, requireMember, requirePermission } from '../lib/access.js';
import { txExecutor } from '../lib/events.js';
import { toMember, toPublicUser } from '../lib/serialize.js';

/**
 * Messages and everything attached to one: reactions, pins, polls, read state.
 *
 * Mounted under /conversations so the URL reflects the ownership — a message id
 * is only meaningful inside its conversation, and routing it that way means the
 * membership check happens before anything else.
 */
export async function messageRoutes(app: FastifyInstance) {
  // ── History & send ────────────────────────────────────────────────────────

  app.get('/:id/messages', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = messageHistoryQuery.parse(req.query);
    return reply.send(await app.messages.history(req.user.id, id, query));
  });

  app.post('/:id/messages', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = sendMessageBody.parse(req.body);
    await app.limiter.consume(`user:${req.user.id}`, 'message.send');

    const result = await app.messages.send(req.user.id, id, body);
    // 200 rather than 201 on an idempotent replay, so the client can tell a
    // retry from a genuine new send.
    return reply.status(result.created ? 201 : 200).send({ message: result.message });
  });

  app.get('/:id/messages/:messageId', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { messageId } = req.params as { messageId: string };
    return reply.send({ message: await app.messages.get(req.user.id, messageId) });
  });

  app.patch('/:id/messages/:messageId', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { messageId } = req.params as { messageId: string };
    const body = editMessageBody.parse(req.body);
    await app.limiter.consume(`user:${req.user.id}`, 'message.edit');
    return reply.send({
      message: await app.messages.edit(req.user.id, messageId, body.content ?? null, body.entities),
    });
  });

  app.delete('/:id/messages/:messageId', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { messageId } = req.params as { messageId: string };
    const { forEveryone } = deleteMessageQuery.parse(req.query);
    await app.limiter.consume(`user:${req.user.id}`, 'message.delete');
    return reply.send(await app.messages.remove(req.user.id, messageId, forEveryone));
  });

  /** Thread view: every reply under one root, oldest first. */
  app.get('/:id/messages/:messageId/thread', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id, messageId } = req.params as { id: string; messageId: string };
    const { limit, after } = messageHistoryQuery.parse(req.query);
    await requirePermission(app.db, id, req.user.id, Permission.READ_HISTORY);

    const rows = await app.db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, id),
          eq(messages.threadRootId, messageId),
          isNull(messages.deletedAt),
          after !== undefined ? raw`${messages.seq} > ${after}` : undefined,
        ),
      )
      .orderBy(messages.seq)
      .limit(limit);

    return reply.send({
      messages: await app.messages.hydrateMany(rows, req.user.id),
      hasMore: rows.length === limit,
    });
  });

  /**
   * Forwarding.
   *
   * Implemented as a fresh send into each target rather than a pointer to the
   * original: the original may later be deleted, and a forwarded copy that
   * vanishes from an unrelated conversation is surprising. Attribution is kept
   * on the copy unless the sender opts out.
   */
  app.post('/messages/forward', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const body = forwardMessagesBody.parse(req.body);
    await app.limiter.consume(`user:${req.user.id}`, 'message.forward', body.toConversationIds.length);

    const sources = await app.db
      .select()
      .from(messages)
      .where(and(inArray(messages.id, body.messageIds), isNull(messages.deletedAt)));

    if (sources.length === 0) throw notFound('Message');

    // You can only forward out of conversations you can read.
    for (const conversationId of [...new Set(sources.map((s) => s.conversationId))]) {
      await requirePermission(app.db, conversationId, req.user.id, Permission.READ_HISTORY);
    }

    const attachmentRows = await app.db
      .select({
        messageId: messageAttachments.messageId,
        mediaId: messageAttachments.mediaId,
        position: messageAttachments.position,
      })
      .from(messageAttachments)
      .where(inArray(messageAttachments.messageId, body.messageIds))
      .orderBy(messageAttachments.position);

    const attachmentsBySource = new Map<string, string[]>();
    for (const a of attachmentRows) {
      const list = attachmentsBySource.get(a.messageId) ?? [];
      list.push(a.mediaId);
      attachmentsBySource.set(a.messageId, list);
    }

    const results: Array<{ conversationId: string; messageIds: string[] }> = [];

    for (const targetId of body.toConversationIds) {
      const created: string[] = [];
      const ordered = body.messageIds
        .map((id) => sources.find((s) => s.id === id))
        .filter((s): s is (typeof sources)[number] => Boolean(s));

      for (const source of ordered) {
        const sent = await app.messages.send(req.user.id, targetId, {
          nonce: `fwd_${source.id}_${targetId}`.slice(0, 64),
          type: source.type === 'system' || source.type === 'call' ? 'text' : source.type,
          content: source.content,
          entities: (source.entities ?? undefined) as never,
          // The media rows are shared; ref-counting keeps them alive as long as
          // any copy references them.
          attachmentIds: attachmentsBySource.get(source.id),
          stickerId: source.stickerId,
          gif: source.gif as never,
          location: source.location as never,
          contact: source.contact as never,
          silent: false,
        } as never);
        created.push(sent.message.id);

        if (!body.hideSender && source.senderId) {
          await app.db
            .update(messages)
            .set({ forwardedFromMessageId: source.id, forwardedFromUserId: source.senderId })
            .where(eq(messages.id, sent.message.id));
        }
      }

      if (body.comment) {
        await app.messages.send(req.user.id, targetId, {
          nonce: `fwdc_${newId()}`.slice(0, 64),
          type: 'text',
          content: body.comment,
          silent: false,
        } as never);
      }

      results.push({ conversationId: targetId, messageIds: created });
    }

    return reply.status(201).send({ forwarded: results });
  });

  // ── Read state ────────────────────────────────────────────────────────────

  /**
   * Read acknowledgement.
   *
   * Monotonic: a cursor never moves backwards, because two devices ack out of
   * order all the time and the lower one must not resurrect unread badges.
   */
  app.post('/:id/read', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { seq } = readAckBody.parse(req.body);
    const ctx = await requireMember(app.db, id, req.user.id);

    if (seq <= ctx.member.lastReadSeq) {
      return reply.send({ lastReadSeq: ctx.member.lastReadSeq, unreadCount: Math.max(0, ctx.conversation.messageSeq - ctx.member.lastReadSeq) });
    }

    const capped = Math.min(seq, ctx.conversation.messageSeq);
    if (ctx.memberIsVirtual) await materialiseChannelMember(app.db, id, req.user.id);
    const [updated] = await app.db
      .update(conversationMembers)
      .set({
        lastReadSeq: capped,
        lastDeliveredSeq: raw`greatest(${conversationMembers.lastDeliveredSeq}, ${capped})`,
        lastReadAt: new Date(),
      })
      .where(
        and(eq(conversationMembers.conversationId, id), eq(conversationMembers.userId, req.user.id)),
      )
      .returning();

    // Other members see the receipt only if this user has receipts enabled.
    if (req.user.privacy.readReceipts) {
      await app.events.toConversation(id, Event.ReadReceipt, {
        conversationId: id,
        userId: req.user.id,
        seq: capped,
        readAt: new Date().toISOString(),
      });
    }
    // The user's own devices always sync, receipts setting or not.
    await app.events.toUser(req.user.id, Event.ConversationStateUpdate, {
      conversationId: id,
      lastReadSeq: capped,
      unreadCount: Math.max(0, ctx.conversation.messageSeq - capped),
      mentionCount: updated!.mentionCount,
    });

    return reply.send({
      lastReadSeq: capped,
      unreadCount: Math.max(0, ctx.conversation.messageSeq - capped),
      mentionCount: updated!.mentionCount,
    });
  });

  /** Who has read up to where — the "seen by" sheet in a group. */
  app.get('/:id/receipts', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { seq } = req.query as { seq?: string };
    await requireMember(app.db, id, req.user.id);

    const target = seq ? Number(seq) : 0;
    const rows = await app.db
      .select({
        member: conversationMembers,
        user: users,
        avatarKey: media.objectKey,
      })
      .from(conversationMembers)
      .innerJoin(users, eq(users.id, conversationMembers.userId))
      .leftJoin(media, eq(media.id, users.avatarMediaId))
      .where(
        and(
          eq(conversationMembers.conversationId, id),
          isNull(conversationMembers.leftAt),
          raw`${conversationMembers.lastReadSeq} >= ${target}`,
          // Someone who disabled read receipts is not listed.
          raw`${users.privacy} ->> 'readReceipts' = 'true'`,
        ),
      )
      .limit(200);

    return reply.send({
      readBy: rows.map((r) => ({
        user: toPublicUser(r.user, r.avatarKey),
        seq: r.member.lastReadSeq,
        readAt: r.member.lastReadAt?.toISOString() ?? null,
      })),
    });
  });

  // ── Reactions ─────────────────────────────────────────────────────────────

  app.put('/:id/messages/:messageId/reactions', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id, messageId } = req.params as { id: string; messageId: string };
    const body = reactionBody.parse(req.body);
    await requirePermission(app.db, id, req.user.id, Permission.ADD_REACTIONS);
    await app.limiter.consume(`user:${req.user.id}`, 'reaction.add');

    const key = body.emoji ?? `sticker:${body.stickerId}`;

    const [message] = await app.db
      .select({ id: messages.id, conversationId: messages.conversationId, reactionCounts: messages.reactionCounts, deletedAt: messages.deletedAt })
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1);
    if (!message || message.conversationId !== id) throw notFound('Message');
    if (message.deletedAt) throw unprocessable('Cannot react to a deleted message');

    const distinct = Object.keys(message.reactionCounts);
    if (!distinct.includes(key) && distinct.length >= LIMITS.reactionsPerMessage) {
      throw conflict('This message has too many different reactions');
    }

    await app.db
      .insert(messageReactions)
      .values({ messageId, userId: req.user.id, emoji: key })
      .onConflictDoNothing();

    await app.events.toConversation(id, Event.ReactionAdd, {
      conversationId: id,
      messageId,
      userId: req.user.id,
      emoji: key,
    });

    await app.enqueue('push.reaction', { messageId, actorId: req.user.id, emoji: key });

    return reply.send({ ok: true });
  });

  app.delete('/:id/messages/:messageId/reactions', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id, messageId } = req.params as { id: string; messageId: string };
    const { emoji, stickerId } = req.query as { emoji?: string; stickerId?: string };
    const key = emoji ?? (stickerId ? `sticker:${stickerId}` : null);
    if (!key) throw unprocessable('emoji or stickerId is required');

    await requireMember(app.db, id, req.user.id);
    await app.db
      .delete(messageReactions)
      .where(
        and(
          eq(messageReactions.messageId, messageId),
          eq(messageReactions.userId, req.user.id),
          eq(messageReactions.emoji, key),
        ),
      );

    await app.events.toConversation(id, Event.ReactionRemove, {
      conversationId: id,
      messageId,
      userId: req.user.id,
      emoji: key,
    });

    return reply.send({ ok: true });
  });

  /** Who reacted with what — the reaction detail sheet. */
  app.get('/:id/messages/:messageId/reactions', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id, messageId } = req.params as { id: string; messageId: string };
    const { emoji } = req.query as { emoji?: string };
    await requireMember(app.db, id, req.user.id);

    const rows = await app.db
      .select({
        emoji: messageReactions.emoji,
        createdAt: messageReactions.createdAt,
        user: users,
        avatarKey: media.objectKey,
      })
      .from(messageReactions)
      .innerJoin(users, eq(users.id, messageReactions.userId))
      .leftJoin(media, eq(media.id, users.avatarMediaId))
      .where(
        and(
          eq(messageReactions.messageId, messageId),
          emoji ? eq(messageReactions.emoji, emoji) : undefined,
        ),
      )
      .orderBy(messageReactions.createdAt)
      .limit(200);

    return reply.send({
      reactions: rows.map((r) => ({
        emoji: r.emoji,
        user: toPublicUser(r.user, r.avatarKey),
        reactedAt: r.createdAt.toISOString(),
      })),
    });
  });

  // ── Pins ──────────────────────────────────────────────────────────────────

  app.put('/:id/pins/:messageId', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id, messageId } = req.params as { id: string; messageId: string };
    await requirePermission(app.db, id, req.user.id, Permission.PIN_MESSAGES);

    const [message] = await app.db
      .select({ id: messages.id, conversationId: messages.conversationId, deletedAt: messages.deletedAt })
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1);
    if (!message || message.conversationId !== id) throw notFound('Message');
    if (message.deletedAt) throw unprocessable('Cannot pin a deleted message');

    const countRows = (await app.db.execute(
      raw`select count(*)::int as count from pinned_messages where conversation_id = ${id}::uuid`,
    )) as unknown as Array<{ count: number }>;
    const count = countRows[0]?.count ?? 0;
    if (count >= LIMITS.pinnedPerConversation) {
      throw conflict(`At most ${LIMITS.pinnedPerConversation} pinned messages`);
    }

    await app.db.transaction(async (tx) => {
      await tx
        .insert(pinnedMessages)
        .values({ conversationId: id, messageId, pinnedById: req.user.id, position: count })
        .onConflictDoNothing();

      // A pin is announced in the timeline — otherwise members never notice it.
      await app.conversations.writeSystemMessage(tx, id, {
        event: 'message_pinned',
        actorId: req.user.id,
        value: messageId,
      });

      await app.events.toConversation(
        id,
        Event.PinAdd,
        { conversationId: id, messageId, pinnedBy: req.user.id },
        { exec: txExecutor(tx) },
      );
    });

    return reply.send({ pinned: true });
  });

  app.delete('/:id/pins/:messageId', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id, messageId } = req.params as { id: string; messageId: string };
    await requirePermission(app.db, id, req.user.id, Permission.PIN_MESSAGES);

    await app.db
      .delete(pinnedMessages)
      .where(and(eq(pinnedMessages.conversationId, id), eq(pinnedMessages.messageId, messageId)));

    await app.events.toConversation(id, Event.PinRemove, { conversationId: id, messageId });
    return reply.send({ pinned: false });
  });

  app.get('/:id/pins', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await requirePermission(app.db, id, req.user.id, Permission.VIEW_CONVERSATION);

    const rows = await app.db
      .select({ message: messages, position: pinnedMessages.position, pinnedAt: pinnedMessages.pinnedAt })
      .from(pinnedMessages)
      .innerJoin(messages, eq(messages.id, pinnedMessages.messageId))
      .where(and(eq(pinnedMessages.conversationId, id), isNull(messages.deletedAt)))
      .orderBy(pinnedMessages.position, desc(pinnedMessages.pinnedAt))
      .limit(LIMITS.pinnedPerConversation);

    const hydrated = await app.messages.hydrateMany(
      rows.map((r) => r.message),
      req.user.id,
    );

    return reply.send({
      pins: hydrated.map((m, i) => ({
        message: m,
        position: rows[i]!.position,
        pinnedAt: rows[i]!.pinnedAt.toISOString(),
      })),
    });
  });

  /**
   * The media wall: every image, video and GIF ever shared here, newest first.
   *
   * This is the group's shared memory, so it is a first-class query rather than
   * a client-side filter over history — filtering client-side would mean paging
   * through months of text to find last summer's photos. Rides the partial
   * `messages_type_idx` and the attachment join; seq-cursored like history.
   */
  app.get('/:id/media', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { limit, before } = messageHistoryQuery.parse(req.query);
    const ctx = await requirePermission(app.db, id, req.user.id, Permission.READ_HISTORY);
    // Same visibility floor as history: no paging back past your join point.
    const floor = ctx.member.historyStartSeq;

    const rows = await app.db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, id),
          isNull(messages.deletedAt),
          raw`${messages.seq} >= ${floor}`,
          before !== undefined ? raw`${messages.seq} < ${before}` : undefined,
          raw`(${messages.type} = 'gif' or exists (
                select 1 from message_attachments a
                join media md on md.id = a.media_id
                where a.message_id = ${messages.id}
                  and (md.mime_type like 'image/%' or md.mime_type like 'video/%')))`,
        ),
      )
      .orderBy(desc(messages.seq))
      .limit(limit);

    return reply.send({
      messages: await app.messages.hydrateMany(rows, req.user.id),
      hasMore: rows.length === limit,
    });
  });

  // ── Polls ─────────────────────────────────────────────────────────────────

  app.post('/:id/messages/:messageId/poll/vote', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id, messageId } = req.params as { id: string; messageId: string };
    const body = pollVoteBody.parse(req.body);
    await requirePermission(app.db, id, req.user.id, Permission.SEND_POLLS);

    const [poll] = await app.db.select().from(polls).where(eq(polls.messageId, messageId)).limit(1);
    if (!poll) throw notFound('Poll');
    if (poll.closedAt || (poll.closesAt && poll.closesAt < new Date())) {
      throw conflict('This poll is closed');
    }
    if (!poll.multiSelect && body.optionIds.length > 1) {
      throw unprocessable('This poll allows one answer');
    }

    const validOptions = await app.db
      .select({ id: pollOptions.id })
      .from(pollOptions)
      .where(eq(pollOptions.pollId, poll.id));
    const validIds = new Set(validOptions.map((o) => o.id));
    for (const optionId of body.optionIds) {
      if (!validIds.has(optionId)) throw unprocessable('Unknown option');
    }

    await app.db.transaction(async (tx) => {
      // Replace rather than append: re-voting changes your answer, and an empty
      // array retracts it entirely.
      await tx
        .delete(pollVotes)
        .where(and(eq(pollVotes.pollId, poll.id), eq(pollVotes.userId, req.user.id)));

      if (body.optionIds.length > 0) {
        await tx.insert(pollVotes).values(
          body.optionIds.map((optionId) => ({
            pollId: poll.id,
            optionId,
            userId: req.user.id,
          })),
        );
      }
    });

    const tallies = await app.db
      .select({ id: pollOptions.id, voteCount: pollOptions.voteCount })
      .from(pollOptions)
      .where(eq(pollOptions.pollId, poll.id));

    await app.events.toConversation(id, Event.PollVote, {
      conversationId: id,
      messageId,
      pollId: poll.id,
      // Anonymous polls broadcast tallies only.
      userId: poll.isAnonymous ? null : req.user.id,
      options: tallies,
    });

    return reply.send({ ok: true, options: tallies });
  });

  app.post('/:id/messages/:messageId/poll/close', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id, messageId } = req.params as { id: string; messageId: string };
    await requireMember(app.db, id, req.user.id);

    const [row] = await app.db
      .select({ poll: polls, senderId: messages.senderId })
      .from(polls)
      .innerJoin(messages, eq(messages.id, polls.messageId))
      .where(eq(polls.messageId, messageId))
      .limit(1);
    if (!row) throw notFound('Poll');

    const ctx = await requireMember(app.db, id, req.user.id);
    const isAuthor = row.senderId === req.user.id;
    if (!isAuthor && !(ctx.permissions & Permission.MANAGE_CONVERSATION)) {
      throw conflict('Only the author or a moderator can close this poll');
    }

    await app.db.update(polls).set({ closedAt: new Date() }).where(eq(polls.id, row.poll.id));
    await app.events.toConversation(id, Event.PollClose, { conversationId: id, messageId, pollId: row.poll.id });
    return reply.send({ closed: true });
  });

  // ── Media gallery ─────────────────────────────────────────────────────────

  /** "Photos, videos and files in this chat" — one indexed scan per type. */
  app.get('/:id/gallery', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { type = 'image', limit = '50', before } = req.query as {
      type?: string;
      limit?: string;
      before?: string;
    };
    await requirePermission(app.db, id, req.user.id, Permission.READ_HISTORY);

    const rows = await app.db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, id),
          eq(messages.type, type as never),
          isNull(messages.deletedAt),
          before ? lt(messages.seq, Number(before)) : undefined,
        ),
      )
      .orderBy(desc(messages.seq))
      .limit(Math.min(Number(limit), LIMITS.pageSizeMax));

    return reply.send({
      messages: await app.messages.hydrateMany(rows, req.user.id),
      nextCursor: rows.length > 0 ? String(rows.at(-1)!.seq) : null,
    });
  });
}
