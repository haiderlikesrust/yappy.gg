import {
  and,
  conversationMembers,
  conversations,
  eq,
  follows,
  ilike,
  isNull,
  media,
  or,
  sql as raw,
  users,
  type User,
} from '@yappy/db';
import {
  AppError,
  ErrorCode,
  notFound,
  presenceBody,
  searchUsersQuery,
  updateMeBody,
  updateSettingsBody,
} from '@yappy/shared';
import type { FastifyInstance } from 'fastify';
import { passesAudience, passesAudienceBatch } from '../lib/access.js';
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
import { toFullUser, toPublicUser, toSelf, type Relationship } from '../lib/serialize.js';

/**
 * Both edges of the follow graph between two people, plus what they unlock.
 *
 * One query for the pair rather than two for each direction: the answer is
 * symmetric-ish and the profile screen wants both halves to decide between
 * "Follow", "Follow back" and "Following each other".
 *
 * `canAddToGroups` runs the same `passesAudience` the add path itself runs, so
 * the button's caption cannot promise something the server would then refuse.
 */
async function relationshipBetween(
  app: FastifyInstance,
  viewerId: string,
  target: User,
): Promise<Relationship> {
  const edges = await app.db
    .select({ followerId: follows.followerId })
    .from(follows)
    .where(
      or(
        and(eq(follows.followerId, viewerId), eq(follows.followeeId, target.id)),
        and(eq(follows.followerId, target.id), eq(follows.followeeId, viewerId)),
      ),
    );

  const following = edges.some((e) => e.followerId === viewerId);
  const followedBy = edges.some((e) => e.followerId === target.id);

  return {
    following,
    followedBy,
    isMutual: following && followedBy,
    canAddToGroups: await passesAudience(
      app.db,
      target.privacy.whoCanAddToGroups,
      target.id,
      viewerId,
    ),
  };
}

