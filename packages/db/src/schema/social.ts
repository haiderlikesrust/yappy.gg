import { sql } from 'drizzle-orm';
import {
  boolean,
  doublePrecision,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, idCol, tsCol } from './_shared.js';
import { devices, users } from './users.js';

/**
 * Asymmetric follow graph. "Friends" is derived: a mutual follow. This is
 * strictly more expressive than a friendship table — it supports public
 * profiles and one-way subscriptions without a second concept — and mutuality
 * is a cheap indexed lookup.
 */
export const follows = pgTable(
  'follows',
  {
    followerId: uuid('follower_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    followeeId: uuid('followee_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Maintained by trigger so "are we friends" never needs a second query. */
    isMutual: boolean('is_mutual').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.followerId, t.followeeId] }),
    index('follows_followee_idx').on(t.followeeId),
    index('follows_mutual_idx').on(t.followerId).where(sql`${t.isMutual}`),
    // A self-follow would silently make every privacy check pass.
    // Enforced as a CHECK in migrations/0001_constraints.sql.
  ],
);

/**
 * Blocking is deliberately one table, not a flag on `follows`: a block must
 * survive unfollowing, and must be enforceable even between users who have no
 * relationship at all.
 */
export const blocks = pgTable(
  'blocks',
  {
    blockerId: uuid('blocker_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    blockedId: uuid('blocked_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    reason: text('reason'),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.blockerId, t.blockedId] }), index('blocks_blocked_idx').on(t.blockedId)],
);

/**
 * Address-book matches. We store the hash the client sent and the user it
 * resolved to, never the raw number, and we keep the client's local label so
 * "Mum" shows instead of "@sarah_k91".
 */
export const contacts = pgTable(
  'contacts',
  {
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Null while the contact has not joined yet — used for invite prompts. */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    phoneHash: text('phone_hash').notNull(),
    localName: text('local_name'),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.ownerId, t.phoneHash] }),
    index('contacts_user_idx').on(t.userId),
  ],
);

/**
 * Presence.
 *
 * Redis would normally own this. Without it, presence lives in Postgres with a
 * heartbeat: each gateway node upserts `expiresAt = now() + ttl` for its
 * connected devices every 30s, and a sweeper marks the stragglers offline. One
 * row per *device*, because a user online on their phone and killed on desktop
 * is still online.
 */
export const presence = pgTable(
  'presence',
  {
    deviceId: uuid('device_id')
      .primaryKey()
      .references(() => devices.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Which gateway process holds the socket — used to route targeted sends. */
    nodeId: text('node_id').notNull(),
    status: text('status').notNull().default('online'),
    /**
     * The conversation this device is *looking at*, if any — ambient
     * co-presence, "who is in the room right now".
     *
     * Deliberately on the device row rather than the user row: the same account
     * reading on a phone and idling on a laptop is present in one place, not
     * two. It lives here rather than in gateway memory so the answer survives a
     * node dying and is the same from whichever node asks — the whole reason
     * presence is in Postgres in the first place.
     */
    viewingConversationId: uuid('viewing_conversation_id'),
    expiresAt: tsCol('expires_at').notNull(),
    connectedAt: tsCol('connected_at').notNull().defaultNow(),
  },
  (t) => [
    index('presence_user_idx').on(t.userId),
    index('presence_expires_idx').on(t.expiresAt),
    index('presence_node_idx').on(t.nodeId),
    /** "Who is in this room" — the only query that reads the column. */
    index('presence_viewing_idx')
      .on(t.viewingConversationId)
      .where(sql`${t.viewingConversationId} is not null`),
  ],
);

/**
 * Token-bucket rate limiting, again standing in for Redis.
 *
 * `UPDATE … RETURNING` with the refill computed in SQL makes each check a
 * single atomic round trip. Rows are keyed by (subject, action) and swept on a
 * schedule. Hot buckets are additionally cached in-process per node — see
 * apps/api/src/lib/ratelimit.ts.
 */
export const rateLimits = pgTable(
  'rate_limits',
  {
    /** `user:<id>` / `ip:<addr>` / `phone:<hash>` */
    subject: text('subject').notNull(),
    action: text('action').notNull(),
    tokens: doublePrecision('tokens').notNull().default(0),
    updatedAt: tsCol('updated_at').notNull().defaultNow(),
    expiresAt: tsCol('expires_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.subject, t.action] }), index('rate_limits_expires_idx').on(t.expiresAt)],
);

/** Invite links to groups and channels. */
export const invites = pgTable(
  'invites',
  {
    id: idCol(),
    conversationId: uuid('conversation_id').notNull(),
    code: text('code').notNull(),
    createdById: uuid('created_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * A role this invite hands to whoever redeems it.
     *
     * This is how anyone *becomes* Premium without an admin assigning it by
     * hand, one person at a time — a paid community puts the link in its
     * checkout email, a cohort gets a link per intake. Without it, channel
     * gating only works for groups small enough to administer manually.
     *
     * A bare uuid rather than a foreign key, matching `conversationId`
     * above — the roles table lives in another schema file and the import
     * would be circular. The join handler tolerates a role that has been
     * deleted since: the invite still admits, it just grants nothing.
     */
    roleId: uuid('role_id'),
    /** 0 = unlimited. */
    maxUses: integer('max_uses').notNull().default(0),
    uses: integer('uses').notNull().default(0),
    expiresAt: tsCol('expires_at'),
    revokedAt: tsCol('revoked_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('invites_code_uq').on(t.code),
    index('invites_conversation_idx').on(t.conversationId),
  ],
);

export type Follow = typeof follows.$inferSelect;
export type Block = typeof blocks.$inferSelect;
export type Presence = typeof presence.$inferSelect;
export type Invite = typeof invites.$inferSelect;
