import {
  and,
  conversationMembers,
  conversationRoles,
  eq,
  inArray,
  isNull,
  memberRoles,
  sql as raw,
} from '@yappy/db';
import {
  ALL_PERMISSIONS,
  conflict,
  createRoleBody,
  Event,
  forbidden,
  LIMITS,
  newId,
  notFound,
  outranks,
  parsePermissions,
  Permission,
  serializePermissions,
  setMemberRolesBody,
  unprocessable,
  updateRoleBody,
  type MemberRole,
} from '@yappy/shared';
import type { FastifyInstance } from 'fastify';
import { requireMember, requirePermission } from '../lib/access.js';

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

  app.get('/:id/roles', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await requirePermission(app.db, id, req.user.id, Permission.VIEW_CONVERSATION);

    const rows = await app.db
      .select()
      .from(conversationRoles)
      .where(eq(conversationRoles.conversationId, id))
      .orderBy(raw`${conversationRoles.position} desc`, conversationRoles.name);

    return reply.send({ roles: rows.map(serialize) });
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
    // ladder as every other action taken on a person.
    const actorRole = ctx.member.role as MemberRole;
    if (userId !== req.user.id && !outranks(actorRole, target.role as MemberRole)) {
      throw forbidden('That member has an equal or higher role than you');
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

    return reply.send({ roles: rows.map(serialize) });
  });
}
