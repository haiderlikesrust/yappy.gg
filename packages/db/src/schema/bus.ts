import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, idCol, tsCol } from './_shared.js';

/**
 * Overflow store for the Postgres event bus.
 *
 * `pg_notify` truncates at 8000 bytes. Most events are far smaller, but a
 * message with ten attachments and a link preview is not. Rather than
 * silently dropping those, the bus writes the body here and notifies with a
 * pointer; the receiving gateway fetches it by id.
 *
 * Rows are consumed once and swept after a minute — this is a hand-off buffer,
 * not a log.
 */
export const busOverflow = pgTable(
  'bus_overflow',
  {
    id: idCol(),
    topic: text('topic').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
    expiresAt: tsCol('expires_at').notNull(),
  },
  (t) => [index('bus_overflow_expires_idx').on(t.expiresAt)],
);

/**
 * Durable event log, kept only long enough to serve gateway RESUME.
 *
 * A client that drops off for thirty seconds should get its missed events
 * replayed rather than being forced into a full resync. Retention is short
 * (minutes) because anything longer is better served by the seq-based sync
 * endpoint, which reads the real tables.
 */
export const eventLog = pgTable(
  'event_log',
  {
    id: idCol(),
    /** Per-recipient stream. Replay is always scoped to one user. */
    userId: text('user_id').notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
    expiresAt: tsCol('expires_at').notNull(),
  },
  (t) => [
    index('event_log_replay_idx').on(t.userId, t.id),
    index('event_log_expires_idx').on(t.expiresAt),
  ],
);
