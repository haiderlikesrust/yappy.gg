import {
  and,
  calls,
  callParticipants,
  conversationBans,
  conversationMembers,
  conversationRoles,
  conversations,
  desc,
  eq,
  groupPets,
  gt,
  ilike,
  inArray,
  invites,
  isNull,
  liveLocations,
  media,
  memberRoles,
  messages,
  ne,
  or,
  sql as raw,
  users,
  uuidArray,
} from '@yappy/db';
import {
  Event,
  Permission,
  addMembersBody,
  badRequest,
  liveLocationPingBody,
  conflict,
  conversationStateBody,
  createConversationBody,
  createInviteBody,
  cursorPagination,
  effectivePermissions,
  forbidden,
  historyFloor,
  LIMITS,
  newId,
  notFound,
  outranks,
  parsePermissions,
  updateConversationBody,
  updateMemberBody,
  petNameBody,
  verificationRequestBody,
  type MemberRole,
} from '@yappy/shared';
import type { FastifyInstance } from 'fastify';
import { materialiseChannelMember, requireMember, requirePermission } from '../lib/access.js';
import { fileVerificationRequest } from '../lib/verification.js';
import { txExecutor } from '../lib/events.js';
import { newInviteCode } from '../lib/tokens.js';
import {
  affiliationAvatar,
  affiliationAvatarOn,
  affiliationColumns,
  affiliationGroup,
  affiliationGroupOn,
  affiliationMembership,
  affiliationMembershipOn,
  pickAffiliation,
} from '../lib/affiliation.js';
import {
  mediaUrl as mediaUrlFor,
  toMember,
  toPublicUser,
  type MemberRoleBadge,
} from '../lib/serialize.js';

