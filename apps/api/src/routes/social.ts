import {
  and,
  blocks,
  contacts,
  desc,
  eq,
  follows,
  isNull,
  media,
  notifications,
  sql as raw,
  textArray,
  users,
} from '@yappy/db';
import { blockBody, contactSyncBody, conflict, cursorPagination, newId, notFound } from '@yappy/shared';
import type { FastifyInstance } from 'fastify';
import { assertNotBlocked } from '../lib/access.js';
import { toPublicUser } from '../lib/serialize.js';

/**
 * The social graph: follows, blocks, contact discovery.
 *
 * Follows are asymmetric. A mutual follow is what the rest of the app calls a
 * "contact", and it is what the `contacts` privacy audience resolves against.
 */
export async function socialRoutes(app: FastifyInstance) {
  app.post('/follow/:id', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (id === req.user.id) throw conflict('You cannot follow yourself');

    await app.limiter.consume(`user:${req.user.id}`, 'follow');
    await assertNotBlocked(app.db, req.user.id, id);

    const [target] = await app.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, id), isNull(users.deletedAt)))
      .limit(1);
    if (!target) throw notFound('User');

    await app.db.insert(follows).values({ followerId: req.user.id, followeeId: id }).onConflictDoNothing();

    // Re-read: the trigger may have just flipped both rows to mutual.
    const [row] = await app.db
      .select({ isMutual: follows.isMutual })
      .from(follows)
      .where(and(eq(follows.followerId, req.user.id), eq(follows.followeeId, id)))
      .limit(1);

    await app.db.insert(notifications).values({
      id: newId(),
      userId: id,
      kind: row?.isMutual ? 'follow_back' : 'follow',
      actorId: req.user.id,
      targetType: 'user',
      targetId: req.user.id,
      groupKey: `follow:${req.user.id}`,
    });

    await app.events.toUser(id, 'relationship.update', {
      userId: req.user.id,
      state: 'follower',
      isMutual: row?.isMutual ?? false,
    });

    return reply.send({ following: true, isMutual: row?.isMutual ?? false });
  });

  app.delete('/follow/:id', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await app.db
      .delete(follows)
      .where(and(eq(follows.followerId, req.user.id), eq(follows.followeeId, id)));
    await app.events.toUser(id, 'relationship.update', { userId: req.user.id, state: 'none', isMutual: false });
    return reply.send({ following: false });
  });

  const listGraph = (direction: 'followers' | 'following') =>
    async (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => {
      const { limit, cursor } = cursorPagination.parse(req.query);
      const targetId = (req.params as { id?: string }).id ?? req.user.id;

      const joinCol = direction === 'followers' ? follows.followerId : follows.followeeId;
      const matchCol = direction === 'followers' ? follows.followeeId : follows.followerId;

      const rows = await app.db
        .select({
          id: users.id,
          username: users.username,
          displayName: users.displayName,
          isBot: users.isBot,
          isVerified: users.isVerified,
          badge: users.badge,
          avatarKey: media.objectKey,
          isMutual: follows.isMutual,
          createdAt: follows.createdAt,
        })
        .from(follows)
        .innerJoin(users, eq(users.id, joinCol))
        .leftJoin(media, eq(media.id, users.avatarMediaId))
        .where(
          and(
            eq(matchCol, targetId),
            isNull(users.deletedAt),
            cursor ? raw`${follows.createdAt} < ${cursor}::timestamptz` : undefined,
          ),
        )
        .orderBy(desc(follows.createdAt))
        .limit(limit);

      return reply.send({
        users: rows.map((r) => ({ ...toPublicUser(r, r.avatarKey), isMutual: r.isMutual })),
        nextCursor: rows.length === limit ? (rows.at(-1)?.createdAt.toISOString() ?? null) : null,
      });
    };

  app.get('/me/followers', { preHandler: app.authenticate }, listGraph('followers'));
  app.get('/me/following', { preHandler: app.authenticate }, listGraph('following'));
  app.get('/:id/followers', { preHandler: app.authenticate }, listGraph('followers'));
  app.get('/:id/following', { preHandler: app.authenticate }, listGraph('following'));

  /** Mutual follows — the "contacts" the privacy settings refer to. */
  app.get('/me/contacts', { preHandler: app.authenticate }, async (req, reply) => {
    const { limit, cursor } = cursorPagination.parse(req.query);
    const rows = await app.db
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        isBot: users.isBot,
        isVerified: users.isVerified,
        badge: users.badge,
        avatarKey: media.objectKey,
        createdAt: follows.createdAt,
      })
      .from(follows)
      .innerJoin(users, eq(users.id, follows.followeeId))
      .leftJoin(media, eq(media.id, users.avatarMediaId))
      .where(
        and(
          eq(follows.followerId, req.user.id),
          eq(follows.isMutual, true),
          isNull(users.deletedAt),
          cursor ? raw`${follows.createdAt} < ${cursor}::timestamptz` : undefined,
        ),
      )
      .orderBy(desc(follows.createdAt))
      .limit(limit);

    return reply.send({
      users: rows.map((r) => toPublicUser(r, r.avatarKey)),
      nextCursor: rows.length === limit ? (rows.at(-1)?.createdAt.toISOString() ?? null) : null,
    });
  });

  /**
   * Contacts who are online right now — the "Active now" strip.
   *
   * Presence comes from the live `presence` table (socket sessions with a TTL),
   * not `users.presence_status`, so a killed app drops off within a sweep
   * rather than lingering "online". Contacts who hide their last-seen are
   * excluded entirely — an online dot leaks exactly what that setting hides.
   */
  app.get('/me/online', { preHandler: app.authenticate }, async (req, reply) => {
    const rows = (await app.db.execute(
      raw`select distinct on (u.id)
                 u.id, u.username, u.display_name, u.is_bot, u.is_verified,
                 md.object_key as avatar_key, p.status
            from follows f
            join users u on u.id = f.followee_id and u.deleted_at is null
            join presence p on p.user_id = u.id and p.expires_at > now()
            left join media md on md.id = u.avatar_media_id
           where f.follower_id = ${req.user.id}::uuid
             and f.is_mutual
             and coalesce(u.privacy->>'whoCanSeeLastSeen', 'contacts') <> 'nobody'
           order by u.id
           limit 30`,
    )) as unknown as Array<{
      id: string;
      username: string | null;
      display_name: string | null;
      is_bot: boolean;
      is_verified: boolean;
      avatar_key: string | null;
      status: string;
    }>;

    return reply.send({
      online: rows.map((r) => ({
        user: toPublicUser(
          { id: r.id, username: r.username, displayName: r.display_name, isBot: r.is_bot, isVerified: r.is_verified },
          r.avatar_key,
        ),
        status: r.status,
      })),
    });
  });

  // ── Blocking ──────────────────────────────────────────────────────────────

  app.post('/block', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const body = blockBody.parse(req.body);
    if (body.userId === req.user.id) throw conflict('You cannot block yourself');

    await app.db
      .insert(blocks)
      .values({ blockerId: req.user.id, blockedId: body.userId })
      .onConflictDoNothing();

    // The trigger has already severed follows in both directions.
    await app.events.toUser(req.user.id, 'block.update', { userId: body.userId, blocked: true });
    return reply.send({ blocked: true });
  });

  app.delete('/block/:id', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await app.db.delete(blocks).where(and(eq(blocks.blockerId, req.user.id), eq(blocks.blockedId, id)));
    await app.events.toUser(req.user.id, 'block.update', { userId: id, blocked: false });
    return reply.send({ blocked: false });
  });

  app.get('/blocks', { preHandler: app.authenticate }, async (req, reply) => {
    const rows = await app.db
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        isBot: users.isBot,
        isVerified: users.isVerified,
        badge: users.badge,
        avatarKey: media.objectKey,
        createdAt: blocks.createdAt,
      })
      .from(blocks)
      .innerJoin(users, eq(users.id, blocks.blockedId))
      .leftJoin(media, eq(media.id, users.avatarMediaId))
      .where(eq(blocks.blockerId, req.user.id))
      .orderBy(desc(blocks.createdAt));

    return reply.send({ users: rows.map((r) => toPublicUser(r, r.avatarKey)) });
  });

  // ── Contact discovery ─────────────────────────────────────────────────────

  /**
   * Address-book matching, privacy-preserving by construction.
   *
   * The client hashes each E.164 number with SHA-256 and sends only digests.
   * The server re-derives its own peppered HMAC and matches — so we can find
   * mutual contacts without ever holding a plaintext copy of someone's phone
   * book, and a database leak yields no phone numbers.
   *
   * Note this is not a strong PSI protocol: an adversary who controls the
   * client can still enumerate numbers they already possess. That is the same
   * bound every mainstream messenger operates under; the rate limit is what
   * makes bulk enumeration impractical.
   */
  app.post('/contacts/sync', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const body = contactSyncBody.parse(req.body);
    await app.limiter.consume(`user:${req.user.id}`, 'contacts.sync');

    if (body.phoneHashes.length === 0) return reply.send({ matched: [] });

    const rows = (await app.db.execute(
      raw`
      with incoming as (
        select unnest(${textArray(body.phoneHashes)}) as client_hash
      ),
      peppered as (
        select
          i.client_hash,
          encode(
            hmac(i.client_hash, (select value from server_secrets where key = 'phone_pepper'), 'sha256'),
            'hex'
          ) as server_hash
        from incoming i
      )
      select u.id, u.username, u.display_name, u.is_bot, u.is_verified,
             m.object_key as avatar_key, p.client_hash
        from peppered p
        join users u on u.phone_hash = p.server_hash
        left join media m on m.id = u.avatar_media_id
       where u.deleted_at is null
         and u.privacy ->> 'discoverableByPhone' = 'true'
         and u.id <> ${req.user.id}::uuid
         and not exists (
           select 1 from blocks b
            where (b.blocker_id = ${req.user.id}::uuid and b.blocked_id = u.id)
               or (b.blocked_id = ${req.user.id}::uuid and b.blocker_id = u.id)
         )
       limit 5000
    `,
    )) as unknown as Array<{
      id: string;
      username: string | null;
      display_name: string | null;
      is_bot: boolean;
      is_verified: boolean;
      avatar_key: string | null;
      client_hash: string;
    }>;

    if (rows.length > 0) {
      await app.db
        .insert(contacts)
        .values(
          rows.map((r) => ({
            ownerId: req.user.id,
            userId: r.id,
            phoneHash: r.client_hash,
          })),
        )
        .onConflictDoNothing();
    }

    return reply.send({
      matched: rows.map((r) =>
        toPublicUser(
          {
            id: r.id,
            username: r.username,
            displayName: r.display_name,
            isBot: r.is_bot,
            isVerified: r.is_verified,
          },
          r.avatar_key,
        ),
      ),
    });
  });

  // ── Notification centre ───────────────────────────────────────────────────

  app.get('/notifications', { preHandler: app.authenticate }, async (req, reply) => {
    const { limit, cursor } = cursorPagination.parse(req.query);
    const rows = await app.db
      .select({
        notification: notifications,
        actorUsername: users.username,
        actorDisplayName: users.displayName,
        actorAvatarKey: media.objectKey,
      })
      .from(notifications)
      .leftJoin(users, eq(users.id, notifications.actorId))
      .leftJoin(media, eq(media.id, users.avatarMediaId))
      .where(
        and(
          eq(notifications.userId, req.user.id),
          cursor ? raw`${notifications.createdAt} < ${cursor}::timestamptz` : undefined,
        ),
      )
      .orderBy(desc(notifications.createdAt))
      .limit(limit);

    return reply.send({
      notifications: rows.map((r) => ({
        id: r.notification.id,
        kind: r.notification.kind,
        actor: r.notification.actorId
          ? toPublicUser(
              {
                id: r.notification.actorId,
                username: r.actorUsername,
                displayName: r.actorDisplayName,
              },
              r.actorAvatarKey,
            )
          : null,
        targetType: r.notification.targetType,
        targetId: r.notification.targetId,
        data: r.notification.data,
        count: r.notification.count,
        readAt: r.notification.readAt?.toISOString() ?? null,
        createdAt: r.notification.createdAt.toISOString(),
      })),
      nextCursor:
        rows.length === limit ? (rows.at(-1)?.notification.createdAt.toISOString() ?? null) : null,
    });
  });

  app.post('/notifications/read', { preHandler: app.authenticate }, async (req, reply) => {
    await app.db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.userId, req.user.id), isNull(notifications.readAt)));
    return reply.send({ ok: true });
  });
}
