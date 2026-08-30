import {
  and,
  callParticipants,
  calls,
  conversationMembers,
  conversationRoleOverwrites,
  conversations,
  eq,
  inArray,
  isNull,
  media,
  messageMentions,
  messages,
  ne,
  pinnedMessages,
  sql as raw,
  users,
} from '@yappy/db';
import {
  conflict,
  createChannelBody,
  DEFAULT_CONVERSATION_PERMISSIONS,
  Event,
  forbidden,
  has,
  LIMITS,
  newId,
  notFound,
  Permission,
  serializePermissions,
  reorderChannelsBody,
  unprocessable,
  upgradeToSpaceBody,
} from '@yappy/shared';
import type { FastifyInstance } from 'fastify';
import { loadMemberContext, requireMember, requirePermission } from '../lib/access.js';
import { ensureRoom, listParticipants, mintJoinToken, roomNameForCall } from '../lib/livekit.js';
import { env } from '../env.js';
import { toPublicUser } from '../lib/serialize.js';
import { logAudit } from '../lib/audit.js';

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

  /**
   * Who is inside a voice channel right now, from our own table. LiveKit is
   * only consulted at the reconcile points (join, and the channel list) —
   * every broadcast reads the cheap local truth.
   */
  const voiceRoster = async (channelId: string) => {
    const rows = await app.db
      .select({ user: users, avatarKey: media.objectKey, isMuted: callParticipants.isMuted })
      .from(calls)
      .innerJoin(
        callParticipants,
        and(eq(callParticipants.callId, calls.id), eq(callParticipants.state, 'joined')),
      )
      .innerJoin(users, eq(users.id, callParticipants.userId))
      .leftJoin(media, eq(media.id, users.avatarMediaId))
      .where(and(eq(calls.conversationId, channelId), ne(calls.state, 'ended')));
    return rows.map((r) => ({ ...toPublicUser(r.user, r.avatarKey), isMuted: r.isMuted }));
  };

  /** Snapshot to the SPACE topic — one subscription covers the channel list. */
  const broadcastVoiceState = async (spaceId: string, channelId: string) => {
    await app.events.toConversation(spaceId, Event.VoiceState, {
      spaceId,
      channelId,
      participants: await voiceRoster(channelId),
    });
  };

  /**
   * Drop participants our table believes are joined but LiveKit does not
   * have. A browser that crashed, a phone that lost its radio — their WebRTC
   * peer died, their row did not. The grace period spares whoever just got a
   * token and has not connected yet.
   */
  const reconcileVoice = async (channelId: string): Promise<boolean> => {
    const [call] = await app.db
      .select()
      .from(calls)
      .where(and(eq(calls.conversationId, channelId), ne(calls.state, 'ended')))
      .limit(1);
    if (!call) return false;
    const inRoom = new Set(await listParticipants(call.roomName));
    const joined = await app.db
      .select({ userId: callParticipants.userId, joinedAt: callParticipants.joinedAt })
      .from(callParticipants)
      .where(and(eq(callParticipants.callId, call.id), eq(callParticipants.state, 'joined')));
    const graceMs = 60_000;
    const ghosts = joined
      .filter((p) => !inRoom.has(p.userId))
      .filter((p) => !p.joinedAt || Date.now() - p.joinedAt.getTime() > graceMs)
      .map((p) => p.userId);
    if (ghosts.length === 0) return false;
    await app.db
      .update(callParticipants)
      .set({ state: 'left', leftAt: new Date() })
      .where(and(eq(callParticipants.callId, call.id), inArray(callParticipants.userId, ghosts)));
    return true;
  };

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

    // Voice occupancy, self-healing: reconcile against LiveKit for a bounded
    // few channels, then read our own table. Opening the list is exactly when
    // a stale ghost would be noticed, so it is the right moment to sweep one.
    const voiceIds = rows.filter((r) => r.channel.isVoice).map((r) => r.channel.id);
    for (const channelId of voiceIds.slice(0, 3)) await reconcileVoice(channelId);
    const occupants = new Map<string, Awaited<ReturnType<typeof voiceRoster>>>();
    for (const channelId of voiceIds) occupants.set(channelId, await voiceRoster(channelId));

    /**
     * Whether this viewer may post, per channel — the server answering rather
     * than the client inferring.
     *
     * A client that worked it out from "is this an announcement channel" and
     * "am I an admin" would be reimplementing the permission stack in a second
     * language, and would be wrong the first time somebody used a role
     * override. Asked only for the channels where the answer can be no: an
     * ordinary channel inherits the space, which this viewer is demonstrably
     * in, and there are rarely more than a couple of the other kind.
     */
    /*
     * A channel with a role overwrite is restricted whatever its floor says,
     * so its answer has to be resolved rather than inherited. Fetched as one
     * query over the whole space instead of one per channel — the usual case
     * is that a space has no overwrites at all and this costs a single empty
     * result.
     */
    const overwritten = new Set(
      (
        await app.db
          .select({ conversationId: conversationRoleOverwrites.conversationId })
          .from(conversationRoleOverwrites)
          .where(
            inArray(
              conversationRoleOverwrites.conversationId,
              rows.map((r) => r.channel.id),
            ),
          )
      ).map((r) => r.conversationId),
    );

    const restricted = rows.filter(
      (r) =>
        r.channel.basePermissions !== null ||
        r.channel.isBoard ||
        overwritten.has(r.channel.id),
    );
    const canPost = new Map<string, boolean>();
    const permissionsFor = new Map<string, bigint>();
    /*
     * Channels this viewer may not even see.
     *
     * The point of an overwrite is that a channel can be for one role, and a
     * channel you cannot open has no business being listed — before this the
     * list returned everything in the space, so a private channel would show
     * its name and its last message preview and then 403 on open.
     */
    const hidden = new Set<string>();
    for (const r of restricted) {
      const channelCtx = await loadMemberContext(app.db, r.channel.id, req.user.id);
      const permissions = channelCtx?.permissions ?? 0n;
      if (!has(permissions, Permission.VIEW_CONVERSATION)) {
        hidden.add(r.channel.id);
        continue;
      }
      canPost.set(r.channel.id, has(permissions, Permission.SEND_MESSAGES));
      permissionsFor.set(r.channel.id, permissions);
    }

    const visible = rows.filter((r) => !hidden.has(r.channel.id));

    return reply.send({
      channels: visible.map((r) => ({
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
        isBoard: r.channel.isBoard,
        /**
         * A floor of nothing: closed to the space until a role overwrite
         * lets somebody back in.
         *
         * A boolean rather than the raw floor, because that is the whole
         * question a client asks — and the answer to "is this channel
         * private" should not require a client to know which bit pattern
         * counts as closed.
         */
        isPrivate: r.channel.basePermissions === 0n,
        canPost: canPost.get(r.channel.id) ?? true,
        /**
         * What this viewer may do here — the bitfield behind `canPost`,
         * needed by the handful of decisions a client makes for itself.
         * Offering `@everyone` is the one that prompted it: a composer that
         * offers it to somebody the server will refuse turns a send into an
         * error message.
         *
         * A channel with no floor of its own resolves to the space's answer,
         * which is the same computation `loadMemberContext` would do and one
         * query instead of one per channel.
         */
        permissions: serializePermissions(permissionsFor.get(r.channel.id) ?? ctx.permissions),
        isVoice: r.channel.isVoice,
        voiceParticipants: r.channel.isVoice ? (occupants.get(r.channel.id) ?? []) : undefined,
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

    if (body.isVoice && body.isAnnouncement) {
      throw unprocessable('A channel is either voice or announcements, not both');
    }
    // A voice room has no timeline, so there is nothing for a board to draw.
    if (body.isVoice && body.isBoard) {
      throw unprocessable('A voice channel has no page to put cards on');
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
        isVoice: body.isVoice,
        isBoard: body.isBoard,
        ownerId: ctx.conversation.ownerId,
        createdById: req.user.id,
        // A live count, not the space's counter — that column has drifted
        // before, and a channel born saying "0 members" wears it forever.
        memberCount: await app.db
          .select({ count: raw<number>`count(*)::int` })
          .from(conversationMembers)
          .where(and(eq(conversationMembers.conversationId, id), isNull(conversationMembers.leftAt)))
          .then((r) => r[0]?.count ?? ctx.conversation.memberCount),
        // A board almost always wants the announcement floor — a page of cards
        // with a composer under it is a page nobody can keep tidy — but the two
        // stay separable, because a small team wanting a shared editable page is
        // a reasonable thing to want.
        basePermissions: body.isAnnouncement || body.isBoard ? announcementBase : null,
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

    await logAudit(app, {
      conversationId: id,
      actorId: req.user.id,
      action: 'channel.create',
      targetId: channelId,
      metadata: { title: body.title, isBoard: body.isBoard, isVoice: body.isVoice },
    });

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
      // A live count for the same reason channel creation takes one: the
      // group's counter has drifted before, and "0 members" sticks.
      const [{ count: realCount }] = (await tx
        .select({ count: raw<number>`count(*)::int` })
        .from(conversationMembers)
        .where(
          and(eq(conversationMembers.conversationId, id), isNull(conversationMembers.leftAt)),
        )) as [{ count: number }];

      await tx.insert(conversations).values({
        id: channelId,
        type: 'channel',
        parentId: id,
        title: body.firstChannelTitle,
        position: 0,
        ownerId: group.ownerId,
        createdById: req.user.id,
        memberCount: realCount || group.memberCount,
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

    await logAudit(app, {
      conversationId: id,
      actorId: req.user.id,
      action: 'channel.delete',
      targetId: channelId,
      metadata: { title: channel.title },
    });

    await app.events.toConversation(id, Event.ConversationUpdate, { id, channelsChanged: true });
    return reply.send({ deleted: true });
  });

  // ── Voice channels ────────────────────────────────────────────────────────
  // Drop-in, Discord-style: no ringing, no timeline. The channel's call row
  // is persistent — created on the first join ever, never "ended" — and
  // people come and go. LiveKit's emptyTimeout collects the actual room when
  // it sits empty; ensureRoom on join resurrects it.

  app.post('/:id/voice/join', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await app.limiter.consume(`user:${req.user.id}`, 'call.start');
    const ctx = await requireMember(app.db, id, req.user.id);
    const channel = ctx.conversation;
    if (channel.type !== 'channel' || !channel.isVoice || !channel.parentId) {
      throw conflict('That is not a voice channel');
    }
    const spaceId = channel.parentId;

    // Find-or-create under an advisory lock: two first-joiners racing must
    // not split the channel into two rooms.
    const call = await app.db.transaction(async (tx) => {
      await tx.execute(raw`select pg_advisory_xact_lock(hashtext(${`voice:${id}`}))`);
      const [existing] = await tx
        .select()
        .from(calls)
        .where(and(eq(calls.conversationId, id), ne(calls.state, 'ended')))
        .limit(1);
      if (existing) return existing;
      const callId = newId();
      const [created] = await tx
        .insert(calls)
        .values({
          id: callId,
          conversationId: id,
          initiatorId: req.user.id,
          mode: 'audio',
          state: 'active',
          roomName: roomNameForCall(callId),
          startedAt: new Date(),
        })
        .returning();
      return created!;
    });

    await ensureRoom(call.roomName);
    await reconcileVoice(id);

    await app.db
      .insert(callParticipants)
      .values({
        callId: call.id,
        userId: req.user.id,
        state: 'joined',
        deviceId: req.deviceId ?? null,
        joinedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [callParticipants.callId, callParticipants.userId],
        set: { state: 'joined', joinedAt: new Date(), leftAt: null },
      });

    const token = await mintJoinToken({
      roomName: call.roomName,
      userId: req.user.id,
      displayName: req.user.displayName ?? req.user.username ?? 'someone',
      canPublishAudio: true,
      canPublishVideo: false,
      // A voice channel sit can outlast any call; renewably long.
      ttlSeconds: 12 * 3_600,
    });

    await broadcastVoiceState(spaceId, id);

    return reply.send({
      token,
      url: env.LIVEKIT_URL,
      roomName: call.roomName,
      channelId: id,
      participants: await voiceRoster(id),
    });
  });

  app.post('/:id/voice/leave', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const ctx = await requireMember(app.db, id, req.user.id);
    if (ctx.conversation.type !== 'channel' || !ctx.conversation.parentId) {
      throw conflict('That is not a voice channel');
    }
    const [call] = await app.db
      .select()
      .from(calls)
      .where(and(eq(calls.conversationId, id), ne(calls.state, 'ended')))
      .limit(1);
    if (call) {
      await app.db
        .update(callParticipants)
        .set({ state: 'left', leftAt: new Date() })
        .where(and(eq(callParticipants.callId, call.id), eq(callParticipants.userId, req.user.id)));
      await broadcastVoiceState(ctx.conversation.parentId, id);
    }
    return reply.send({ left: true });
  });
}