export async function conversationRoutes(app: FastifyInstance) {
  // ── List & create ─────────────────────────────────────────────────────────

  app.get('/', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { limit, cursor } = cursorPagination.parse(req.query);
    const { archived, hidden } = req.query as { archived?: string; hidden?: string };
    const result = await app.conversations.list(req.user.id, {
      limit,
      before: cursor,
      archived: archived === 'true',
      hidden: hidden === 'true',
    });
    return reply.send(result);
  });

  app.post('/', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const body = createConversationBody.parse(req.body);
    await app.limiter.consume(`user:${req.user.id}`, 'conversation.create');
    const result = await app.conversations.create(req.user.id, body);
    return reply.status(result.created ? 201 : 200).send({ conversation: result.conversation });
  });

  app.get('/:id', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    return reply.send({ conversation: await app.conversations.view(id, req.user.id) });
  });

  app.patch('/:id', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = updateConversationBody.parse(req.body);
    const ctx = await requirePermission(app.db, id, req.user.id, Permission.MANAGE_CONVERSATION);

    if (ctx.conversation.type === 'dm') {
      // A DM has no title, avatar or permission model to manage. Disappearing
      // messages are the one setting either side may change.
      const allowed = new Set(['disappearingSeconds']);
      for (const key of Object.keys(body)) {
        if (!allowed.has(key)) throw conflict('That setting does not apply to a direct message');
      }
    }

    const [updated] = await app.db
      .update(conversations)
      .set({
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.avatarMediaId !== undefined ? { avatarMediaId: body.avatarMediaId } : {}),
        ...(body.disappearingSeconds !== undefined
          ? { disappearingSeconds: body.disappearingSeconds }
          : {}),
        ...(body.slowModeSeconds !== undefined ? { slowModeSeconds: body.slowModeSeconds } : {}),
        ...(body.basePermissions !== undefined
          ? { basePermissions: parsePermissions(body.basePermissions) }
          : {}),
        ...(body.isPublic !== undefined ? { isPublic: body.isPublic } : {}),
        ...(body.historyVisibility !== undefined
          ? { historyVisibility: body.historyVisibility }
          : {}),
        // Flair lives under settings.appearance; merge so unrelated settings
        // keys survive. `appearance: null` clears it.
        ...(body.appearance !== undefined
          ? {
              settings: {
                ...ctx.conversation.settings,
                ...(body.appearance === null
                  ? { appearance: undefined }
                  : { appearance: body.appearance }),
              },
            }
          : {}),
      })
      .where(eq(conversations.id, id))
      .returning();

    // Each change gets its own system message so the timeline reads as history
    // rather than a single opaque "settings changed".
    await app.db.transaction(async (tx) => {
      if (body.title !== undefined) {
        await app.conversations.writeSystemMessage(tx, id, {
          event: 'title_changed',
          actorId: req.user.id,
          value: body.title,
        });
      }
      if (body.avatarMediaId !== undefined) {
        await app.conversations.writeSystemMessage(tx, id, {
          event: 'avatar_changed',
          actorId: req.user.id,
        });
      }
      if (body.disappearingSeconds !== undefined) {
        await app.conversations.writeSystemMessage(tx, id, {
          event: 'disappearing_changed',
          actorId: req.user.id,
          value: String(body.disappearingSeconds),
        });
      }
    });

    const view = await app.conversations.view(id, req.user.id);

    await app.events.toConversation(id, Event.ConversationUpdate, {
      id,
      title: updated!.title,
      description: updated!.description,
      // Taken from the serialised view because the URL depends on which bucket
      // the object landed in; `avatarMediaId` alone is not something a client
      // can render. Viewer-independent, so reusing the actor's view is safe.
      avatarUrl: view.avatarUrl,
      disappearingSeconds: updated!.disappearingSeconds,
      slowModeSeconds: updated!.slowModeSeconds,
      isPublic: updated!.isPublic,
      appearance: (updated!.settings as { appearance?: unknown }).appearance ?? null,
    });

    return reply.send({ conversation: view });
  });

  /** Per-user state: mute, pin, archive, nickname, draft. Never broadcast. */
  app.patch('/:id/state', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = conversationStateBody.parse(req.body);
    const ctx = await requireMember(app.db, id, req.user.id);

    // Per-user state is the one thing that cannot be inherited from a space —
    // muting #random is precisely a statement about #random — so this is where
    // a channel member row stops being optional.
    if (ctx.memberIsVirtual) await materialiseChannelMember(app.db, id, req.user.id);

    const [updated] = await app.db
      .update(conversationMembers)
      .set({
        ...(body.notificationLevel !== undefined ? { notificationLevel: body.notificationLevel } : {}),
        ...(body.mutedUntil !== undefined
          ? { mutedUntil: body.mutedUntil ? new Date(body.mutedUntil) : null }
          : {}),
        ...(body.isPinned !== undefined ? { isPinned: body.isPinned } : {}),
        ...(body.isArchived !== undefined ? { isArchived: body.isArchived } : {}),
        ...(body.isHidden !== undefined ? { isHidden: body.isHidden } : {}),
        ...(body.nickname !== undefined ? { nickname: body.nickname } : {}),
        ...(body.draft !== undefined ? { draft: body.draft, draftUpdatedAt: new Date() } : {}),
      })
      .where(
        and(eq(conversationMembers.conversationId, id), eq(conversationMembers.userId, req.user.id)),
      )
      .returning();

    // Only this user's other devices care.
    await app.events.toUser(req.user.id, Event.ConversationStateUpdate, {
      conversationId: id,
      notificationLevel: updated!.notificationLevel ?? 'all',
      mutedUntil: updated!.mutedUntil?.toISOString() ?? null,
      isPinned: updated!.isPinned,
      isArchived: updated!.isArchived,
      draft: updated!.draft,
    });

    return reply.send({ ok: true });
  });

  app.delete('/:id', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const ctx = await requireMember(app.db, id, req.user.id);

    // Channels die through their space's route, which enforces the
    // one-channel floor; the raw delete must not be a way around it.
    if (ctx.conversation.type === 'channel') {
      throw conflict('Delete channels from their space');
    }

    if (ctx.conversation.type === 'dm' || ctx.member.role !== 'owner') {
      // Leaving is the only "delete" available to a non-owner.
      return reply.send(await app.conversations.removeMember(req.user.id, id, req.user.id));
    }

    await app.db.update(conversations).set({ deletedAt: new Date() }).where(eq(conversations.id, id));
    await app.events.toConversationMembers(id, Event.ConversationDelete, { id, reason: 'deleted' });
    return reply.send({ deleted: true });
  });

  /**
   * Named roles for a page of members, highest position first.
   *
   * Kept out of the member query itself: a member holding three roles would
   * otherwise triple their row and every caller would need the same
   * de-duplication. One indexed read, grouped here.
   */
  const loadMemberRoles = async (conversationId: string, userIds: string[]) => {
    const byUser = new Map<string, MemberRoleBadge[]>();
    if (userIds.length === 0) return byUser;

    const rows = await app.db
      .select({
        userId: memberRoles.userId,
        id: conversationRoles.id,
        name: conversationRoles.name,
        color: conversationRoles.color,
        position: conversationRoles.position,
        isHoisted: conversationRoles.isHoisted,
      })
      .from(memberRoles)
      .innerJoin(conversationRoles, eq(conversationRoles.id, memberRoles.roleId))
      .where(
        and(eq(memberRoles.conversationId, conversationId), inArray(memberRoles.userId, userIds)),
      )
      .orderBy(raw`${conversationRoles.position} desc`, conversationRoles.name);

    for (const r of rows) {
      const list = byUser.get(r.userId) ?? [];
      list.push({
        id: r.id,
        name: r.name,
        color: r.color,
        position: r.position,
        isHoisted: r.isHoisted,
      });
      byUser.set(r.userId, list);
    }
    return byUser;
  };

  // ── Members ───────────────────────────────────────────────────────────────

  app.get('/:id/members', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { limit, cursor } = cursorPagination.parse(req.query);
    await requirePermission(app.db, id, req.user.id, Permission.VIEW_CONVERSATION);

    const rows = await app.db
      .select({
        member: conversationMembers,
        user: users,
        avatarKey: media.objectKey,
        ...affiliationColumns,
      })
      .from(conversationMembers)
      .innerJoin(users, eq(users.id, conversationMembers.userId))
      .leftJoin(media, eq(media.id, users.avatarMediaId))
      .leftJoin(affiliationGroup, affiliationGroupOn(users.affiliationConversationId))
      .leftJoin(affiliationAvatar, affiliationAvatarOn())
      .leftJoin(affiliationMembership, affiliationMembershipOn(users.id))
      .where(
        and(
          eq(conversationMembers.conversationId, id),
          isNull(conversationMembers.leftAt),
          cursor ? gt(conversationMembers.userId, cursor) : undefined,
        ),
      )
      // Ordered by role rank so owners and admins head the list.
      .orderBy(
        raw`case ${conversationMembers.role}
              when 'owner' then 0 when 'admin' then 1 when 'moderator' then 2
              when 'member' then 3 else 4 end`,
        conversationMembers.userId,
      )
      .limit(limit);

    const rolesByUser = await loadMemberRoles(id, rows.map((r) => r.member.userId));

    return reply.send({
      members: rows.map((r) =>
        toMember(r.member, r.user, r.avatarKey, pickAffiliation(r), rolesByUser.get(r.member.userId) ?? []),
      ),
      nextCursor: rows.length === limit ? (rows.at(-1)?.member.userId ?? null) : null,
    });
  });

  /**
   * Who is looking at this conversation right now — ambient co-presence.
   *
   * Read over REST rather than asked over the socket because neither client
   * waits on command acks, and the live `presence.viewing` events only describe
   * *changes*: without this, opening a room where three people are already
   * sitting shows an empty strip until one of them happens to leave.
   *
   * Anyone with `ambientPresence` off is filtered out in SQL, so no caller can
   * forget the check.
   */
  app.get('/:id/here', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await requirePermission(app.db, id, req.user.id, Permission.VIEW_CONVERSATION);

    const rows = (await app.db.execute(
      raw`select distinct p.user_id
            from presence p
            join users u on u.id = p.user_id
            join conversation_members m
              on m.user_id = p.user_id
             and m.conversation_id = ${id}::uuid
             and m.left_at is null
           where p.viewing_conversation_id = ${id}::uuid
             and p.expires_at > now()
             and p.user_id <> ${req.user.id}::uuid
             and coalesce((u.privacy ->> 'ambientPresence')::boolean, true)`,
    )) as unknown as Array<{ user_id: string }>;

    return reply.send({ userIds: rows.map((r) => r.user_id) });
  });

  /**
   * "People you know here."
   *
   * Walking into an unfamiliar group is a wall of strangers, and the one thing
   * that would fix it — that four of them are already your people — is data we
   * have had all along and never used. Mutuals first, then one-way follows,
   * then contacts, because that is the order they matter in.
   *
   * Deliberately available before joining a public group: knowing who is inside
   * is most of how someone decides whether to walk in. It leaks nothing the
   * member list would not, and it is limited to *your own* graph — you learn
   * about people you already know, never about strangers.
   */
  app.get('/:id/mutuals', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };

    const [conversation] = await app.db
      .select({ isPublic: conversations.isPublic, type: conversations.type })
      .from(conversations)
      .where(and(eq(conversations.id, id), isNull(conversations.deletedAt)))
      .limit(1);
    if (!conversation) throw notFound('Conversation');
    if (!conversation.isPublic) {
      await requirePermission(app.db, id, req.user.id, Permission.VIEW_CONVERSATION);
    }

    const rows = (await app.db.execute(
      raw`select u.id,
                 u.username,
                 u.display_name,
                 u.is_verified,
                 av.object_key as avatar_key,
                 f.is_mutual,
                 (c.owner_id is not null) as is_contact
            from conversation_members m
            join users u on u.id = m.user_id and u.deleted_at is null
            left join media av on av.id = u.avatar_media_id
            left join follows f
              on f.follower_id = ${req.user.id}::uuid and f.followee_id = u.id
            left join contacts c
              on c.owner_id = ${req.user.id}::uuid and c.user_id = u.id
           where m.conversation_id = ${id}::uuid
             and m.left_at is null
             and u.id <> ${req.user.id}::uuid
             and (f.follower_id is not null or c.owner_id is not null)
             and not exists (
               select 1 from blocks b
                where (b.blocker_id = ${req.user.id}::uuid and b.blocked_id = u.id)
                   or (b.blocked_id = ${req.user.id}::uuid and b.blocker_id = u.id)
             )
           order by f.is_mutual desc nulls last, u.display_name, u.username
           limit 24`,
    )) as unknown as Array<{
      id: string;
      username: string | null;
      display_name: string | null;
      is_verified: boolean;
      avatar_key: string | null;
      is_mutual: boolean | null;
      is_contact: boolean;
    }>;

    return reply.send({
      people: rows.map((r) => ({
        id: r.id,
        username: r.username,
        displayName: r.display_name,
        isVerified: r.is_verified,
        avatarUrl: r.avatar_key ? mediaUrlFor(r.avatar_key) : null,
        /** How you know them, for the caption under the faces. */
        connection: r.is_mutual ? 'mutual' : r.is_mutual === false ? 'following' : 'contact',
      })),
      total: rows.length,
    });
  });

  /**
   * The group's affiliates — the people it has vouched for.
   *
   * A badged group lending its mark to a member is the strongest signal yappy
   * has, and until now it was only visible one person at a time. Reads like a
   * roster.
   */
  app.get('/:id/affiliates', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await requirePermission(app.db, id, req.user.id, Permission.VIEW_CONVERSATION);

    const rows = await app.db
      .select({
        member: conversationMembers,
        user: users,
        avatarKey: media.objectKey,
        ...affiliationColumns,
      })
      .from(conversationMembers)
      .innerJoin(users, eq(users.id, conversationMembers.userId))
      .leftJoin(media, eq(media.id, users.avatarMediaId))
      .leftJoin(affiliationGroup, affiliationGroupOn(users.affiliationConversationId))
      .leftJoin(affiliationAvatar, affiliationAvatarOn())
      .leftJoin(affiliationMembership, affiliationMembershipOn(users.id))
      .where(
        and(
          eq(conversationMembers.conversationId, id),
          isNull(conversationMembers.leftAt),
          eq(conversationMembers.isAffiliate, true),
          isNull(users.deletedAt),
        ),
      )
      .orderBy(users.displayName, users.username)
      .limit(100);

    return reply.send({
      affiliates: rows.map((r) => toMember(r.member, r.user, r.avatarKey, pickAffiliation(r), [])),
    });
  });

  // ── Live location ─────────────────────────────────────────────────────────

  /**
   * What is still moving in this conversation.
   *
   * Read on open, because a share that started before you arrived is exactly
   * the one you want to see. Expired rows are filtered here rather than left
   * to the client: a phone with a wrong clock must not be able to keep drawing
   * somebody's position after it has stopped being shared.
   */
  app.get('/:id/live-locations', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await requireMember(app.db, id, req.user.id);

    const rows = await app.db
      .select()
      .from(liveLocations)
      .where(
        and(
          eq(liveLocations.conversationId, id),
          isNull(liveLocations.endedAt),
          gt(liveLocations.expiresAt, new Date()),
        ),
      );

    return reply.send({ locations: rows.map(toLiveLocation) });
  });

  /**
   * One ping.
   *
   * Only the sharer may move their own dot — the row is looked up by message
   * *and* user, so a member of the conversation cannot push a position into
   * somebody else's share.
   *
   * Publishes a point, not a message. A share is hundreds of these, and
   * routing them through `message.update` would rewrite a history row and hand
   * every client a whole message to re-render, fifteen seconds apart, for
   * hours.
   */
  app.post('/:id/live-locations/:messageId', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id, messageId } = req.params as { id: string; messageId: string };
    const body = liveLocationPingBody.parse(req.body);
    await app.limiter.consume(`user:${req.user.id}`, 'location.ping');

    const [row] = await app.db
      .update(liveLocations)
      .set({
        latitude: body.latitude,
        longitude: body.longitude,
        accuracy: body.accuracy ?? null,
        heading: body.heading ?? null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(liveLocations.messageId, messageId),
          eq(liveLocations.conversationId, id),
          eq(liveLocations.userId, req.user.id),
          isNull(liveLocations.endedAt),
          gt(liveLocations.expiresAt, new Date()),
        ),
      )
      .returning();

    // Gone, ended or expired. 404 rather than a silent 200: a client that has
    // stopped being listened to should find out and stop draining the battery.
    if (!row) throw notFound('Live location');

    await app.events.toConversation(id, Event.LocationUpdate, toLiveLocation(row));
    return reply.send({ location: toLiveLocation(row) });
  });

  /**
   * Stop early.
   *
   * The message stays — it is where the share happened, and deleting it would
   * silently rewrite the conversation. What ends is the movement, and the last
   * known point is kept so the card has something to show instead of going
   * blank.
   *
   * Also allowed to anyone who can manage the conversation: a stale share by
   * somebody who has lost their phone is precisely the case where a moderator
   * needs to be able to turn it off.
   */
  app.delete('/:id/live-locations/:messageId', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id, messageId } = req.params as { id: string; messageId: string };

    const [existing] = await app.db
      .select()
      .from(liveLocations)
      .where(and(eq(liveLocations.messageId, messageId), eq(liveLocations.conversationId, id)))
      .limit(1);
    if (!existing) throw notFound('Live location');

    if (existing.userId !== req.user.id) {
      await requirePermission(app.db, id, req.user.id, Permission.MANAGE_CONVERSATION);
    } else {
      await requireMember(app.db, id, req.user.id);
    }

    if (existing.endedAt) return reply.send({ ended: true });

    const [row] = await app.db
      .update(liveLocations)
      .set({ endedAt: new Date() })
      .where(eq(liveLocations.messageId, messageId))
      .returning();

    await app.events.toConversation(id, Event.LocationEnd, {
      conversationId: id,
      messageId,
      userId: row!.userId,
    });
    return reply.send({ ended: true });
  });

  /**
   * "Someone took a screenshot."
   *
   * Reported by the client, because the operating system is the only thing
   * that knows one happened. That makes it a courtesy, not a control: a
   * modified client stays silent, a phone pointed at the screen is invisible,
   * and Android below 14 cannot see screenshots at all without asking for
   * access to the photo library, which is far too high a price for this. Say
   * what happened; never imply the room is sealed.
   *
   * Debounced server-side rather than trusting the client to do it. Some
   * phones fire twice for one press, and a screenshot burst is one action from
   * the person's point of view — five lines saying the same thing is noise,
   * and a client is the wrong place to enforce something everyone else has to
   * live with.
   */
  app.post('/:id/screenshot', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await requireMember(app.db, id, req.user.id);
    await app.limiter.consume(`user:${req.user.id}`, 'screenshot');

    const [recent] = await app.db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, id),
          eq(messages.type, 'system'),
          raw`${messages.system}->>'event' = 'screenshot_taken'`,
          raw`${messages.system}->>'actorId' = ${req.user.id}`,
          raw`${messages.createdAt} > now() - interval '60 seconds'`,
        ),
      )
      .limit(1);

    if (recent) return reply.send({ noted: true, deduped: true });

    await app.db.transaction(async (tx) => {
      await app.conversations.writeSystemMessage(tx, id, {
        event: 'screenshot_taken',
        actorId: req.user.id,
      });
    });

    return reply.send({ noted: true, deduped: false });
  });

  app.post('/:id/members', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = addMembersBody.parse(req.body);
    await app.limiter.consume(`user:${req.user.id}`, 'member.add');
    return reply.send(await app.conversations.addMembers(req.user.id, id, body.userIds));
  });

  app.delete('/:id/members/:userId', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id, userId } = req.params as { id: string; userId: string };
    return reply.send(await app.conversations.removeMember(req.user.id, id, userId));
  });

  app.patch('/:id/members/:userId', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id, userId } = req.params as { id: string; userId: string };
    const body = updateMemberBody.parse(req.body);
    const ctx = await requireMember(app.db, id, req.user.id);

    const [target] = await app.db
      .select()
      .from(conversationMembers)
      .where(and(eq(conversationMembers.conversationId, id), eq(conversationMembers.userId, userId)))
      .limit(1);
    if (!target || target.leftAt) throw notFound('Member');

    const actorRole = ctx.member.role as MemberRole;
    if (!outranks(actorRole, target.role as MemberRole)) {
      throw forbidden('That member has an equal or higher role than you');
    }

    if (body.role !== undefined) {
      if (!(ctx.permissions & Permission.MANAGE_ROLES) && !(ctx.permissions & Permission.ADMINISTRATOR)) {
        throw forbidden('You cannot change roles');
      }
      // You cannot promote someone to your own level or above — that is how an
      // admin quietly takes a group away from its owner.
      if (!outranks(actorRole, body.role)) throw forbidden('You cannot grant a role at or above your own');
      if (body.role === 'owner') throw conflict('Use the ownership transfer endpoint');
    }

    if (body.mutedUntil !== undefined || body.deny !== undefined) {
      if (!(ctx.permissions & Permission.MUTE_MEMBERS) && !(ctx.permissions & Permission.ADMINISTRATOR)) {
        throw forbidden('You cannot mute members');
      }
    }

    if (body.isAffiliate !== undefined) {
      // Affiliation lends the group's own badge to a person, so it sits with
      // the strongest permission in the group rather than with role management.
      if (!(ctx.permissions & Permission.ADMINISTRATOR) && ctx.member.role !== 'owner') {
        throw forbidden('Only owners and administrators can affiliate members');
      }
      // Granting requires a badge; revoking never does, or a group that lost
      // its badge could not clean up after itself.
      if (body.isAffiliate && !ctx.conversation.badge) {
        throw forbidden('Only a verified group can affiliate its members');
      }
    }

    const [updated] = await app.db
      .update(conversationMembers)
      .set({
        ...(body.role !== undefined ? { role: body.role } : {}),
        ...(body.allow !== undefined ? { allow: parsePermissions(body.allow) } : {}),
        ...(body.deny !== undefined ? { deny: parsePermissions(body.deny) } : {}),
        ...(body.mutedUntil !== undefined
          ? { mutedUntil: body.mutedUntil ? new Date(body.mutedUntil) : null }
          : {}),
        ...(body.isAffiliate !== undefined ? { isAffiliate: body.isAffiliate } : {}),
      })
      .where(and(eq(conversationMembers.conversationId, id), eq(conversationMembers.userId, userId)))
      .returning();

    if (body.role !== undefined) {
      await app.db.transaction(async (tx) => {
        await app.conversations.writeSystemMessage(tx, id, {
          event: outranks(body.role!, target.role as MemberRole) ? 'member_promoted' : 'member_demoted',
          actorId: req.user.id,
          targetIds: [userId],
          value: body.role!,
        });
      });
    }

    await app.events.toConversation(id, Event.MemberUpdate, {
      conversationId: id,
      userId,
      role: updated!.role,
      isAffiliate: updated!.isAffiliate,
      mutedUntil: updated!.mutedUntil?.toISOString() ?? null,
    });

    return reply.send({ ok: true });
  });

  app.post('/:id/transfer-ownership', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { userId } = req.body as { userId: string };
    const ctx = await requireMember(app.db, id, req.user.id);
    if (ctx.member.role !== 'owner') throw forbidden('Only the owner can transfer ownership');

    await app.db.transaction(async (tx) => {
      await tx
        .update(conversationMembers)
        .set({ role: 'admin' })
        .where(and(eq(conversationMembers.conversationId, id), eq(conversationMembers.userId, req.user.id)));
      await tx
        .update(conversationMembers)
        .set({ role: 'owner' })
        .where(and(eq(conversationMembers.conversationId, id), eq(conversationMembers.userId, userId)));
      await tx.update(conversations).set({ ownerId: userId }).where(eq(conversations.id, id));
      await app.conversations.writeSystemMessage(tx, id, {
        event: 'member_promoted',
        actorId: req.user.id,
        targetIds: [userId],
        value: 'owner',
      });
      await app.events.toConversation(
        id,
        Event.MemberUpdate,
        { conversationId: id, userId, role: 'owner' },
        { exec: txExecutor(tx) },
      );
    });

    return reply.send({ ok: true });
  });

  /**
   * Who is banned, and why.
   *
   * Gated on BAN_MEMBERS rather than VIEW_CONVERSATION: the list names people
   * who were thrown out and the moderator who did it, which is staff
   * information, not a member-facing roster.
   *
   * Expired bans are filtered out rather than deleted — the row is the record
   * of what happened, and a sweep that removed them would erase the history a
   * moderator is checking this screen for.
   */
  app.get('/:id/bans', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await requirePermission(app.db, id, req.user.id, Permission.BAN_MEMBERS);

    const rows = await app.db
      .select({
        ban: conversationBans,
        user: users,
        avatarKey: media.objectKey,
      })
      .from(conversationBans)
      .innerJoin(users, eq(users.id, conversationBans.userId))
      .leftJoin(media, eq(media.id, users.avatarMediaId))
      .where(
        and(
          eq(conversationBans.conversationId, id),
          or(isNull(conversationBans.expiresAt), gt(conversationBans.expiresAt, new Date())),
        ),
      )
      .orderBy(desc(conversationBans.createdAt))
      .limit(LIMITS.pageSizeMax);

    return reply.send({
      bans: rows.map((r) => ({
        user: toPublicUser(r.user, r.avatarKey),
        reason: r.ban.reason,
        bannedById: r.ban.bannedById,
        expiresAt: r.ban.expiresAt?.toISOString() ?? null,
        createdAt: r.ban.createdAt.toISOString(),
      })),
    });
  });

  app.post('/:id/bans/:userId', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id, userId } = req.params as { id: string; userId: string };
    const { reason, expiresAt } = (req.body ?? {}) as { reason?: string; expiresAt?: string };
    const ctx = await requirePermission(app.db, id, req.user.id, Permission.BAN_MEMBERS);

    const [target] = await app.db
      .select({ role: conversationMembers.role })
      .from(conversationMembers)
      .where(and(eq(conversationMembers.conversationId, id), eq(conversationMembers.userId, userId)))
      .limit(1);

    if (target && !outranks(ctx.member.role as MemberRole, target.role as MemberRole)) {
      throw forbidden('That member has an equal or higher role than you');
    }

    await app.db
      .insert(conversationBans)
      .values({
        conversationId: id,
        userId,
        bannedById: req.user.id,
        reason: reason ?? null,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
      })
      .onConflictDoNothing();

    if (target) await app.conversations.removeMember(req.user.id, id, userId);
    return reply.send({ banned: true });
  });

  app.delete('/:id/bans/:userId', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id, userId } = req.params as { id: string; userId: string };
    await requirePermission(app.db, id, req.user.id, Permission.BAN_MEMBERS);
    await app.db
      .delete(conversationBans)
      .where(and(eq(conversationBans.conversationId, id), eq(conversationBans.userId, userId)));
    return reply.send({ banned: false });
  });

  // ── Invites ───────────────────────────────────────────────────────────────

  app.post('/:id/invites', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = createInviteBody.parse(req.body);
    await requirePermission(app.db, id, req.user.id, Permission.MANAGE_INVITES);
    await app.limiter.consume(`user:${req.user.id}`, 'invite.create');

    const code = newInviteCode();
    const [invite] = await app.db
      .insert(invites)
      .values({
        id: newId(),
        conversationId: id,
        code,
        createdById: req.user.id,
        maxUses: body.maxUses,
        expiresAt: body.expiresInSeconds ? new Date(Date.now() + body.expiresInSeconds * 1000) : null,
      })
      .returning();

    return reply.status(201).send({
      invite: {
        code: invite!.code,
        url: `https://yappy.gg/join/${invite!.code}`,
        maxUses: invite!.maxUses,
        uses: invite!.uses,
        expiresAt: invite!.expiresAt?.toISOString() ?? null,
      },
    });
  });

  app.get('/:id/invites', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await requirePermission(app.db, id, req.user.id, Permission.MANAGE_INVITES);
    const rows = await app.db
      .select()
      .from(invites)
      .where(and(eq(invites.conversationId, id), isNull(invites.revokedAt)))
      .orderBy(desc(invites.createdAt));
    return reply.send({
      invites: rows.map((i) => ({
        code: i.code,
        url: `https://yappy.gg/join/${i.code}`,
        maxUses: i.maxUses,
        uses: i.uses,
        expiresAt: i.expiresAt?.toISOString() ?? null,
        createdAt: i.createdAt.toISOString(),
      })),
    });
  });

  app.delete('/:id/invites/:code', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id, code } = req.params as { id: string; code: string };
    await requirePermission(app.db, id, req.user.id, Permission.MANAGE_INVITES);
    await app.db
      .update(invites)
      .set({ revokedAt: new Date() })
      .where(and(eq(invites.conversationId, id), eq(invites.code, code)));
    return reply.send({ revoked: true });
  });

  /** Preview an invite before joining — shows the group without joining it. */
  app.get('/invites/:code', { preHandler: app.authenticate }, async (req, reply) => {
    const { code } = req.params as { code: string };
    const [row] = await app.db
      .select({ invite: invites, conversation: conversations, avatarKey: media.objectKey })
      .from(invites)
      .innerJoin(conversations, eq(conversations.id, invites.conversationId))
      .leftJoin(media, eq(media.id, conversations.avatarMediaId))
      .where(and(eq(invites.code, code), isNull(invites.revokedAt), isNull(conversations.deletedAt)))
      .limit(1);

    if (!row) throw notFound('Invite');
    if (row.invite.expiresAt && row.invite.expiresAt < new Date()) throw notFound('Invite');

    return reply.send({
      conversation: {
        id: row.conversation.id,
        type: row.conversation.type,
        title: row.conversation.title,
        description: row.conversation.description,
        memberCount: row.conversation.memberCount,
        avatarUrl: row.avatarKey ? `${process.env.S3_PUBLIC_BASE_URL}/${row.avatarKey}` : null,
      },
      usesRemaining: row.invite.maxUses === 0 ? null : row.invite.maxUses - row.invite.uses,
    });
  });

  /**
   * The same preview, without a session, for the web page at
   * `yappy.gg/join/<code>`.
   *
   * Someone following an invite link has by definition no session in their
   * browser — the account lives in the app. Requiring auth here would leave the
   * landing page with nothing to say but "open the app", which is the blank
   * page this exists to replace.
   *
   * Holding the code is the authorisation; that is what an invite is. So the
   * payload stops at what an invite is meant to advertise: the name, the
   * picture, how many people are in there. No conversation id, because nothing
   * on that page needs one and it is the identifier every other endpoint keys
   * on, and no member list.
   */
  app.get('/invites/:code/preview', async (req, reply) => {
    const { code } = req.params as { code: string };
    await app.limiter.consume(`ip:${req.ip}`, 'invite.preview');

    const [row] = await app.db
      .select({
        type: conversations.type,
        title: conversations.title,
        description: conversations.description,
        badge: conversations.badge,
        memberCount: conversations.memberCount,
        avatarKey: media.objectKey,
        expiresAt: invites.expiresAt,
        maxUses: invites.maxUses,
        uses: invites.uses,
      })
      .from(invites)
      .innerJoin(conversations, eq(conversations.id, invites.conversationId))
      .leftJoin(media, eq(media.id, conversations.avatarMediaId))
      .where(and(eq(invites.code, code), isNull(invites.revokedAt), isNull(conversations.deletedAt)))
      .limit(1);

    // Never existed, revoked, expired and used up all answer identically. The
    // distinction is worth nothing to the person holding the link and something
    // to someone feeding codes in bulk, so the page says "no longer valid" to
    // all four.
    if (!row) throw notFound('Invite');
    if (row.expiresAt && row.expiresAt < new Date()) throw notFound('Invite');
    if (row.maxUses > 0 && row.uses >= row.maxUses) throw notFound('Invite');

    return reply.send({
      conversation: {
        type: row.type,
        title: row.title,
        description: row.description,
        badge: row.badge,
        memberCount: row.memberCount,
        avatarUrl: row.avatarKey ? `${process.env.S3_PUBLIC_BASE_URL}/${row.avatarKey}` : null,
      },
    });
  });

  /**
   * Ask for the group's badge.
   *
   * Gated like affiliation is, and for the same reason: both actions speak
   * for the group, so they sit with the strongest permission in it. The rest
   * of the rules — one open request, not already verified — live in
   * lib/verification.ts, where a race cannot get past them.
   */
  /**
   * Name the group's pet. Owner/admin, like everything else that names things
   * here — a pet anyone could rename is a pet named something unfortunate by
   * dinnertime. The row is upserted because pets hatch lazily on the daily
   * cron, and naming one that has not technically hatched yet should work.
   */
  app.patch('/:id/pet', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = petNameBody.parse(req.body);

    const ctx = await requireMember(app.db, id, req.user.id);
    if (ctx.conversation.type !== 'group' || ctx.conversation.parentId) {
      throw badRequest('Only a group has a pet');
    }
    if (!(ctx.permissions & Permission.ADMINISTRATOR) && ctx.member.role !== 'owner') {
      throw forbidden('Only owners and administrators can name the pet');
    }

    await app.db
      .insert(groupPets)
      .values({ conversationId: id, name: body.name })
      .onConflictDoUpdate({ target: groupPets.conversationId, set: { name: body.name } });

    return reply.send({ ok: true, name: body.name });
  });

  app.post('/:id/verification-request', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = verificationRequestBody.parse(req.body);

    const ctx = await requireMember(app.db, id, req.user.id);
    if (ctx.conversation.type === 'dm') throw badRequest('A DM cannot be verified');
    if (!(ctx.permissions & Permission.ADMINISTRATOR) && ctx.member.role !== 'owner') {
      throw forbidden('Only owners and administrators can request verification');
    }

    await fileVerificationRequest(app, {
      // A channel asks on behalf of its space — the badge belongs to the
      // container, and membership/permissions already resolved through it.
      conversationId: ctx.conversation.parentId ?? id,
      requesterId: req.user.id,
      purpose: body.purpose,
      link: body.link ?? null,
      note: body.note ?? null,
    });

    // A body rather than a 204: the Android client decodes every response,
    // and an empty one is a parse error wearing a success code.
    return reply.send({ ok: true });
  });

  app.post('/invites/:code/join', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { code } = req.params as { code: string };

    const joined = await app.db.transaction(async (tx) => {
      // Lock the invite row: two people redeeming the last use of a
      // limited-use invite simultaneously must not both get in.
      const rows = (await tx.execute(
        raw`select * from invites where code = ${code} and revoked_at is null for update`,
      )) as unknown as Array<{
        id: string;
        conversation_id: string;
        max_uses: number;
        uses: number;
        expires_at: Date | null;
      }>;
      const invite = rows[0];
      if (!invite) throw notFound('Invite');
      if (invite.expires_at && new Date(invite.expires_at) < new Date()) throw notFound('Invite');
      if (invite.max_uses > 0 && invite.uses >= invite.max_uses) {
        throw conflict('This invite has been used up');
      }

      const [banned] = await tx
        .select({ userId: conversationBans.userId })
        .from(conversationBans)
        .where(
          and(
            eq(conversationBans.conversationId, invite.conversation_id),
            eq(conversationBans.userId, req.user.id),
          ),
        )
        .limit(1);
      if (banned) throw forbidden('You are banned from this conversation');

      const [conversation] = await tx
        .select()
        .from(conversations)
        .where(eq(conversations.id, invite.conversation_id))
        .limit(1);
      if (!conversation || conversation.deletedAt) throw notFound('Conversation');

      const [existing] = await tx
        .select()
        .from(conversationMembers)
        .where(
          and(
            eq(conversationMembers.conversationId, conversation.id),
            eq(conversationMembers.userId, req.user.id),
          ),
        )
        .limit(1);

      if (existing && !existing.leftAt) return { conversationId: conversation.id, alreadyMember: true };

      if (existing) {
        await tx
          .update(conversationMembers)
          .set({ leftAt: null })
          .where(
            and(
              eq(conversationMembers.conversationId, conversation.id),
              eq(conversationMembers.userId, req.user.id),
            ),
          );
      } else {
        await tx.insert(conversationMembers).values({
          conversationId: conversation.id,
          userId: req.user.id,
          role: 'member',
          historyStartSeq: historyFloor(conversation.historyVisibility, conversation.messageSeq),
        });
      }

      await tx.execute(raw`update invites set uses = uses + 1 where id = ${invite.id}::uuid`);

      await app.conversations.writeSystemMessage(tx, conversation.id, {
        event: 'member_joined',
        actorId: req.user.id,
      });

      await app.events.toConversation(
        conversation.id,
        Event.MemberAdd,
        {
          conversationId: conversation.id,
          userIds: [req.user.id],
          ...(await app.conversations.memberEventExtras(tx, conversation.id, [req.user.id])),
        },
        { exec: txExecutor(tx) },
      );

      return { conversationId: conversation.id, alreadyMember: false };
    });

    return reply.send({
      conversation: await app.conversations.view(joined.conversationId, req.user.id),
      alreadyMember: joined.alreadyMember,
    });
  });

  /**
   * Join a public group directly — the Explore tab's join button. Same flow as
   * an invite join minus the invite bookkeeping; being public *is* the invite.
   */
  app.post('/:id/join', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await app.limiter.consume(`user:${req.user.id}`, 'member.add');

    const joined = await app.db.transaction(async (tx) => {
      const [conversation] = await tx.select().from(conversations).where(eq(conversations.id, id)).limit(1);
      // A private group must 404, not 403 — its existence is not the joiner's
      // business, which is the same rule requireMember applies to members.
      // A channel takes the same treatment: membership lives on its space, and
      // a joinable channel would be a side door around that.
      if (
        !conversation ||
        conversation.deletedAt ||
        !conversation.isPublic ||
        conversation.parentId
      ) {
        throw notFound('Conversation');
      }

      const [banned] = await tx
        .select({ userId: conversationBans.userId })
        .from(conversationBans)
        .where(and(eq(conversationBans.conversationId, id), eq(conversationBans.userId, req.user.id)))
        .limit(1);
      if (banned) throw forbidden('You are banned from this conversation');

      const [existing] = await tx
        .select()
        .from(conversationMembers)
        .where(and(eq(conversationMembers.conversationId, id), eq(conversationMembers.userId, req.user.id)))
        .limit(1);

      if (existing && !existing.leftAt) return { alreadyMember: true };

      if (existing) {
        await tx
          .update(conversationMembers)
          .set({ leftAt: null })
          .where(and(eq(conversationMembers.conversationId, id), eq(conversationMembers.userId, req.user.id)));
      } else {
        await tx.insert(conversationMembers).values({
          conversationId: id,
          userId: req.user.id,
          role: 'member',
          historyStartSeq: historyFloor(conversation.historyVisibility, conversation.messageSeq),
        });
      }

      await app.conversations.writeSystemMessage(tx, id, {
        event: 'member_joined',
        actorId: req.user.id,
      });

      await app.events.toConversation(
        id,
        Event.MemberAdd,
        {
          conversationId: id,
          userIds: [req.user.id],
          ...(await app.conversations.memberEventExtras(tx, id, [req.user.id])),
        },
        { exec: txExecutor(tx) },
      );

      return { alreadyMember: false };
    });

    return reply.send({
      conversation: await app.conversations.view(id, req.user.id),
      alreadyMember: joined.alreadyMember,
    });
  });

  // ── Discovery ─────────────────────────────────────────────────────────────

  app.get('/discover', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { limit } = cursorPagination.parse(req.query);
    // Directory search. Bounded and optional; an empty q is the browse page.
    const q = String((req.query as Record<string, unknown>).q ?? '')
      .trim()
      .slice(0, 64);

    const rows = await app.db
      .select({ conversation: conversations, avatarKey: media.objectKey })
      .from(conversations)
      .leftJoin(media, eq(media.id, conversations.avatarMediaId))
      .where(
        and(
          eq(conversations.isPublic, true),
          isNull(conversations.deletedAt),
          or(eq(conversations.type, 'space'), eq(conversations.type, 'group')),
          // You join a space, not one of its rooms. Listing channels here
          // would offer people a door into the middle of somewhere they are
          // not a member of.
          isNull(conversations.parentId),
          ...(q
            ? [
                or(
                  ilike(conversations.title, `%${q}%`),
                  ilike(conversations.handle, `%${q}%`),
                  ilike(conversations.description, `%${q}%`),
                ),
              ]
            : []),
        ),
      )
      .orderBy(desc(conversations.memberCount), desc(conversations.lastMessageAt))
      .limit(limit);

    /**
     * Warmth and liveness, batched over the page rather than per row.
     *
     * A place-first directory has to answer "is anyone there right now?" —
     * member count says how big a room is, not whether walking in means
     * company. Both lookups are additive fields on the wire, so a client that
     * has never heard of them (iOS in review) keeps rendering exactly what it
     * rendered before.
     */
    const ids = rows.map((r) => r.conversation.id);
    const here = new Map<string, number>();
    const live = new Set<string>();
    if (ids.length > 0) {
      const presenceRows = (await app.db.execute(
        raw`select m.conversation_id as id, count(distinct p.user_id)::int as n
              from presence p
              join conversation_members m on m.user_id = p.user_id and m.left_at is null
             where m.conversation_id = any(${uuidArray(ids)})
               and p.expires_at > now()
             group by 1`,
      )) as unknown as Array<{ id: string; n: number }>;
      for (const row of presenceRows) here.set(row.id, row.n);

      const callRows = (await app.db.execute(
        raw`select distinct conversation_id as id from calls
             where conversation_id = any(${uuidArray(ids)}) and state <> 'ended'`,
      )) as unknown as Array<{ id: string }>;
      for (const row of callRows) live.add(row.id);
    }

    return reply.send({
      conversations: rows.map((r) => ({
        id: r.conversation.id,
        type: r.conversation.type,
        title: r.conversation.title,
        description: r.conversation.description,
        handle: r.conversation.handle,
        memberCount: r.conversation.memberCount,
        avatarUrl: r.avatarKey ? `${process.env.S3_PUBLIC_BASE_URL}/${r.avatarKey}` : null,
        badge: r.conversation.badge,
        hereCount: here.get(r.conversation.id) ?? 0,
        live: live.has(r.conversation.id),
        createdAt: r.conversation.createdAt?.toISOString() ?? null,
        appearance:
          ((r.conversation.settings ?? {}) as { appearance?: unknown }).appearance ?? null,
      })),
    });
  });

  /** Who is typing / online — resolved lazily rather than pushed on connect. */
  app.get('/:id/presence', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await requireMember(app.db, id, req.user.id);

    const rows = (await app.db.execute(
      raw`select distinct p.user_id, p.status
            from presence p
            join conversation_members m
              on m.user_id = p.user_id and m.conversation_id = ${id}::uuid and m.left_at is null
           where p.expires_at > now()`,
    )) as unknown as Array<{ user_id: string; status: string }>;

    return reply.send({ online: rows.map((r) => ({ userId: r.user_id, status: r.status })) });
  });

  /**
   * The group profile in one round trip: members with live presence, media and
   * pin counts, and the active call. This is the payload behind the group-first
   * bet — the group screen has to feel like a *place*, and a place needs to
   * answer "who is here" and "what have we collected" instantly.
   */
  app.get('/:id/summary', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const ctx = await requireMember(app.db, id, req.user.id);
    // Counts respect history visibility: a member added later must not learn
    // how much was shared before they joined, even as a number.
    const floor = ctx.member.historyStartSeq;

    const [memberRows, presenceRows, countRows, activeCallRows] = await Promise.all([
      app.db
        .select({
          member: conversationMembers,
          user: users,
          avatarKey: media.objectKey,
          ...affiliationColumns,
        })
        .from(conversationMembers)
        .innerJoin(users, eq(users.id, conversationMembers.userId))
        .leftJoin(media, eq(media.id, users.avatarMediaId))
        .leftJoin(affiliationGroup, affiliationGroupOn(users.affiliationConversationId))
        .leftJoin(affiliationAvatar, affiliationAvatarOn())
        .leftJoin(affiliationMembership, affiliationMembershipOn(users.id))
        .where(and(eq(conversationMembers.conversationId, id), isNull(conversationMembers.leftAt)))
        .orderBy(
          raw`case ${conversationMembers.role}
                when 'owner' then 0 when 'admin' then 1 when 'moderator' then 2
                when 'member' then 3 else 4 end`,
          conversationMembers.userId,
        )
        .limit(100),
      app.db.execute(
        raw`select distinct p.user_id, p.status
              from presence p
              join conversation_members m
                on m.user_id = p.user_id and m.conversation_id = ${id}::uuid and m.left_at is null
             where p.expires_at > now()`,
      ) as Promise<unknown> as Promise<Array<{ user_id: string; status: string }>>,
      app.db.execute(
        raw`select
              (select count(distinct msg.id)::int
                 from messages msg
                 join message_attachments a on a.message_id = msg.id
                 join media md on md.id = a.media_id
                where msg.conversation_id = ${id}::uuid
                  and msg.deleted_at is null
                  and msg.seq >= ${floor}
                  and (md.mime_type like 'image/%' or md.mime_type like 'video/%'))
            + (select count(*)::int
                 from messages msg
                where msg.conversation_id = ${id}::uuid
                  and msg.type = 'gif'
                  and msg.deleted_at is null
                  and msg.seq >= ${floor}) as media_count,
              (select count(*)::int from pinned_messages where conversation_id = ${id}::uuid) as pin_count`,
      ) as Promise<unknown> as Promise<Array<{ media_count: number; pin_count: number }>>,
      app.db
        .select()
        .from(calls)
        .where(and(eq(calls.conversationId, id), ne(calls.state, 'ended')))
        .limit(1),
    ]);

    const statusByUser = new Map(presenceRows.map((r) => [r.user_id, r.status]));
    const summaryRoles = await loadMemberRoles(id, memberRows.map((r) => r.member.userId));

    const activeCall = activeCallRows[0] ?? null;
    let participantCount = 0;
    if (activeCall) {
      const joined = await app.db
        .select({ count: raw<number>`count(*)::int` })
        .from(callParticipants)
        .where(and(eq(callParticipants.callId, activeCall.id), eq(callParticipants.state, 'joined')));
      participantCount = joined[0]?.count ?? 0;
    }

    return reply.send({
      summary: {
        members: memberRows.map((r) => ({
          ...toMember(
            r.member,
            r.user,
            r.avatarKey,
            pickAffiliation(r),
            summaryRoles.get(r.member.userId) ?? [],
          ),
          presence: statusByUser.get(r.member.userId) ?? 'offline',
        })),
        onlineCount: statusByUser.size,
        counts: {
          media: countRows[0]?.media_count ?? 0,
          pins: countRows[0]?.pin_count ?? 0,
        },
        activeCall: activeCall
          ? { id: activeCall.id, mode: activeCall.mode, participantCount }
          : null,
      },
    });
  });
}

/**
 * The wire shape of a live location.
 *
 * `expiresAt` travels with every point so a client can draw "live until 6:40"
 * and stop by itself when the socket is quiet, rather than trusting that an
 * end event will always arrive.
 */
function toLiveLocation(row: typeof liveLocations.$inferSelect) {
  return {
    messageId: row.messageId,
    conversationId: row.conversationId,
    userId: row.userId,
    latitude: row.latitude,
    longitude: row.longitude,
    accuracy: row.accuracy,
    heading: row.heading,
    expiresAt: row.expiresAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}
