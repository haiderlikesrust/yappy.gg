import {
  and,
  applications,
  conversationApps,
  conversationMembers,
  conversations,
  conversationRoleOverwrites,
  conversationRoles,
  eq,
  inArray,
  isNull,
  memberRoles,
  sql as raw,
  users,
} from '@yappy/db';
import {
  ALL_PERMISSIONS,
  conflict,
  createRoleBody,
  Event,
  forbidden,
  has,
  installAppBody,
  LIMITS,
  missingPermission,
  newId,
  notFound,
  outranks,
  parsePermissions,
  Permission,
  permissionNames,
  serializePermissions,
  setChannelOverwriteBody,
  setMemberRolesBody,
  unprocessable,
  updateRoleBody,
  type MemberRole,
} from '@yappy/shared';
import type { FastifyInstance } from 'fastify';
import { assertMayActOn, requireMember, requirePermission } from '../lib/access.js';
import { logAudit } from '../lib/audit.js';
import { toPublicUser } from '../lib/serialize.js';

/**
 * Named roles.
 *
 * Mounted under /conversations so a role always belongs to something — there
 * are no free-floating roles, and deleting a group takes its roles with it.
 *
 * The one rule that makes this safe: **you cannot grant what you do not have**.
 * Without it, MANAGE_ROLES is a privilege-escalation primitive — create a role
 * with ADMINISTRATOR, assign it to yourself, done. That check appears at every
 * write below and is the reason each of them loads the actor's own effective
 * permissions first.
 */
