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
  gt,
  inArray,
  invites,
  isNull,
  media,
  memberRoles,
  ne,
  or,
  sql as raw,
  users,
} from '@yappy/db';
import {
  Event,
  Permission,
  addMembersBody,
  conflict,
  conversationStateBody,
  createConversationBody,
  createInviteBody,
  cursorPagination,
  effectivePermissions,
  forbidden,
  newId,
  notFound,
  outranks,
  parsePermissions,
  updateConversationBody,
  updateMemberBody,
  type MemberRole,
} from '@yappy/shared';
import type { FastifyInstance } from 'fastify';
import { materialiseChannelMember, requireMember, requirePermission } from '../lib/access.js';
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
import { toMember, toPublicUser, type MemberRoleBadge } from '../lib/serialize.js';

export async function conversationRoutes(app: FastifyInstance) {
  // ── List & create ─────────────────────────────────────────────────────────

  app.get('/', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { limit, cursor } = cursorPagination.parse(req.query);
    const { archived } = req.query as { archived?: string };
    const result = await app.conversations.list(req.user.id, {
      limit,
      before: cursor,
      archived: archived === 'true',
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
          historyStartSeq: conversation.messageSeq,
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
        { conversationId: conversation.id, userIds: [req.user.id] },
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
          historyStartSeq: conversation.messageSeq,
        });
      }

      await app.conversations.writeSystemMessage(tx, id, {
        event: 'member_joined',
        actorId: req.user.id,
      });

      await app.events.toConversation(
        id,
        Event.MemberAdd,
        { conversationId: id, userIds: [req.user.id] },
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
        ),
      )
      .orderBy(desc(conversations.memberCount), desc(conversations.lastMessageAt))
      .limit(limit);

    return reply.send({
      conversations: rows.map((r) => ({
        id: r.conversation.id,
        type: r.conversation.type,
        title: r.conversation.title,
        description: r.conversation.description,
        handle: r.conversation.handle,
        memberCount: r.conversation.memberCount,
        avatarUrl: r.avatarKey ? `${process.env.S3_PUBLIC_BASE_URL}/${r.avatarKey}` : null,
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
