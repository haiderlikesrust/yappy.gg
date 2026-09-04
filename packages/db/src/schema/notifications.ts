import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, idCol, tsCol } from './_shared.js';
import { devices, users } from './users.js';

/**
 * Transactional outbox for push.
 *
 * A push is enqueued in the *same transaction* as the message insert. Either
 * both land or neither does — no "message saved but notification lost", and no
 * "notification for a message that got rolled back". The worker polls this
 * table (pg-boss handles the polling and retry semantics).
 */
export const pushOutbox = pgTable(
  'push_outbox',
  {
    id: idCol(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Null = fan out to every active device for the user. */
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'cascade' }),

    kind: text('kind').notNull(), // message | mention | reaction | call | system
    /** Collapse key: iOS `apns-collapse-id`, Android `collapse_key`. Ten
     *  messages in one chat become one notification, not ten. */
    collapseKey: text('collapse_key'),
    /** Deduplicates a fan-out replayed after a worker crash. */
    dedupeKey: text('dedupe_key'),

    title: text('title'),
    body: text('body'),
    /** Data payload — the client uses it to deep-link and to hydrate its cache
     *  without an immediate API call. */
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    /** Server-computed badge value at enqueue time. */
    badge: integer('badge'),
    sound: text('sound'),
    /** VoIP/CallKit pushes take a different APNs topic and priority. */
    priority: text('priority').notNull().default('high'),

    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    /** Do not deliver a "you have a new message" push twenty minutes late. */
    expiresAt: tsCol('expires_at'),
    /**
     * When a drain took this row. The durable half of the claim: the row
     * locks release when the claim statement commits, and delivery takes
     * seconds, so without this a second drain in that window re-sent
     * everything the first was still delivering.
     */
    claimedAt: tsCol('claimed_at'),
    sentAt: tsCol('sent_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('push_outbox_pending_idx')
      .on(t.createdAt)
      .where(sql`${t.sentAt} is null`),
    index('push_outbox_user_idx').on(t.userId, t.createdAt.desc()),
    // Unique, because `onConflictDoNothing` on the fan-out inserts was
    // relying on it: as a plain index it never conflicted, so a pg-boss batch
    // retried after one sibling's failure re-inserted every push for the
    // batch's other nine messages.
    uniqueIndex('push_outbox_dedupe_idx').on(t.dedupeKey).where(sql`${t.dedupeKey} is not null`),
  ],
);

/**
 * In-app notification centre (someone followed you, reacted, added you to a
 * group). Distinct from push: push is a delivery mechanism, this is a feed.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: idCol(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'cascade' }),
    targetType: text('target_type'),
    targetId: uuid('target_id'),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    /** Grouped: "Alex and 4 others reacted" is one row with a counter. */
    groupKey: text('group_key'),
    count: integer('count').notNull().default(1),
    readAt: tsCol('read_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('notifications_inbox_idx').on(t.userId, t.createdAt.desc()),
    index('notifications_unread_idx').on(t.userId).where(sql`${t.readAt} is null`),
    index('notifications_group_idx').on(t.userId, t.groupKey).where(sql`${t.groupKey} is not null`),
  ],
);

export type PushOutbox = typeof pushOutbox.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
