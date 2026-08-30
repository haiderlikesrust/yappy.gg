import {
  alias,
  and,
  conversationMembers,
  conversations,
  desc,
  eq,
  follows,
  ilike,
  inArray,
  isNull,
  lt,
  media,
  messageMentions,
  messages,
  or,
  savedMessages,
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
import { notDeletedForViewer } from '../lib/hidden.js';
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
import { publicUserColumns, toFullUser, toPublicUser, toSelf, type Relationship } from '../lib/serialize.js';
import { changeUsername } from '../lib/profile.js';

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
  /**
   * A user row with everything needed to draw them, in one query.
   *
   * The banner is aliased for the same reason the affiliation logo is: `media`
   * is already joined for the avatar, and Postgres will not take the same
   * relation twice under one name. It was missing entirely — `/users/me`
   * resolved the banner in its own follow-up select, so Settings drew it and
   * every profile screen fell back to the plain gradient.
   */
  const bannerMedia = alias(media, 'banner_media');

  const withAvatar = () =>
    app.db
      .select({
        user: users,
        avatarKey: media.objectKey,
        bannerKey: bannerMedia.objectKey,
        ...affiliationColumns,
      })
      .from(users)
      .leftJoin(media, eq(media.id, users.avatarMediaId))
      .leftJoin(bannerMedia, eq(bannerMedia.id, users.bannerMediaId))
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

  /**
   * The viewer's saved messages, newest bookmark first.
   *
   * Membership is re-checked at read time via the inner join: leaving a group
   * silently drops its messages from the list rather than letting a bookmark
   * smuggle content out of a room the viewer can no longer see. Deleted
   * messages disappear the same way.
   */
  /**
   * Everywhere you were called, newest first.
   *
   * One list across every group, so "where was I pinged while I was away"
   * is a question with an answer — before this it could only be reconstructed
   * by opening each room and looking for the badge.
   *
   * Ordered by message id rather than by a timestamp, and paged by one too.
   * Ids are UUIDv7, so id order *is* time order, and `message_mentions` has
   * no clock of its own — adding one would have meant a column that always
   * held the same value as the message it points at.
   */
  app.get('/me/mentions', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const query = req.query as { limit?: string; before?: string };
    const limitRaw = Number(query.limit ?? 30);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, Math.trunc(limitRaw)), 50) : 30;

    const rows = await app.db
      .select({
        msg: messages,
        isBroadcast: messageMentions.isBroadcast,
        convId: conversations.id,
        convType: conversations.type,
        convTitle: conversations.title,
        parentId: conversations.parentId,
      })
      .from(messageMentions)
      .innerJoin(messages, eq(messages.id, messageMentions.messageId))
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      /*
       * Still a member, and still able to read it.
       *
       * A mention row outlives leaving the group — nothing deletes it — so
       * without this join the inbox would keep showing messages from rooms
       * you walked out of, and opening one would 403.
       *
       * Membership is the space's for a channel, which is also why this is
       * a join on `parent_id` where there is one.
       */
      .innerJoin(
        conversationMembers,
        and(
          eq(
            conversationMembers.conversationId,
            raw`coalesce(${conversations.parentId}, ${conversations.id})`,
          ),
          eq(conversationMembers.userId, req.user.id),
          isNull(conversationMembers.leftAt),
        ),
      )
      .where(
        and(
          eq(messageMentions.userId, req.user.id),
          isNull(messages.deletedAt),
          isNull(conversations.deletedAt),
          notDeletedForViewer(req.user.id),
          query.before ? lt(messageMentions.messageId, query.before) : undefined,
        ),
      )
      .orderBy(desc(messageMentions.messageId))
      .limit(limit);

    // Same trick as the bookmarks below: the hydrator prices its role
    // lookup per conversation, so feed it one at a time and reassemble.
    const byConv = new Map<string, typeof rows>();
    for (const r of rows) {
      const list = byConv.get(r.convId) ?? [];
      list.push(r);
      byConv.set(r.convId, list);
    }
    const hydratedById = new Map<string, unknown>();
    for (const group of byConv.values()) {
      const hydrated = await app.messages.hydrateMany(
        group.map((g) => g.msg),
        req.user.id,
      );
      for (const h of hydrated) hydratedById.set((h as { id: string }).id, h);
    }

    // A channel names its space, because "#general" alone is the title of
    // half the channels somebody is in.
    const parentIds = [...new Set(rows.map((r) => r.parentId).filter((v): v is string => Boolean(v)))];
    const parents = parentIds.length
      ? await app.db
          .select({ id: conversations.id, title: conversations.title })
          .from(conversations)
          .where(inArray(conversations.id, parentIds))
      : [];
    const parentTitle = new Map(parents.map((p) => [p.id, p.title]));

    return reply.send({
      mentions: rows.map((r) => ({
        /** False for a direct mention, true for `@everyone` or a role. */
        isBroadcast: r.isBroadcast,
        conversation: {
          id: r.convId,
          type: r.convType,
          title: r.convTitle,
          parentId: r.parentId,
          parentTitle: r.parentId ? (parentTitle.get(r.parentId) ?? null) : null,
        },
        message: hydratedById.get(r.msg.id) ?? null,
      })),
      nextCursor: rows.length === limit ? (rows.at(-1)?.msg.id ?? null) : null,
    });
  });

  app.get('/me/saved', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const limitRaw = Number((req.query as { limit?: string }).limit ?? 50);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, Math.trunc(limitRaw)), 100) : 50;

    const rows = await app.db
      .select({
        msg: messages,
        savedAt: savedMessages.savedAt,
        convId: conversations.id,
        convType: conversations.type,
        convTitle: conversations.title,
      })
      .from(savedMessages)
      .innerJoin(messages, eq(messages.id, savedMessages.messageId))
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .innerJoin(
        conversationMembers,
        and(
          eq(conversationMembers.conversationId, messages.conversationId),
          eq(conversationMembers.userId, req.user.id),
        ),
      )
      .where(
        and(
          eq(savedMessages.userId, req.user.id),
          isNull(messages.deletedAt),
          notDeletedForViewer(req.user.id),
        ),
      )
      .orderBy(desc(savedMessages.savedAt))
      .limit(limit);

    // The hydrator prices its role lookup per conversation, so feed it one
    // conversation at a time and reassemble in bookmark order.
    const byConv = new Map<string, typeof rows>();
    for (const r of rows) {
      const list = byConv.get(r.convId) ?? [];
      list.push(r);
      byConv.set(r.convId, list);
    }
    const hydratedById = new Map<string, unknown>();
    for (const group of byConv.values()) {
      const hydrated = await app.messages.hydrateMany(
        group.map((g) => g.msg),
        req.user.id,
      );
      for (const h of hydrated) hydratedById.set((h as { id: string }).id, h);
    }

    return reply.send({
      items: rows.map((r) => ({
        savedAt: r.savedAt.toISOString(),
        conversation: { id: r.convId, type: r.convType, title: r.convTitle },
        message: hydratedById.get(r.msg.id) ?? null,
      })),
      hasMore: rows.length === limit,
    });
  });

  app.patch('/me', { preHandler: app.authenticate }, async (req, reply) => {
    const body = updateMeBody.parse(req.body);

    if (body.affiliationConversationId) {
      await assertCanAffiliate(req.user.id, body.affiliationConversationId);
    }

    /**
     * The username moves through `changeUsername`, not through the bulk update
     * below, because it is the one field here with a rate limit and a history
     * row attached. Doing it inline would make this endpoint the way to change
     * a handle without either — and a limit one of two paths respects is not a
     * limit. Runs first so a refusal happens before anything else is written.
     */
    if (body.username !== undefined) {
      await changeUsername(app, req.user.id, body.username);
    }

    const changes = {
      ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
      ...(body.bio !== undefined ? { bio: body.bio } : {}),
      ...(body.avatarMediaId !== undefined ? { avatarMediaId: body.avatarMediaId } : {}),
      ...(body.bannerMediaId !== undefined ? { bannerMediaId: body.bannerMediaId } : {}),
      ...(body.pronouns !== undefined ? { pronouns: body.pronouns } : {}),
      ...(body.birthday !== undefined ? { birthday: body.birthday } : {}),
      ...(body.flair !== undefined ? { flair: body.flair } : {}),
      ...(body.affiliationConversationId !== undefined
        ? { affiliationConversationId: body.affiliationConversationId }
        : {}),
    };

    try {
      /**
       * A body carrying only `username` leaves nothing for this update to do —
       * the name was already written above — and Drizzle refuses an empty
       * `set()`. Re-read instead, so the response still describes the account
       * as it now stands rather than 500ing on a request that succeeded.
       */
      const [updated] = Object.keys(changes).length
        ? await app.db.update(users).set(changes).where(eq(users.id, req.user.id)).returning()
        : await app.db.select().from(users).where(eq(users.id, req.user.id)).limit(1);

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
      // The username collision is handled in `changeUsername` now, where the
      // race actually happens. Kept because a unique violation from any future
      // column here should still read as a conflict rather than a 500.
      if ((err as { code?: string }).code === '23505') {
        throw new AppError(409, ErrorCode.AlreadyExists, 'That is already taken');
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

    /**
     * Re-read with the joins, for the same reason PATCH /me above does: the
     * avatar and banner are joins, and a `returning()` row serialised without
     * them tells the client both were cleared. The Android settings screen
     * adopts this response as the whole profile, so dragging the text-size
     * slider blanked the avatar everywhere until the next full fetch.
     */
    const [row] = await withAvatar().where(eq(users.id, req.user.id)).limit(1);
    const [banner] = updated!.bannerMediaId
      ? await app.db
          .select({ key: media.objectKey })
          .from(media)
          .where(eq(media.id, updated!.bannerMediaId))
          .limit(1)
      : [undefined];
    return reply.send({ user: toSelf(updated!, row?.avatarKey, banner?.key, pickAffiliation(row!)) });
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

    /**
     * Rooms the two of you share. Only membership the *viewer already holds*
     * is disclosed — every group named here is one they are in themselves —
     * so this leaks nothing a person could not learn by reading their own
     * member lists. Capped, because the count is a context line, not a census.
     */
    const mutualGroups = async () => {
      const mine = alias(conversationMembers, 'mutual_mine');
      const theirs = alias(conversationMembers, 'mutual_theirs');
      const rows = await app.db
        .select({
          id: conversations.id,
          title: conversations.title,
          settings: conversations.settings,
        })
        .from(conversations)
        .innerJoin(
          mine,
          and(
            eq(mine.conversationId, conversations.id),
            eq(mine.userId, req.user.id),
            isNull(mine.leftAt),
          ),
        )
        .innerJoin(
          theirs,
          and(
            eq(theirs.conversationId, conversations.id),
            eq(theirs.userId, row.user.id),
            isNull(theirs.leftAt),
          ),
        )
        .where(
          and(
            isNull(conversations.deletedAt),
            inArray(conversations.type, ['group', 'space']),
            // Channels would count their space twice.
            isNull(conversations.parentId),
          ),
        )
        .orderBy(desc(conversations.lastMessageAt))
        .limit(50);

      return {
        count: rows.length,
        preview: rows.slice(0, 3).map((r) => ({
          id: r.id,
          title: r.title,
          emoji:
            ((r.settings ?? {}) as { appearance?: { emoji?: string } }).appearance?.emoji ?? null,
        })),
      };
    };

    return reply.send({
      user: toFullUser(row.user, {
        avatarKey: canSeeAvatar ? row.avatarKey : null,
        // Behind the same audience as the avatar. There is no separate setting
        // for it, and of the two defaults — a banner more public than the face
        // above it, or less — this is the one nobody has to discover by being
        // surprised.
        bannerKey: canSeeAvatar ? row.bannerKey : null,
        affiliation: pickAffiliation(row),
        canSeeLastSeen,
        // Omitted when you are looking at yourself: there is no relationship
        // to have with your own account, and a Follow button on your own
        // profile is a bug report waiting to be filed.
        ...(row.user.id === req.user.id
          ? {}
          : {
              relationship: await relationshipBetween(app, req.user.id, row.user),
              mutualGroups: await mutualGroups(),
            }),
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
        bannerKey: row.bannerKey,
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
        ...publicUserColumns,
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