export async function userRoutes(app: FastifyInstance) {
  const withAvatar = () =>
    app.db
      .select({
        user: users,
        avatarKey: media.objectKey,
        ...affiliationColumns,
      })
      .from(users)
      .leftJoin(media, eq(media.id, users.avatarMediaId))
      .leftJoin(affiliationGroup, affiliationGroupOn(users.affiliationConversationId))
      .leftJoin(affiliationAvatar, affiliationAvatarOn())
      .leftJoin(affiliationMembership, affiliationMembershipOn(users.id));

  /**
   * Both halves of an affiliation have to be present *right now*, so this is
   * checked on write as well as on read: a stale pointer is rejected at the
   * source rather than silently ignored later.
   */
  const assertCanAffiliate = async (userId: string, conversationId: string) => {
    const [row] = await app.db
      .select({ badge: conversations.badge, isAffiliate: conversationMembers.isAffiliate })
      .from(conversations)
      .innerJoin(
        conversationMembers,
        and(
          eq(conversationMembers.conversationId, conversations.id),
          eq(conversationMembers.userId, userId),
          isNull(conversationMembers.leftAt),
        ),
      )
      .where(and(eq(conversations.id, conversationId), isNull(conversations.deletedAt)))
      .limit(1);

    // One message for "not a member", "not affiliated" and "group has no
    // badge" alike: distinguishing them would let anyone probe which groups
    // are badged and who belongs to them.
    if (!row?.isAffiliate || !row.badge) {
      throw new AppError(403, ErrorCode.Forbidden, 'That group has not affiliated you');
    }
  };

  app.get('/me', { preHandler: app.authenticate }, async (req, reply) => {
    const [row] = await withAvatar().where(eq(users.id, req.user.id)).limit(1);
    const [banner] = req.user.bannerMediaId
      ? await app.db.select({ key: media.objectKey }).from(media).where(eq(media.id, req.user.bannerMediaId)).limit(1)
      : [undefined];
    return reply.send({ user: toSelf(row!.user, row!.avatarKey, banner?.key) });
  });

  app.patch('/me', { preHandler: app.authenticate }, async (req, reply) => {
    const body = updateMeBody.parse(req.body);

    if (body.affiliationConversationId) {
      await assertCanAffiliate(req.user.id, body.affiliationConversationId);
    }

    try {
      const [updated] = await app.db
        .update(users)
        .set({
          ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
          ...(body.username !== undefined ? { username: body.username } : {}),
          ...(body.bio !== undefined ? { bio: body.bio } : {}),
          ...(body.avatarMediaId !== undefined ? { avatarMediaId: body.avatarMediaId } : {}),
          ...(body.bannerMediaId !== undefined ? { bannerMediaId: body.bannerMediaId } : {}),
          ...(body.pronouns !== undefined ? { pronouns: body.pronouns } : {}),
          ...(body.birthday !== undefined ? { birthday: body.birthday } : {}),
          ...(body.affiliationConversationId !== undefined
            ? { affiliationConversationId: body.affiliationConversationId }
            : {}),
        })
        .where(eq(users.id, req.user.id))
        .returning();

      // Re-read rather than serialising the `returning()` row directly: the
      // avatar and affiliation are joins, and a response that silently drops
      // them looks to the client exactly like the user having cleared them.
      const [row] = await withAvatar().where(eq(users.id, req.user.id)).limit(1);
      const [banner] = updated!.bannerMediaId
        ? await app.db
            .select({ key: media.objectKey })
            .from(media)
            .where(eq(media.id, updated!.bannerMediaId))
            .limit(1)
        : [undefined];
      const affiliation = pickAffiliation(row!);

      // Everyone who can see this profile needs the update — the simplest
      // correct fan-out is the user's own topic plus every conversation they
      // are in, which the gateway already resolves.
      await app.events.toUser(
        req.user.id,
        'user.update',
        toPublicUser(updated!, row!.avatarKey, affiliation),
      );

      return reply.send({ user: toSelf(updated!, row!.avatarKey, banner?.key, affiliation) });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new AppError(409, ErrorCode.AlreadyExists, 'That username is taken');
      }
      throw err;
    }
  });

  /**
   * Settings are merged, not replaced. A client that only knows about last
   * month's settings must not blank out a field added since.
   */
  app.patch('/me/settings', { preHandler: app.authenticate }, async (req, reply) => {
    const body = updateSettingsBody.parse(req.body);

    const [updated] = await app.db
      .update(users)
      .set({
        ...(body.privacy ? { privacy: { ...req.user.privacy, ...body.privacy } } : {}),
        ...(body.notifications
          ? { notifications: { ...req.user.notifications, ...body.notifications } }
          : {}),
        ...(body.appearance ? { appearance: { ...req.user.appearance, ...body.appearance } } : {}),
        ...(body.locale ? { locale: body.locale } : {}),
      })
      .where(eq(users.id, req.user.id))
      .returning();

    // Other devices on this account mirror the change immediately.
    await app.events.toUser(req.user.id, 'session.update', {
      settings: {
        privacy: updated!.privacy,
        notifications: updated!.notifications,
        appearance: updated!.appearance,
        locale: updated!.locale,
      },
    });

    return reply.send({ user: toSelf(updated!) });
  });

  app.put('/me/presence', { preHandler: app.authenticate }, async (req, reply) => {
    const body = presenceBody.parse(req.body);

    await app.db
      .update(users)
      .set({
        presenceStatus: body.status,
        customStatus: body.customStatus ?? null,
        customStatusExpiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
        lastSeenAt: new Date(),
      })
      .where(eq(users.id, req.user.id));

    await app.events.toUser(req.user.id, 'presence.update', {
      userId: req.user.id,
      status: body.status,
      customStatus: body.customStatus ?? null,
    });

    return reply.send({ ok: true });
  });

  /**
   * Account deletion.
   *
   * Soft-delete plus scheduled purge. Immediate hard deletion would tear holes
   * in every group conversation the account participated in; the grace period
   * also covers the "I regret this" case, which is common.
   */
  app.delete('/me', { preHandler: app.authenticate }, async (req, reply) => {
    const now = new Date();
    await app.db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({
          deletedAt: now,
          tokenEpoch: req.user.tokenEpoch + 1,
          displayName: 'Deleted account',
          bio: null,
          avatarMediaId: null,
          bannerMediaId: null,
          customStatus: null,
          // Free the handle and identifiers immediately — the partial unique
          // indexes only cover non-deleted rows.
          username: null,
          phone: null,
          email: null,
          phoneHash: null,
        })
        .where(eq(users.id, req.user.id));
    });

    await app.boss.sendAfter('account.purge', { userId: req.user.id }, {}, 30 * 24 * 3600);
    return reply.send({ deleted: true, purgeAfterDays: 30 });
  });

  // ── Other people ──────────────────────────────────────────────────────────

  app.get('/:id', { preHandler: app.authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string };

    const [row] = await withAvatar()
      .where(and(eq(users.id, id), isNull(users.deletedAt)))
      .limit(1);
    if (!row) throw notFound('User');

    const canSeeLastSeen = await passesAudience(
      app.db,
      row.user.privacy.whoCanSeeLastSeen,
      row.user.id,
      req.user.id,
    );
    const canSeeAvatar = await passesAudience(
      app.db,
      row.user.privacy.whoCanSeeAvatar,
      row.user.id,
      req.user.id,
    );

    return reply.send({
      user: toFullUser(row.user, {
        avatarKey: canSeeAvatar ? row.avatarKey : null,
        affiliation: pickAffiliation(row),
        canSeeLastSeen,
        // Omitted when you are looking at yourself: there is no relationship
        // to have with your own account, and a Follow button on your own
        // profile is a bug report waiting to be filed.
        ...(row.user.id === req.user.id
          ? {}
          : { relationship: await relationshipBetween(app, req.user.id, row.user) }),
      }),
    });
  });

  app.get('/by-username/:username', { preHandler: app.authenticate }, async (req, reply) => {
    const { username } = req.params as { username: string };
    const [row] = await withAvatar()
      .where(and(eq(users.username, username), isNull(users.deletedAt)))
      .limit(1);
    if (!row) throw notFound('User');
    if (!row.user.privacy.discoverableByUsername && row.user.id !== req.user.id) throw notFound('User');

    const canSeeLastSeen = await passesAudience(
      app.db,
      row.user.privacy.whoCanSeeLastSeen,
      row.user.id,
      req.user.id,
    );
    return reply.send({
      user: toFullUser(row.user, {
        avatarKey: row.avatarKey,
        affiliation: pickAffiliation(row),
        canSeeLastSeen,
      }),
    });
  });

  /**
   * User search.
   *
   * Prefix match on username first (what people actually type), then trigram
   * similarity on display name. Blocked users and anyone who opted out of
   * username discovery are filtered out in SQL, not after — otherwise the
   * result count leaks their existence.
   */
  app.get('/', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { q, limit } = searchUsersQuery.parse(req.query);
    await app.limiter.consume(`user:${req.user.id}`, 'search');

    const term = q.replace(/^@/, '');

    const rows = await app.db
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        isBot: users.isBot,
        isVerified: users.isVerified,
        badge: users.badge,
        avatarKey: media.objectKey,
        privacy: users.privacy,
        // Search is exactly where impersonation is attempted, so it is the last
        // place to economise on identity marks.
        ...affiliationColumns,
      })
      .from(users)
      .leftJoin(media, eq(media.id, users.avatarMediaId))
      .leftJoin(affiliationGroup, affiliationGroupOn(users.affiliationConversationId))
      .leftJoin(affiliationAvatar, affiliationAvatarOn())
      .leftJoin(affiliationMembership, affiliationMembershipOn(users.id))
      .where(
        and(
          isNull(users.deletedAt),
          raw`${users.privacy} ->> 'discoverableByUsername' = 'true'`,
          or(ilike(users.username, `${term}%`), raw`${users.displayName} %> ${term}`),
          raw`not exists (
            select 1 from blocks b
             where (b.blocker_id = ${req.user.id}::uuid and b.blocked_id = ${users.id})
                or (b.blocked_id = ${req.user.id}::uuid and b.blocker_id = ${users.id})
          )`,
        ),
      )
      // Exact handle first, then prefix matches, then fuzzy display-name hits.
      // Written inline rather than as a select alias: `rank` is also a window
      // function name, and Postgres resolves it as one in ORDER BY.
      .orderBy(
        raw`case when ${users.username} = ${term} then 0
                 when ${users.username} ilike ${term + '%'} then 1
                 else 2 end`,
        users.username,
      )
      .limit(limit);

    // Which of these the caller could actually put in a group. The picker
    // needs it to grey out the rest — offering someone and then silently
    // dropping them at creation is the failure this exists to prevent.
    const addable = await passesAudienceBatch(
      app.db,
      req.user.id,
      rows.map((r) => ({ id: r.id, audience: r.privacy.whoCanAddToGroups })),
    );

    return reply.send({
      users: rows.map((r) => ({
        ...toPublicUser(r, r.avatarKey, pickAffiliation(r)),
        canAddToGroups: addable.has(r.id),
      })),
    });
  });
}
