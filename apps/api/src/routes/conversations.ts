import {
  channelWebhooks,
  lt,
  conversationAuditLog,
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
  createWebhookBody,
  has,
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
import { hashToken, newInviteCode } from '../lib/tokens.js';
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
import { randomBytes } from 'node:crypto';
import { env } from '../env.js';
import { logAudit } from '../lib/audit.js';
import { announceBoomerang } from '../lib/yapperNotify.js';
import {
  mediaUrl as mediaUrlFor,
  toMember,
  toPublicUser,
  type MemberRoleBadge,
} from '../lib/serialize.js';

type Row = Record<string, unknown>;
/** Postgres text timestamp → ISO 8601, or null if it is neither. */
function iso(value: unknown): string | null {
  if (!value) return null;
  const d = new Date(value as string);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** drizzle's SQL fragment type, without importing drizzle-orm directly. */
type Frag = ReturnType<typeof raw>;

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
          ? {
              basePermissions:
                body.basePermissions === null ? null : parsePermissions(body.basePermissions),
            }
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

    /*
     * One audit entry naming the fields, not one per field: the log answers
     * "who touched the settings and what did they touch", and five rows for
     * one save would read as five acts. DMs are skipped — an audit stream
     * for two people who can each already see everything is furniture.
     */
    if (ctx.conversation.type !== 'dm') {
      await logAudit(app, {
        conversationId: ctx.conversation.parentId ?? id,
        actorId: req.user.id,
        action: 'conversation.update',
        targetId: id,
        metadata: {
          changed: Object.keys(body),
          ...(ctx.conversation.parentId ? { channel: ctx.conversation.title } : {}),
        },
      });
    }

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

  /**
   * Who is in here.
   *
   * Resolved to the space for a channel. A channel's own member rows are
   * written lazily — the first time somebody reads or writes there — so
   * listing them answered with whoever had happened to open this channel,
   * and the @mention picker in a new channel offered one person: you.
   */
  app.get('/:id/members', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id: requested } = req.params as { id: string };
    const { limit, cursor } = cursorPagination.parse(req.query);
    const memberCtx = await requirePermission(
      app.db,
      requested,
      req.user.id,
      Permission.VIEW_CONVERSATION,
    );
    const id = memberCtx.conversation.parentId ?? requested;

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
   * One member, with what this group knows about them.
   *
   * The group-scoped half of a profile: their roles here, their rank, the
   * nickname this group calls them by, and when they joined. `GET /users/:id`
   * answers the other half — who they are everywhere — and knows nothing
   * about any group, which is why a profile opened from a chat could not say
   * what roles the person held in it.
   *
   * Resolved to the space for a channel, like every other membership
   * question: a channel member row is written lazily, so asking a channel
   * about somebody who has not opened it would answer "not a member".
   */
  app.get('/:id/members/:userId', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id: requested, userId } = req.params as { id: string; userId: string };
    const viewer = await requirePermission(
      app.db,
      requested,
      req.user.id,
      Permission.VIEW_CONVERSATION,
    );
    const id = viewer.conversation.parentId ?? requested;

    const [row] = await app.db
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
          eq(conversationMembers.userId, userId),
          isNull(conversationMembers.leftAt),
        ),
      )
      .limit(1);

    if (!row) throw notFound('Member');
    const roles = await loadMemberRoles(id, [userId]);

    return reply.send({
      member: toMember(row.member, row.user, row.avatarKey, pickAffiliation(row), roles.get(userId) ?? []),
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
    const result = await app.conversations.removeMember(req.user.id, id, userId);
    // Removing yourself is leaving, and leaving is not an admin act.
    if (userId !== req.user.id) {
      await logAudit(app, {
        conversationId: id,
        actorId: req.user.id,
        action: 'member.kicked',
        targetUserId: userId,
      });
    }
    return reply.send(result);
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

    /*
     * A per-member `allow` is a permission grant, and it was the one grant in
     * the app that nobody checked.
     *
     * `deny` above needs MUTE_MEMBERS and `role` needs MANAGE_ROLES, but
     * `allow` fell through to the update with only the rank check in front of
     * it — so any moderator could write ADMINISTRATOR into an ordinary
     * member's bitfield, and `effectivePermissions` ORs `allow` in near the
     * end where `has()` then treats it as every permission at once. Moderator
     * to administrator, in one PATCH, on an account they control.
     *
     * These are exactly the rules `assertCanGrant` applies to every role and
     * overwrite write in routes/roles.ts. There is no reason this door was
     * different, and the only client that sends `allow` sends it to the
     * overwrite endpoint, which has always been guarded.
     */
    if (body.allow !== undefined) {
      if (!(ctx.permissions & Permission.MANAGE_ROLES) && !(ctx.permissions & Permission.ADMINISTRATOR)) {
        throw forbidden('You cannot change permissions');
      }
      const wanted = parsePermissions(body.allow);
      if (ctx.member.role !== 'owner') {
        if ((wanted & ~ctx.permissions) !== 0n) {
          throw forbidden('You cannot grant a permission you do not have yourself');
        }
        if ((wanted & Permission.ADMINISTRATOR) !== 0n) {
          throw forbidden('Only the owner can grant administrator');
        }
      }
      // ...and never to a bot, owner or not. Same invariant as the install
      // and the role assignment: a credential in a deployment environment is
      // not a thing to hand the whole group to. See routes/roles.ts.
      if ((wanted & Permission.ADMINISTRATOR) !== 0n) {
        const [targetUser] = await app.db
          .select({ isBot: users.isBot })
          .from(users)
          .where(eq(users.id, userId))
          .limit(1);
        if (targetUser?.isBot) throw forbidden('An application cannot be granted administrator');
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

    if (body.role !== undefined) {
      await logAudit(app, {
        conversationId: id,
        actorId: req.user.id,
        action: 'member.role_changed',
        targetUserId: userId,
        metadata: { role: body.role, was: target.role },
      });
    }
    if (body.mutedUntil !== undefined) {
      await logAudit(app, {
        conversationId: id,
        actorId: req.user.id,
        action: body.mutedUntil ? 'member.muted' : 'member.unmuted',
        targetUserId: userId,
        metadata: body.mutedUntil ? { until: body.mutedUntil } : {},
      });
    }

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

  /**
   * Who changed what in this group, newest first.
   *
   * Gated on MANAGE_CONVERSATION: the log records the acts of people with
   * power, for the people who share it. Resolved to the space for a
   * channel, like every other container-scoped question.
   */
  app.get('/:id/audit', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = req.query as { before?: string; limit?: string };
    const limitRaw = Number(query.limit ?? 30);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, Math.trunc(limitRaw)), 50) : 30;
    const ctx = await requirePermission(app.db, id, req.user.id, Permission.MANAGE_CONVERSATION);
    const scope = ctx.conversation.parentId ?? id;

    const rows = await app.db
      .select()
      .from(conversationAuditLog)
      .where(
        and(
          eq(conversationAuditLog.conversationId, scope),
          query.before ? lt(conversationAuditLog.id, query.before) : undefined,
        ),
      )
      .orderBy(desc(conversationAuditLog.id))
      .limit(limit);

    // Actor and target names in one sweep. The metadata already snapshots
    // object labels; people are the one thing worth resolving live, since
    // a rename should follow the person.
    const userIds = [
      ...new Set(
        rows.flatMap((r) => [r.actorId, r.targetUserId]).filter((v): v is string => Boolean(v)),
      ),
    ];
    const people = userIds.length
      ? await app.db
          .select({ id: users.id, username: users.username, displayName: users.displayName })
          .from(users)
          .where(inArray(users.id, userIds))
      : [];
    const personById = new Map(people.map((p) => [p.id, p]));

    return reply.send({
      entries: rows.map((r) => ({
        id: r.id,
        action: r.action,
        createdAt: r.createdAt.toISOString(),
        actor: r.actorId ? (personById.get(r.actorId) ?? null) : null,
        targetUser: r.targetUserId ? (personById.get(r.targetUserId) ?? null) : null,
        targetId: r.targetId,
        metadata: r.metadata,
      })),
      nextCursor: rows.length === limit ? (rows.at(-1)?.id ?? null) : null,
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
    await logAudit(app, {
      conversationId: ctx.conversation.parentId ?? id,
      actorId: req.user.id,
      action: 'member.banned',
      targetUserId: userId,
      metadata: reason ? { reason } : {},
    });
    return reply.send({ banned: true });
  });

  app.delete('/:id/bans/:userId', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id, userId } = req.params as { id: string; userId: string };
    const banCtx = await requirePermission(app.db, id, req.user.id, Permission.BAN_MEMBERS);
    await app.db
      .delete(conversationBans)
      .where(and(eq(conversationBans.conversationId, id), eq(conversationBans.userId, userId)));
    await logAudit(app, {
      conversationId: banCtx.conversation.parentId ?? id,
      actorId: req.user.id,
      action: 'member.unbanned',
      targetUserId: userId,
    });
    return reply.send({ banned: false });
  });

  /**
   * The last N days of this place, in numbers worth repeating.
   *
   * "This month: 4,102 messages, 9 people talking, 3 joined." A group-first
   * app has no follower counts to point at; this is the social proof it has
   * instead — a reason to come back, and a thing people screenshot.
   *
   * For a space the window spans every channel, because "how alive is this
   * place" is a question about the place. Membership numbers still come
   * from the container, where membership lives.
   */
  app.get('/:id/recap', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const daysRaw = Number((req.query as { days?: string }).days ?? 30);
    const days = Number.isFinite(daysRaw) ? Math.min(Math.max(7, Math.trunc(daysRaw)), 90) : 30;
    const ctx = await requirePermission(app.db, id, req.user.id, Permission.VIEW_CONVERSATION);
    const container = ctx.conversation.parentId ?? id;
    // As ISO text, not a Date: this raw path marshals parameters as strings.
    const from = new Date(Date.now() - days * 86_400_000).toISOString();

    /*
     * Five aggregates, one round trip each, all bounded by the window and
     * the timeline indexes. System messages are excluded everywhere: a
     * recap counts what people said, and "X joined" is not that.
     */
    const scope = raw`(
      select c.id from conversations c
       where (c.id = ${container}::uuid or c.parent_id = ${container}::uuid)
         and c.deleted_at is null
    )`;

    const [counts] = (await app.db.execute(raw`
      select count(*)::int as messages,
             -- "talking" means people. A webhook posting deploy notes into a
             -- quiet room must not make the room read as inhabited.
             (count(distinct m.sender_id) filter (where u.is_bot = false))::int as active_members
        from messages m
        left join users u on u.id = m.sender_id
       where m.conversation_id in ${scope}
         and m.created_at > ${from}::timestamptz
         and m.deleted_at is null
         and m.type <> 'system'
    `)) as unknown as Array<{ messages: number; active_members: number }>;

    const [joined] = (await app.db.execute(raw`
      select count(*)::int as joined
        from conversation_members
       where conversation_id = ${container}::uuid
         and joined_at > ${from}
         and left_at is null
    `)) as unknown as Array<{ joined: number }>;

    const topSenders = (await app.db.execute(raw`
      select m.sender_id, count(*)::int as count,
             u.username, u.display_name
        from messages m
        join users u on u.id = m.sender_id
       where m.conversation_id in ${scope}
         and m.created_at > ${from}::timestamptz
         and m.deleted_at is null
         and m.type <> 'system'
         and u.is_bot = false
       group by m.sender_id, u.username, u.display_name
       order by count desc
       limit 3
    `)) as unknown as Array<{
      sender_id: string;
      count: number;
      username: string | null;
      display_name: string | null;
    }>;

    const [topEmoji] = (await app.db.execute(raw`
      select r.emoji, count(*)::int as count
        from message_reactions r
        join messages m on m.id = r.message_id
       where m.conversation_id in ${scope}
         and r.created_at > ${from}::timestamptz
         and r.emoji not like 'sticker:%'
       group by r.emoji
       order by count desc
       limit 1
    `)) as unknown as Array<{ emoji: string; count: number }>;

    const [busiest] = (await app.db.execute(raw`
      select date_trunc('day', created_at)::date::text as day, count(*)::int as count
        from messages
       where conversation_id in ${scope}
         and created_at > ${from}::timestamptz
         and deleted_at is null
         and type <> 'system'
       group by 1
       order by count desc
       limit 1
    `)) as unknown as Array<{ day: string; count: number }>;

    return reply.send({
      days,
      messages: counts?.messages ?? 0,
      activeMembers: counts?.active_members ?? 0,
      newMembers: joined?.joined ?? 0,
      topSenders: topSenders.map((s) => ({
        userId: s.sender_id,
        username: s.username,
        displayName: s.display_name,
        count: s.count,
      })),
      topEmoji: topEmoji ?? null,
      busiestDay: busiest ?? null,
    });
  });

  /**
   * A forum's front page: post roots, liveliest first.
   *
   * Deliberately not the message list with a filter on it. The top level of
   * a forum is a different question from "what was said here" — it wants
   * titles, reply counts, and who spoke last, ordered by when each post was
   * last touched rather than when it was made. A week-old question that got
   * an answer this morning belongs at the top; that is the whole point of
   * the posture.
   *
   * Pinned posts sort above everything, which is what a pin means on a page
   * that reorders itself.
   */
  app.get('/:id/posts', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { cursor?: string; limit?: string };
    const limit = Math.min(Math.max(Number(q.limit ?? 30) || 30, 1), 50);
    await requirePermission(app.db, id, req.user.id, Permission.VIEW_CONVERSATION);

    /*
     * The cursor is the sort key itself — "<iso>|<uuid>" — compared as a
     * tuple. A plain timestamp cursor would drop rows whenever two posts
     * shared a last-reply instant, which is exactly what happens when a
     * backfill stamps a batch of them with the same value.
     */
    let cursorTs: string | null = null;
    let cursorId: string | null = null;
    if (q.cursor) {
      const [ts, cid] = q.cursor.split('|');
      if (ts && cid) {
        cursorTs = ts;
        cursorId = cid;
      }
    }

    /*
     * Pinned posts are fetched separately and only on the first page.
     *
     * They sort above everything, which is what a pin means on a page that
     * reorders itself — but "above everything" and a keyset cursor are not
     * compatible: the cursor compares activity, so a pinned post with recent
     * activity survives its own page's filter and comes back again on the
     * next one. Taking pins out of the paged query removes the conflict
     * instead of encoding rank into the cursor, and pins are bounded per
     * conversation, so there is nothing to page through.
     */
    const select = (where: Frag, order: Frag, lim: number) => raw`
      select m.id, m.title, m.content, m.created_at, m.thread_reply_count,
             coalesce(m.thread_last_reply_at, m.created_at) as last_activity_at,
             (p.message_id is not null) as pinned,
             u.id as author_id, u.username, u.display_name, u.is_bot,
             u.is_verified, u.badge, u.badges, av.object_key as avatar_key
        from messages m
        left join users u on u.id = m.sender_id
        left join media av on av.id = u.avatar_media_id
        left join pinned_messages p on p.message_id = m.id
       where m.conversation_id = ${id}::uuid
         and m.thread_root_id is null
         and m.deleted_at is null
         and m.type <> 'system'
         ${where}
       ${order}
       limit ${lim}`;

    const byActivity = raw`order by last_activity_at desc, m.id desc`;

    const pinnedRows = cursorTs
      ? []
      : ((await app.db.execute(
          select(raw`and p.message_id is not null`, byActivity, LIMITS.pinnedPerConversation ?? 50),
        )) as unknown as Row[]);

    const rows = (await app.db.execute(
      select(
        raw`and p.message_id is null ${
          cursorTs && cursorId
            ? raw`and (coalesce(m.thread_last_reply_at, m.created_at), m.id)
                   < (${cursorTs}::timestamptz, ${cursorId}::uuid)`
            : raw``
        }`,
        byActivity,
        limit + 1,
      ),
    )) as unknown as Row[];

    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const shape = (r: Row) => ({
      id: r.id as string,
      title: (r.title as string | null) ?? null,
      // A snippet, not the body. A forum list that renders whole posts is a
      // chat channel with extra steps.
      excerpt: ((r.content as string | null) ?? '').slice(0, 200),
      // This raw path hands back timestamps as Postgres text ("2026-08-30
      // 12:34:56.789+00"), which is not ISO 8601 — close enough that a
      // browser parses it and a stricter parser does not. Normalised here
      // rather than in each client: Android's Instant.parse rejected it and
      // every row's age rendered blank.
      createdAt: iso(r.created_at),
      lastActivityAt: iso(r.last_activity_at),
      replyCount: (r.thread_reply_count as number) ?? 0,
      pinned: Boolean(r.pinned),
      author: r.author_id
        ? toPublicUser(
            {
              id: r.author_id as string,
              username: r.username as string | null,
              displayName: r.display_name as string | null,
              isBot: r.is_bot as boolean,
              isVerified: r.is_verified as boolean,
              badge: r.badge as never,
              badges: r.badges as never,
            } as never,
            r.avatar_key as string | null,
          )
        : null,
    });

    return reply.send({
      posts: [...pinnedRows.map(shape), ...page.map(shape)],
      nextCursor:
        rows.length > limit && last
          ? `${last.last_activity_at as string}|${last.id as string}`
          : null,
    });
  });

  // ── Incoming webhooks ─────────────────────────────────────────────────────
  //
  // A URL that posts into this channel. The webhook is a lightweight bot: a
  // user row so its messages have an ordinary sender, plus a token — no
  // application, no socket, no process. Paste the URL into GitHub, Grafana,
  // or a cron job, and POST at it.

  app.post('/:id/webhooks', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = createWebhookBody.parse(req.body);
    const ctx = await requirePermission(app.db, id, req.user.id, Permission.MANAGE_CONVERSATION);
    if (ctx.conversation.type === 'dm') throw conflict('A direct message cannot have webhooks');
    await app.limiter.consume(`user:${req.user.id}`, 'conversation.create');

    const token = `yw_${randomBytes(32).toString('base64url')}`;
    const webhookId = newId();
    const botUserId = newId();
    const container = ctx.conversation.parentId ?? id;

    await app.db.transaction(async (tx) => {
      await tx.insert(users).values({
        id: botUserId,
        // Unguessable and unique enough: the id already is. Nobody types
        // a webhook's handle; it exists so the sender renders like any
        // other bot.
        username: `wh_${botUserId.replaceAll('-', '').slice(0, 12)}`,
        displayName: body.name,
        isBot: true,
      });

      await tx.insert(channelWebhooks).values({
        id: webhookId,
        conversationId: id,
        botUserId,
        name: body.name,
        tokenHash: hashToken(token),
        createdById: req.user.id,
      });

      /*
       * Membership, and standing permission to post here.
       *
       * The container row is what loadMemberContext resolves authority
       * through; the per-channel allow is what lets the webhook post into
       * an announcement or gated channel. That is deliberate: creating a
       * webhook takes MANAGE_CONVERSATION, so the webhook existing *is*
       * the authorisation, the same way it is everywhere else webhooks
       * live.
       */
      await tx.insert(conversationMembers).values({
        conversationId: container,
        userId: botUserId,
        role: 'member',
        historyStartSeq: 0,
        ...(container === id
          ? {
              allow:
                Permission.VIEW_CONVERSATION |
                Permission.READ_HISTORY |
                Permission.SEND_MESSAGES |
                Permission.EMBED_LINKS,
            }
          : {}),
      });
      if (container !== id) {
        await tx.insert(conversationMembers).values({
          conversationId: id,
          userId: botUserId,
          role: 'member',
          historyStartSeq: 0,
          allow:
            Permission.VIEW_CONVERSATION |
            Permission.READ_HISTORY |
            Permission.SEND_MESSAGES |
            Permission.EMBED_LINKS,
        });
      }
    });

    await logAudit(app, {
      conversationId: container,
      actorId: req.user.id,
      action: 'webhook.create',
      targetId: webhookId,
      metadata: {
        name: body.name,
        ...(ctx.conversation.parentId ? { channel: ctx.conversation.title } : {}),
      },
    });

    return reply.status(201).send({
      webhook: {
        id: webhookId,
        name: body.name,
        // Shown once, like every credential here. There is no endpoint
        // that will show it again.
        url: `${env.PUBLIC_API_URL}/v1/webhooks/${webhookId}/${token}`,
        createdAt: new Date().toISOString(),
      },
    });
  });

  app.get('/:id/webhooks', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await requirePermission(app.db, id, req.user.id, Permission.MANAGE_CONVERSATION);
    const rows = await app.db
      .select()
      .from(channelWebhooks)
      .where(and(eq(channelWebhooks.conversationId, id), isNull(channelWebhooks.revokedAt)))
      .orderBy(desc(channelWebhooks.createdAt));
    return reply.send({
      webhooks: rows.map((w) => ({
        id: w.id,
        name: w.name,
        createdAt: w.createdAt.toISOString(),
        lastUsedAt: w.lastUsedAt?.toISOString() ?? null,
      })),
    });
  });

  app.delete('/:id/webhooks/:webhookId', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id, webhookId } = req.params as { id: string; webhookId: string };
    const whCtx = await requirePermission(app.db, id, req.user.id, Permission.MANAGE_CONVERSATION);

    const [row] = await app.db
      .select()
      .from(channelWebhooks)
      .where(and(eq(channelWebhooks.id, webhookId), eq(channelWebhooks.conversationId, id)))
      .limit(1);
    if (!row || row.revokedAt) throw notFound('Webhook');

    await app.db
      .update(channelWebhooks)
      .set({ revokedAt: new Date() })
      .where(eq(channelWebhooks.id, webhookId));

    // Quiet removal, not a kick: no system message for software leaving.
    await app.db
      .update(conversationMembers)
      .set({ leftAt: new Date() })
      .where(eq(conversationMembers.userId, row.botUserId));

    await logAudit(app, {
      conversationId: whCtx.conversation.parentId ?? id,
      actorId: req.user.id,
      action: 'webhook.delete',
      targetId: webhookId,
      metadata: { name: row.name },
    });

    return reply.send({ revoked: true });
  });

  // ── Invites ───────────────────────────────────────────────────────────────

  app.post('/:id/invites', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = createInviteBody.parse(req.body);
    const ctx = await requirePermission(app.db, id, req.user.id, Permission.MANAGE_INVITES);
    await app.limiter.consume(`user:${req.user.id}`, 'invite.create');

    /*
     * An invite that grants a role is a standing grant of that role, so it
     * takes the same escalation guard as assigning one directly: you cannot
     * give away bits you do not hold. Without this, MANAGE_INVITES becomes
     * a privilege-escalation primitive — mint a link carrying an admin
     * role, redeem it yourself, done.
     */
    let grantedRole: { id: string; name: string; color: string | null } | null = null;
    if (body.roleId) {
      const scope = ctx.conversation.parentId ?? id;
      const [role] = await app.db
        .select()
        .from(conversationRoles)
        .where(and(eq(conversationRoles.id, body.roleId), eq(conversationRoles.conversationId, scope)))
        .limit(1);
      if (!role) throw notFound('Role');
      /*
       * An invite that grants a role is a grant, and it gets the grant rules.
       *
       * The subset test was already here. What was missing is the second half
       * of `assertCanGrant`: ADMINISTRATOR is the owner's to hand out and
       * nobody else's, because it is the permission that decides who can take
       * the group away from its owner. An administrator is exempt from the
       * subset test — they hold everything, so it is vacuous — but exemption
       * from that test was being read as exemption from the rule, and a
       * non-owner admin could mint a link that made a stranger an
       * administrator. Redemption re-checks nothing, so the link was the
       * whole attack.
       */
      if (
        (role.permissions & Permission.ADMINISTRATOR) !== 0n &&
        ctx.member.role !== 'owner'
      ) {
        throw forbidden('Only the owner can grant administrator');
      }
      const exempt =
        ctx.member.role === 'owner' || has(ctx.permissions, Permission.ADMINISTRATOR);
      if (!exempt && (role.permissions & ~ctx.permissions) !== 0n) {
        throw forbidden('That role grants permissions you do not hold');
      }
      grantedRole = { id: role.id, name: role.name, color: role.color };
    }

    const code = newInviteCode();
    const [invite] = await app.db
      .insert(invites)
      .values({
        id: newId(),
        conversationId: id,
        code,
        createdById: req.user.id,
        roleId: body.roleId ?? null,
        maxUses: body.maxUses,
        expiresAt: body.expiresInSeconds ? new Date(Date.now() + body.expiresInSeconds * 1000) : null,
      })
      .returning();

    await logAudit(app, {
      conversationId: ctx.conversation.parentId ?? id,
      actorId: req.user.id,
      action: 'invite.create',
      targetId: invite!.code,
      metadata: grantedRole ? { role: grantedRole.name } : {},
    });

    return reply.status(201).send({
      invite: {
        code: invite!.code,
        url: `https://yappy.gg/join/${invite!.code}`,
        maxUses: invite!.maxUses,
        uses: invite!.uses,
        expiresAt: invite!.expiresAt?.toISOString() ?? null,
        role: grantedRole,
      },
    });
  });

  app.get('/:id/invites', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await requirePermission(app.db, id, req.user.id, Permission.MANAGE_INVITES);
    // Left join, because the role may have been deleted since the invite
    // was minted — the invite still admits, so it still lists.
    const rows = await app.db
      .select({ invite: invites, role: conversationRoles })
      .from(invites)
      .leftJoin(conversationRoles, eq(conversationRoles.id, invites.roleId))
      .where(and(eq(invites.conversationId, id), isNull(invites.revokedAt)))
      .orderBy(desc(invites.createdAt));
    return reply.send({
      invites: rows.map(({ invite: i, role }) => ({
        code: i.code,
        url: `https://yappy.gg/join/${i.code}`,
        maxUses: i.maxUses,
        uses: i.uses,
        expiresAt: i.expiresAt?.toISOString() ?? null,
        createdAt: i.createdAt.toISOString(),
        role: role ? { id: role.id, name: role.name, color: role.color } : null,
      })),
    });
  });

  app.delete('/:id/invites/:code', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id, code } = req.params as { id: string; code: string };
    const revokeCtx = await requirePermission(app.db, id, req.user.id, Permission.MANAGE_INVITES);
    await app.db
      .update(invites)
      .set({ revokedAt: new Date() })
      .where(and(eq(invites.conversationId, id), eq(invites.code, code)));
    await logAudit(app, {
      conversationId: revokeCtx.conversation.parentId ?? id,
      actorId: req.user.id,
      action: 'invite.revoke',
      targetId: code,
    });
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
      /**
       * What joining hands you, when the invite carries a role.
       *
       * Named on the preview because it changes the decision: "join the
       * server" and "join the server as Premium" are different offers, and
       * a grant somebody only discovers afterwards reads as a mistake.
       */
      grantsRole: await (async () => {
        if (!row.invite.roleId) return null;
        const [role] = await app.db
          .select({ name: conversationRoles.name, color: conversationRoles.color })
          .from(conversationRoles)
          .where(eq(conversationRoles.id, row.invite.roleId))
          .limit(1);
        return role ?? null;
      })(),
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
        created_by_id: string;
        role_id: string | null;
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

      if (existing && !existing.leftAt) {
        return { conversationId: conversation.id, alreadyMember: true, rejoinCount: 0 };
      }

      let rejoinCount = 0;
      if (existing) {
        const [back] = await tx
          .update(conversationMembers)
          .set({ leftAt: null, rejoinCount: raw`${conversationMembers.rejoinCount} + 1` })
          .where(
            and(
              eq(conversationMembers.conversationId, conversation.id),
              eq(conversationMembers.userId, req.user.id),
            ),
          )
          .returning({ rejoinCount: conversationMembers.rejoinCount });
        rejoinCount = back?.rejoinCount ?? 0;
      } else {
        await tx.insert(conversationMembers).values({
          conversationId: conversation.id,
          userId: req.user.id,
          role: 'member',
          historyStartSeq: historyFloor(conversation.historyVisibility, conversation.messageSeq),
        });
      }

      await tx.execute(raw`update invites set uses = uses + 1 where id = ${invite.id}::uuid`);

      /*
       * The role the invite carries, if it still exists.
       *
       * Verified against the conversation rather than trusted: the column
       * has no foreign key (see the schema), so a role deleted since the
       * invite was minted is an ordinary case, and the answer is to admit
       * without granting rather than to refuse — the invite is the offer
       * to join; the role rides on it.
       *
       * `assignedById` is the inviter: the grant is theirs, made when they
       * minted the link, and the audit trail should say so rather than
       * crediting the stranger who happened to click it.
       */
      if (invite.role_id) {
        const [role] = await tx
          .select({ id: conversationRoles.id })
          .from(conversationRoles)
          .where(
            and(
              eq(conversationRoles.id, invite.role_id),
              eq(conversationRoles.conversationId, conversation.id),
            ),
          )
          .limit(1);
        if (role) {
          await tx
            .insert(memberRoles)
            .values({
              conversationId: conversation.id,
              userId: req.user.id,
              roleId: role.id,
              assignedById: invite.created_by_id,
            })
            .onConflictDoNothing();
        }
      }

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

      return { conversationId: conversation.id, alreadyMember: false, rejoinCount };
    });

    // After the commit, and never awaited: a joke must not slow a join down
    // or fail it.
    void announceBoomerang(app, joined.conversationId, req.user.id, joined.rejoinCount);

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

      if (existing && !existing.leftAt) return { alreadyMember: true, rejoinCount: 0 };

      let rejoinCount = 0;
      if (existing) {
        const [back] = await tx
          .update(conversationMembers)
          .set({ leftAt: null, rejoinCount: raw`${conversationMembers.rejoinCount} + 1` })
          .where(and(eq(conversationMembers.conversationId, id), eq(conversationMembers.userId, req.user.id)))
          .returning({ rejoinCount: conversationMembers.rejoinCount });
        rejoinCount = back?.rejoinCount ?? 0;
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

      return { alreadyMember: false, rejoinCount };
    });

    void announceBoomerang(app, id, req.user.id, joined.rejoinCount);

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