export async function roleRoutes(app: FastifyInstance) {
  const serialize = (r: typeof conversationRoles.$inferSelect) => ({
    id: r.id,
    name: r.name,
    color: r.color,
    permissions: serializePermissions(r.permissions),
    position: r.position,
    isHoisted: r.isHoisted,
    isMentionable: r.isMentionable,
  });

  /**
   * Escalation guard. An owner is exempt because they already hold everything;
   * anyone else may only put bits into a role that they personally have.
   */
  const assertCanGrant = (ctx: { permissions: bigint; member: { role: string } }, wanted: bigint) => {
    if (ctx.member.role === 'owner') return;
    const missing = wanted & ~ctx.permissions;
    if (missing !== 0n) {
      throw forbidden('You cannot grant a permission you do not have yourself');
    }
    // ADMINISTRATOR is every permission at once, forever. Restricting it to the
    // owner keeps "who can take this group away from me" answerable.
    if ((wanted & Permission.ADMINISTRATOR) !== 0n) {
      throw forbidden('Only the owner can grant administrator');
    }
  };

  /**
   * The roles that apply here.
   *
   * Resolved to the space for a channel, because that is where roles live —
   * asking a channel used to answer with an empty list, which is a fine way
   * to render a composer that offers no roles to mention in the only kind of
   * conversation most people use. The writes below stay literal: creating a
   * role from a channel's path is a client bug, not something to paper over.
   */
  app.get('/:id/roles', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const ctx = await requirePermission(app.db, id, req.user.id, Permission.VIEW_CONVERSATION);
    const scope = ctx.conversation.parentId ?? id;

    const rows = await app.db
      .select()
      .from(conversationRoles)
      .where(eq(conversationRoles.conversationId, scope))
      .orderBy(raw`${conversationRoles.position} desc`, conversationRoles.name);

    return reply.send({ roles: rows.map(serialize) });
  });

  /**
   * What each role may and may not do in this channel.
   *
   * The missing piece between two settings that already existed: a
   * channel-wide floor, which applies to everybody, and space-wide roles,
   * which only ever add and apply everywhere. Neither can say "this channel
   * is for Premium". Together with an overwrite they can: floor the channel
   * to nothing, then allow the role back in here.
   */
  app.get('/:id/permissions', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await requirePermission(app.db, id, req.user.id, Permission.VIEW_CONVERSATION);

    const rows = await app.db
      .select()
      .from(conversationRoleOverwrites)
      .where(eq(conversationRoleOverwrites.conversationId, id));

    return reply.send({
      overwrites: rows.map((r) => ({
        roleId: r.roleId,
        allow: serializePermissions(r.allow),
        deny: serializePermissions(r.deny),
      })),
    });
  });

  /**
   * Set one role's overwrite here. Absent fields are left alone.
   *
   * Subject to the same escalation guard as everything else in this file:
   * you cannot allow a bit you do not hold. Denying is not guarded the same
   * way — taking a permission away in one channel is a smaller act than
   * granting one, and the ladder above already stops somebody restricting a
   * channel they cannot manage.
   */
  app.put('/:id/permissions/:roleId', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id, roleId } = req.params as { id: string; roleId: string };
    const body = setChannelOverwriteBody.parse(req.body);
    const ctx = await requirePermission(app.db, id, req.user.id, Permission.MANAGE_ROLES);

    // The role has to belong to the space this channel lives in. Without
    // this, any role id from anywhere would be accepted and silently never
    // match a member — a setting that appears to save and does nothing.
    const scope = ctx.conversation.parentId ?? id;
    const [role] = await app.db
      .select({ id: conversationRoles.id, name: conversationRoles.name })
      .from(conversationRoles)
      .where(and(eq(conversationRoles.id, roleId), eq(conversationRoles.conversationId, scope)))
      .limit(1);
    if (!role) throw notFound('Role');

    const allow = parsePermissions(body.allow) & ALL_PERMISSIONS;
    const deny = parsePermissions(body.deny) & ALL_PERMISSIONS;
    assertCanGrant(ctx, allow);

    const [saved] = await app.db
      .insert(conversationRoleOverwrites)
      .values({ conversationId: id, roleId, allow, deny })
      .onConflictDoUpdate({
        target: [conversationRoleOverwrites.conversationId, conversationRoleOverwrites.roleId],
        set: { allow, deny },
      })
      .returning();

    await logAudit(app, {
      conversationId: scope,
      actorId: req.user.id,
      action: 'channel.overwrite_set',
      targetId: id,
      metadata: {
        channel: ctx.conversation.title,
        role: role.name,
        allow: serializePermissions(saved!.allow),
        deny: serializePermissions(saved!.deny),
      },
    });

    return reply.send({
      overwrite: {
        roleId: saved!.roleId,
        allow: serializePermissions(saved!.allow),
        deny: serializePermissions(saved!.deny),
      },
    });
  });

  /** Remove a role's overwrite, so the channel says nothing about it. */
  app.delete('/:id/permissions/:roleId', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id, roleId } = req.params as { id: string; roleId: string };
    const rmCtx = await requirePermission(app.db, id, req.user.id, Permission.MANAGE_ROLES);

    await app.db
      .delete(conversationRoleOverwrites)
      .where(
        and(
          eq(conversationRoleOverwrites.conversationId, id),
          eq(conversationRoleOverwrites.roleId, roleId),
        ),
      );

    await logAudit(app, {
      conversationId: rmCtx.conversation.parentId ?? id,
      actorId: req.user.id,
      action: 'channel.overwrite_remove',
      targetId: id,
      metadata: { channel: rmCtx.conversation.title },
    });

    return reply.send({ removed: true });
  });

  app.post('/:id/roles', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = createRoleBody.parse(req.body);
    const ctx = await requirePermission(app.db, id, req.user.id, Permission.MANAGE_ROLES);

    if (ctx.conversation.type === 'dm') throw conflict('A direct message has no roles');

    const permissions = parsePermissions(body.permissions) & ALL_PERMISSIONS;
    assertCanGrant(ctx, permissions);

    const [{ count }] = (await app.db
      .select({ count: raw<number>`count(*)::int` })
      .from(conversationRoles)
      .where(eq(conversationRoles.conversationId, id))) as [{ count: number }];
    if (count >= LIMITS.rolesPerConversation) {
      throw unprocessable(`A group can have at most ${LIMITS.rolesPerConversation} roles`);
    }

    try {
      const [created] = await app.db
        .insert(conversationRoles)
        .values({
          id: newId(),
          conversationId: id,
          name: body.name,
          color: body.color ?? null,
          permissions,
          position: body.position,
          isHoisted: body.isHoisted,
          isMentionable: body.isMentionable,
        })
        .returning();

      await app.events.toConversation(id, Event.ConversationUpdate, {
        id,
        rolesChanged: true,
      });
      await logAudit(app, {
        conversationId: ctx.conversation.parentId ?? id,
        actorId: req.user.id,
        action: 'role.create',
        targetId: created!.id,
        metadata: { name: created!.name },
      });
      return reply.status(201).send({ role: serialize(created!) });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw conflict('A role with that name already exists');
      throw err;
    }
  });

  app.patch('/:id/roles/:roleId', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id, roleId } = req.params as { id: string; roleId: string };
    const body = updateRoleBody.parse(req.body);
    const ctx = await requirePermission(app.db, id, req.user.id, Permission.MANAGE_ROLES);

    const [existing] = await app.db
      .select()
      .from(conversationRoles)
      .where(and(eq(conversationRoles.id, roleId), eq(conversationRoles.conversationId, id)))
      .limit(1);
    if (!existing) throw notFound('Role');

    if (body.permissions !== undefined) {
      const next = parsePermissions(body.permissions) & ALL_PERMISSIONS;
      // Only the *added* bits need checking. Someone who cannot grant BAN can
      // still edit the colour of a role that already carries it — refusing
      // that would make roles uneditable by anyone but the owner.
      assertCanGrant(ctx, next & ~existing.permissions);
    }

    try {
      const [updated] = await app.db
        .update(conversationRoles)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.color !== undefined ? { color: body.color } : {}),
          ...(body.permissions !== undefined
            ? { permissions: parsePermissions(body.permissions) & ALL_PERMISSIONS }
            : {}),
          ...(body.position !== undefined ? { position: body.position } : {}),
          ...(body.isHoisted !== undefined ? { isHoisted: body.isHoisted } : {}),
          ...(body.isMentionable !== undefined ? { isMentionable: body.isMentionable } : {}),
        })
        .where(eq(conversationRoles.id, roleId))
        .returning();

      await app.events.toConversation(id, Event.ConversationUpdate, { id, rolesChanged: true });
      await logAudit(app, {
        conversationId: ctx.conversation.parentId ?? id,
        actorId: req.user.id,
        action: 'role.update',
        targetId: roleId,
        // Both names, because a rename is the one edit where the old label
        // is the interesting half.
        metadata: { name: updated!.name, was: existing.name, changed: Object.keys(body) },
      });
      return reply.send({ role: serialize(updated!) });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw conflict('A role with that name already exists');
      throw err;
    }
  });

  app.delete('/:id/roles/:roleId', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id, roleId } = req.params as { id: string; roleId: string };
    const ctx = await requirePermission(app.db, id, req.user.id, Permission.MANAGE_ROLES);

    const [existing] = await app.db
      .select()
      .from(conversationRoles)
      .where(and(eq(conversationRoles.id, roleId), eq(conversationRoles.conversationId, id)))
      .limit(1);
    if (!existing) throw notFound('Role');

    // Deleting a role revokes everything it granted, so it needs the same
    // authority as creating it would.
    assertCanGrant(ctx, existing.permissions);

    // Assignments go with it via ON DELETE CASCADE.
    await app.db.delete(conversationRoles).where(eq(conversationRoles.id, roleId));

    await app.events.toConversation(id, Event.ConversationUpdate, { id, rolesChanged: true });
    await logAudit(app, {
      conversationId: ctx.conversation.parentId ?? id,
      actorId: req.user.id,
      action: 'role.delete',
      targetId: roleId,
      metadata: { name: existing.name },
    });
    return reply.send({ deleted: true });
  });

  /**
   * Replace a member's roles wholesale.
   *
   * A full set rather than add/remove deltas: the UI is a list of checkboxes,
   * and two admins editing the same member concurrently should land on one of
   * their intents rather than the union of both.
   */
  app.put('/:id/members/:userId/roles', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id, userId } = req.params as { id: string; userId: string };
    const body = setMemberRolesBody.parse(req.body);
    const ctx = await requirePermission(app.db, id, req.user.id, Permission.MANAGE_ROLES);

    const [target] = await app.db
      .select()
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, id),
          eq(conversationMembers.userId, userId),
          isNull(conversationMembers.leftAt),
        ),
      )
      .limit(1);
    if (!target) throw notFound('Member');

    // Assigning roles changes what someone can do, so it is subject to the same
    // ladder as every other action taken on a person — with the one relief for
    // an installed application, which has a grant rather than a rank. See
    // `assertMayActOn` for why that is safe and how narrow it is.
    if (userId !== req.user.id) {
      await assertMayActOn(app.db, ctx, id, target.role as MemberRole);
    }

    const wanted = [...new Set(body.roleIds)];
    const rows = wanted.length
      ? await app.db
          .select()
          .from(conversationRoles)
          .where(and(eq(conversationRoles.conversationId, id), inArray(conversationRoles.id, wanted)))
      : [];
    if (rows.length !== wanted.length) throw notFound('Role');

    const [current] = await app.db
      // `conversationRoles.permissions` rather than a hand-written `r.permissions`:
      // Drizzle emits the table under its real name, so a made-up alias is a
      // missing-FROM-clause error at runtime.
      .select({ held: raw<string>`coalesce(bit_or(${conversationRoles.permissions}), 0)::text` })
      .from(memberRoles)
      .innerJoin(conversationRoles, eq(conversationRoles.id, memberRoles.roleId))
      .where(and(eq(memberRoles.conversationId, id), eq(memberRoles.userId, userId)));

    const held = parsePermissions(current?.held);
    const next = rows.reduce((acc, r) => acc | r.permissions, 0n);
    // Only the delta in either direction needs authority — an admin without
    // BAN_MEMBERS should not be able to hand it out *or* strip it.
    assertCanGrant(ctx, (next & ~held) | (held & ~next));

    await app.db.transaction(async (tx) => {
      await tx
        .delete(memberRoles)
        .where(and(eq(memberRoles.conversationId, id), eq(memberRoles.userId, userId)));
      if (rows.length) {
        await tx.insert(memberRoles).values(
          rows.map((r) => ({
            conversationId: id,
            userId,
            roleId: r.id,
            assignedById: req.user.id,
          })),
        );
      }
    });

    await app.events.toConversation(id, Event.MemberUpdate, {
      conversationId: id,
      userId,
      role: target.role,
      roleIds: rows.map((r) => r.id),
    });

    await logAudit(app, {
      conversationId: ctx.conversation.parentId ?? id,
      actorId: req.user.id,
      action: 'member.roles_set',
      targetUserId: userId,
      // The whole set rather than the delta, because the endpoint is a
      // full replacement and the entry should read the same way.
      metadata: { roles: rows.map((r) => r.name) },
    });

    return reply.send({ roles: rows.map(serialize) });
  });
  // ─── Installed applications ────────────────────────────────────────────────
  //
  // A bot's authority in a space, granted per install by a human who holds the
  // bits themselves. See packages/db/src/schema/bots.ts for why this is not
  // done by moving the bot up the member ladder.

  /**
   * Which bots are here and what they can do.
   *
   * Readable by any member rather than gated behind MANAGE_ROLES, on purpose:
   * "what is this program allowed to do in the room I am in" is a question
   * everybody in the room is entitled to an answer to. Hiding it would protect
   * nobody except a bot doing something its space would object to.
   */
  app.get('/:id/apps', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const ctx = await requirePermission(app.db, id, req.user.id, Permission.VIEW_CONVERSATION);
    const scope = ctx.conversation.parentId ?? id;

    const rows = await app.db
      .select({ install: conversationApps, application: applications, botUser: users })
      .from(conversationApps)
      .innerJoin(applications, eq(applications.id, conversationApps.applicationId))
      .innerJoin(users, eq(users.id, applications.botUserId))
      .where(and(eq(conversationApps.conversationId, scope), isNull(applications.revokedAt)));

    return reply.send({
      apps: rows.map((r) => ({
        applicationId: r.application.id,
        name: r.application.name,
        description: r.application.description,
        permissions: serializePermissions(r.install.permissions),
        permissionNames: permissionNames(r.install.permissions),
        installedById: r.install.installedById,
        installedAt: r.install.createdAt,
        user: toPublicUser(r.botUser),
      })),
    });
  });

  /**
   * Install a bot here, or change what an installed one may do.
   *
   * Idempotent: the same call with a different bitfield is how you widen or
   * narrow a grant, and there is no separate "update" verb to get out of sync
   * with this one.
   *
   * The grant lands on the bot's own `conversation_members.allow`. That is not
   * a shortcut — it is the narrowest statement the permission model has, it
   * already composes correctly through `effectivePermissions`, and it means
   * the visibility functions and every existing permission check see the
   * bot's rights without knowing anything about applications.
   */
  app.put('/:id/apps/:applicationId', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id, applicationId } = req.params as { id: string; applicationId: string };
    const body = installAppBody.parse(req.body);
    const ctx = await requirePermission(app.db, id, req.user.id, Permission.MANAGE_ROLES);
    if (!has(ctx.permissions, Permission.MANAGE_CONVERSATION)) {
      throw missingPermission('MANAGE_CONVERSATION');
    }

    /*
     * A bot cannot install a bot.
     *
     * Everything else here is bounded by what the installer holds, so a bot
     * with MANAGE_ROLES installing a second bot could not exceed itself. But
     * it could *launder*: install a copy, keep the copy when its own grant is
     * revoked, and the audit trail would name a program rather than a person.
     * An install is an accountable act and it needs somebody accountable.
     */
    if (req.user.isBot) throw forbidden('A bot cannot install another bot');

    const scope = ctx.conversation.parentId ?? id;
    const [scopeConv] = await app.db
      .select({ type: conversations.type })
      .from(conversations)
      .where(eq(conversations.id, scope))
      .limit(1);
    if (scopeConv?.type === 'dm') throw conflict('A direct message cannot host an application');

    const [application] = await app.db
      .select({ app: applications, botUser: users })
      .from(applications)
      .innerJoin(users, eq(users.id, applications.botUserId))
      .where(and(eq(applications.id, applicationId), isNull(applications.revokedAt)))
      .limit(1);
    if (!application) throw notFound('Application');

    const wanted = parsePermissions(body.permissions) & ALL_PERMISSIONS;

    /*
     * The same escalation guard every other grant in this file gets, and one
     * more on top.
     *
     * `assertCanGrant` exempts the owner, because an owner granting a *person*
     * a permission they hold is unremarkable. ADMINISTRATOR on a bot is a
     * different proposition: it is every permission at once, forever, held by
     * a credential that lives in somebody's deployment environment. A leaked
     * token would then be the space. So it is refused here for everyone,
     * owners included — the one place in the codebase where the owner does not
     * get the last word, and deliberately so.
     */
    if ((wanted & Permission.ADMINISTRATOR) !== 0n) {
      throw forbidden('An application cannot be granted administrator');
    }
    assertCanGrant(ctx, wanted);

    const botUserId = application.app.botUserId;

    await app.db.transaction(async (tx) => {
      // Membership first: the grant is a statement about a member, so there
      // has to be one. Re-installing an existing bot updates its allow rather
      // than duplicating anything.
      await tx
        .insert(conversationMembers)
        .values({ conversationId: scope, userId: botUserId, role: 'member', allow: wanted })
        .onConflictDoUpdate({
          target: [conversationMembers.conversationId, conversationMembers.userId],
          set: { allow: wanted, leftAt: null },
        });

      await tx
        .insert(conversationApps)
        .values({
          conversationId: scope,
          applicationId,
          permissions: wanted,
          installedById: req.user.id,
        })
        .onConflictDoUpdate({
          target: [conversationApps.conversationId, conversationApps.applicationId],
          set: { permissions: wanted, installedById: req.user.id, updatedAt: new Date() },
        });
    });

    await app.events.toConversation(scope, Event.MemberUpdate, {
      conversationId: scope,
      userId: botUserId,
      role: 'member',
    });

    await logAudit(app, {
      conversationId: scope,
      actorId: req.user.id,
      action: 'app.installed',
      targetUserId: botUserId,
      metadata: { application: application.app.name, permissions: permissionNames(wanted) },
    });

    return reply.send({
      app: {
        applicationId,
        name: application.app.name,
        permissions: serializePermissions(wanted),
        permissionNames: permissionNames(wanted),
        user: toPublicUser(application.botUser),
      },
    });
  });

  /**
   * Uninstall: the grant goes, and so does the bot.
   *
   * Both, because "uninstall" that left the program sitting in the room with
   * its rights zeroed would be a surprising thing to have clicked. Removing
   * the membership is what makes this the undo of the install above.
   */
  app.delete('/:id/apps/:applicationId', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id, applicationId } = req.params as { id: string; applicationId: string };
    const ctx = await requirePermission(app.db, id, req.user.id, Permission.MANAGE_ROLES);
    const scope = ctx.conversation.parentId ?? id;

    const [application] = await app.db
      .select({ botUserId: applications.botUserId, name: applications.name })
      .from(applications)
      .where(eq(applications.id, applicationId))
      .limit(1);
    if (!application) throw notFound('Application');

    await app.db.transaction(async (tx) => {
      await tx
        .delete(conversationApps)
        .where(
          and(
            eq(conversationApps.conversationId, scope),
            eq(conversationApps.applicationId, applicationId),
          ),
        );
      await tx
        .update(conversationMembers)
        .set({ allow: 0n, leftAt: new Date() })
        .where(
          and(
            eq(conversationMembers.conversationId, scope),
            eq(conversationMembers.userId, application.botUserId),
          ),
        );
    });

    await logAudit(app, {
      conversationId: scope,
      actorId: req.user.id,
      action: 'app.uninstalled',
      targetUserId: application.botUserId,
      metadata: { application: application.name },
    });

    return reply.send({ uninstalled: true });
  });
}
