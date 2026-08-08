import {
  and,
  calls,
  conversationMembers,
  conversations,
  eq,
  isNull,
  messageMentions,
  messages,
  pinnedMessages,
  sql as raw,
} from '@yappy/db';
import {
  conflict,
  createChannelBody,
  DEFAULT_CONVERSATION_PERMISSIONS,
  Event,
  forbidden,
  LIMITS,
  newId,
  notFound,
  Permission,
  reorderChannelsBody,
  unprocessable,
  upgradeToSpaceBody,
} from '@yappy/shared';
import type { FastifyInstance } from 'fastify';
import { requireMember, requirePermission } from '../lib/access.js';

/**
 * Spaces: a container conversation that owns channels.
 *
 * The whole design rests on one rule — **a space holds membership and roles; a
 * channel holds messages**. Nothing is duplicated between them, so there is
 * nothing to keep in sync. Promoting someone in a space promotes them in every
 * channel because the channel never had its own copy of their role to begin
 * with (see `loadMemberContext`).
 */
export async function spaceRoutes(app: FastifyInstance) {
  /** Announcement channels are an ordinary channel with a lowered floor. */
  const announcementBase =
    Permission.VIEW_CONVERSATION | Permission.READ_HISTORY | Permission.ADD_REACTIONS;

  app.get('/:id/channels', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const ctx = await requirePermission(app.db, id, req.user.id, Permission.VIEW_CONVERSATION);
    if (ctx.conversation.type !== 'space') throw conflict('That conversation is not a space');

    const rows = await app.db
      .select({
        channel: conversations,
        /**
         * Unread from this viewer's own row when they have one. A member who
         * has never opened the channel has no row, and `null` here is read as
         * "everything since they joined" rather than zero — otherwise a brand
         * new member would see a space with nothing to catch up on.
         */
        lastReadSeq: conversationMembers.lastReadSeq,
        mentionCount: conversationMembers.mentionCount,
        notificationLevel: conversationMembers.notificationLevel,
        mutedUntil: conversationMembers.mutedUntil,
      })
      .from(conversations)
      .leftJoin(
        conversationMembers,
        and(
          eq(conversationMembers.conversationId, conversations.id),
          eq(conversationMembers.userId, req.user.id),
        ),
      )
      .where(and(eq(conversations.parentId, id), isNull(conversations.deletedAt)))
      .orderBy(conversations.position, conversations.title);

    return reply.send({
      channels: rows.map((r) => ({
        id: r.channel.id,
        title: r.channel.title,
        description: r.channel.description,
        position: r.channel.position,
        latestSeq: r.channel.messageSeq,
        lastMessageAt: r.channel.lastMessageAt?.toISOString() ?? null,
        lastMessagePreview: r.channel.lastMessagePreview,
        unreadCount: Math.max(0, r.channel.messageSeq - (r.lastReadSeq ?? 0)),
        mentionCount: r.mentionCount ?? 0,
        // No row means no per-channel choice has been made, so the space's own
        // setting applies — the same fallback the push fan-out uses. Reporting
        // a flat 'all' here would show people a setting they never chose and
        // that the notifier would not honour.
        // Channel override → space setting → the same 'all' the notifier
        // falls back to. Resolved here rather than sending null, because a
        // client showing "inherited" as a fourth state helps nobody.
        notificationLevel: r.notificationLevel ?? ctx.member.notificationLevel ?? 'all',
        /** True when this channel *specifically* is muted, space mute aside. */
        isMuted: Boolean(r.mutedUntil && r.mutedUntil > new Date()),
        isAnnouncement: r.channel.basePermissions === announcementBase,
      })),
    });
  });

  app.post('/:id/channels', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = createChannelBody.parse(req.body);
    const ctx = await requirePermission(app.db, id, req.user.id, Permission.MANAGE_CONVERSATION);
    if (ctx.conversation.type !== 'space') throw conflict('Only a space can hold channels');

    const [{ count }] = (await app.db
      .select({ count: raw<number>`count(*)::int` })
      .from(conversations)
      .where(and(eq(conversations.parentId, id), isNull(conversations.deletedAt)))) as [
      { count: number },
    ];
    if (count >= LIMITS.channelsPerSpace) {
      throw unprocessable(`A space can have at most ${LIMITS.channelsPerSpace} channels`);
    }

    const channelId = newId();
    await app.db.transaction(async (tx) => {
      await tx.insert(conversations).values({
        id: channelId,
        type: 'channel',
        parentId: id,
        title: body.title,
        description: body.description ?? null,
        position: body.position,
        ownerId: ctx.conversation.ownerId,
        createdById: req.user.id,
        memberCount: ctx.conversation.memberCount,
        basePermissions: body.isAnnouncement ? announcementBase : null,
        // Inherited so a space-wide retention setting is not quietly dropped by
        // creating a new channel.
        disappearingSeconds: ctx.conversation.disappearingSeconds,
      });

      // The creator gets a real row immediately; everyone else's is created the
      // first time they write. See `materialiseChannelMember`.
      await tx.insert(conversationMembers).values({
        conversationId: channelId,
        userId: req.user.id,
        role: ctx.member.role,
      });

      await app.conversations.writeSystemMessage(tx, channelId, {
        event: 'channel_created',
        actorId: req.user.id,
        value: body.title,
      });
    });

    await app.events.toConversation(id, Event.ConversationUpdate, { id, channelsChanged: true });

    return reply.status(201).send({ channel: await app.conversations.view(channelId, req.user.id) });
  });

  /**
   * Turn an ordinary group into a space.
   *
   * The group row *becomes* the space — same id, same members, same roles, same
   * invite links — and its entire history moves into a new first channel. Doing
   * it this way rather than creating a fresh space means every existing link,
   * bookmark and notification still resolves, and nobody has to be re-invited.
   *
   * The history move is a bulk UPDATE proportional to the group's message
   * count. That is the honest cost of the clean model (a space never carries
   * messages), it happens once, and it is deliberately an explicit action
   * rather than something that happens by surprise.
   *
   * Owner-only: it restructures the group for everyone in it.
   */
  app.post('/:id/upgrade-to-space', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = upgradeToSpaceBody.parse(req.body);
    const ctx = await requireMember(app.db, id, req.user.id);

    if (ctx.member.role !== 'owner') throw forbidden('Only the owner can turn a group into a space');
    if (ctx.conversation.type === 'space') throw conflict('This is already a space');
    if (ctx.conversation.type !== 'group') throw conflict('Only a group can become a space');
    if (ctx.conversation.parentId) throw conflict('A channel cannot become a space');

    const channelId = newId();
    const group = ctx.conversation;

    await app.db.transaction(async (tx) => {
      // 1. The group becomes the space *first*. The database enforces that a
      //    channel's parent is already a space (see 0001_constraints.sql), so
      //    the order here is not cosmetic — inserting the channel first fails.
      //    Everything the channel needs was captured in `group` above.
      await tx
        .update(conversations)
        .set({
          type: 'space',
          messageSeq: 0,
          lastMessageId: null,
          lastMessagePreview: null,
          lastMessageSenderId: null,
          // The space's own floor is the container default, not the group's —
          // its channels carry the real permissions.
          basePermissions: DEFAULT_CONVERSATION_PERMISSIONS.space,
        })
        .where(eq(conversations.id, id));

      // 2. The new channel inherits everything that describes a *timeline*:
      //    the sequence counter above all, so existing message seqs stay valid
      //    and the next send does not collide with history.
      await tx.insert(conversations).values({
        id: channelId,
        type: 'channel',
        parentId: id,
        title: body.firstChannelTitle,
        position: 0,
        ownerId: group.ownerId,
        createdById: req.user.id,
        memberCount: group.memberCount,
        messageSeq: group.messageSeq,
        lastMessageId: group.lastMessageId,
        lastMessageAt: group.lastMessageAt,
        lastMessagePreview: group.lastMessagePreview,
        lastMessageSenderId: group.lastMessageSenderId,
        basePermissions: group.basePermissions,
        disappearingSeconds: group.disappearingSeconds,
        slowModeSeconds: group.slowModeSeconds,
      });

      // 3. Everything keyed by conversation *and* tied to a message follows the
      //    messages. Anything keyed only by message id (attachments, reactions,
      //    link previews) needs no change.
      await tx.execute(
        raw`update messages set conversation_id = ${channelId}::uuid where conversation_id = ${id}::uuid`,
      );
      await tx.execute(
        raw`update pinned_messages set conversation_id = ${channelId}::uuid where conversation_id = ${id}::uuid`,
      );
      await tx.execute(
        raw`update message_mentions set conversation_id = ${channelId}::uuid where conversation_id = ${id}::uuid`,
      );
      // A call in progress belongs to the timeline it will write its summary
      // card into, so it moves too.
      await tx.execute(
        raw`update calls set conversation_id = ${channelId}::uuid where conversation_id = ${id}::uuid`,
      );

      // 4. Read state describes a timeline, so it moves with it. Every member
      //    gets a real channel row here — this is the one moment we know the
      //    full roster and their exact cursors, and losing them would mark the
      //    whole history unread for everyone.
      await tx.execute(raw`
        insert into conversation_members
          (conversation_id, user_id, role, allow, deny, muted_until, nickname,
           last_read_seq, last_read_at, last_delivered_seq, mention_count,
           notification_level, is_pinned, is_archived, draft, draft_updated_at,
           history_start_seq, invited_by_id, joined_at, left_at)
        select ${channelId}::uuid, user_id, role, allow, deny, muted_until, nickname,
               last_read_seq, last_read_at, last_delivered_seq, mention_count,
               notification_level, false, false, draft, draft_updated_at,
               history_start_seq, invited_by_id, joined_at, left_at
          from conversation_members
         where conversation_id = ${id}::uuid
      `);

      // 5. Read cursors moved to the channel; the space has nothing to be unread
      // about, and a stale cursor there would badge it forever.
      await tx
        .update(conversationMembers)
        .set({ lastReadSeq: 0, lastDeliveredSeq: 0, mentionCount: 0, draft: null })
        .where(eq(conversationMembers.conversationId, id));

      // 6. Say so in the channel, so the history explains where it went.
      await app.conversations.writeSystemMessage(tx, channelId, {
        event: 'upgraded_to_space',
        actorId: req.user.id,
        value: body.firstChannelTitle,
      });
    });

    await app.events.toConversation(id, Event.ConversationUpdate, {
      id,
      type: 'space',
      channelsChanged: true,
    });

    return reply.send({
      space: await app.conversations.view(id, req.user.id),
      channel: await app.conversations.view(channelId, req.user.id),
    });
  });

  /**
   * Reorder the channel list.
   *
   * Takes the whole ordered list rather than "move this one to index 4": two
   * admins dragging at the same time then converge on one of their orderings
   * instead of interleaving into something neither of them chose. Positions are
   * rewritten from the array index, so gaps and duplicates left by earlier bugs
   * heal themselves on the next save.
   */
  app.put('/:id/channels/order', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = reorderChannelsBody.parse(req.body);
    const ctx = await requirePermission(app.db, id, req.user.id, Permission.MANAGE_CONVERSATION);
    if (ctx.conversation.type !== 'space') throw conflict('That conversation is not a space');

    const existing = await app.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.parentId, id), isNull(conversations.deletedAt)));

    const known = new Set(existing.map((c) => c.id));
    const wanted = [...new Set(body.channelIds)];
    // Every channel, exactly once. A partial list would leave the omitted ones
    // at stale positions and produce an order nobody asked for.
    if (wanted.length !== known.size || wanted.some((c) => !known.has(c))) {
      throw unprocessable('Send every channel in this space, exactly once');
    }

    await app.db.transaction(async (tx) => {
      for (const [index, channelId] of wanted.entries()) {
        await tx.update(conversations).set({ position: index }).where(eq(conversations.id, channelId));
      }
    });

    await app.events.toConversation(id, Event.ConversationUpdate, { id, channelsChanged: true });
    return reply.send({ order: wanted });
  });

  /** Deleting a channel; the space and its other channels are untouched. */
  app.delete('/:id/channels/:channelId', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id, channelId } = req.params as { id: string; channelId: string };
    await requirePermission(app.db, id, req.user.id, Permission.MANAGE_CONVERSATION);

    const [channel] = await app.db
      .select()
      .from(conversations)
      .where(and(eq(conversations.id, channelId), eq(conversations.parentId, id)))
      .limit(1);
    if (!channel || channel.deletedAt) throw notFound('Channel');

    const [{ count }] = (await app.db
      .select({ count: raw<number>`count(*)::int` })
      .from(conversations)
      .where(and(eq(conversations.parentId, id), isNull(conversations.deletedAt)))) as [
      { count: number },
    ];
    // A space with no channels is a dead end with no way back to a timeline.
    if (count <= 1) throw conflict('A space needs at least one channel');

    await app.db
      .update(conversations)
      .set({ deletedAt: new Date() })
      .where(eq(conversations.id, channelId));

    await app.events.toConversation(id, Event.ConversationUpdate, { id, channelsChanged: true });
    return reply.send({ deleted: true });
  });
}
