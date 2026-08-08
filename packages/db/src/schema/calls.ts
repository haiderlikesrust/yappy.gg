import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  callParticipantStateEnum,
  callStateEnum,
  createdAt,
  idCol,
  tsCol,
  updatedAt,
} from './_shared.js';
import { conversations } from './conversations.js';
import { devices, users } from './users.js';

/**
 * Calls.
 *
 * Media never touches this backend — LiveKit's SFU carries the audio/video.
 * What lives here is everything the SFU does not know about: who is being rung,
 * on which devices, whether they declined or were simply asleep, and the call
 * record that becomes a message in the thread afterwards.
 *
 * Signalling (ring, accept, decline, hangup) rides the same WebSocket as chat,
 * so a device that is already connected rings with no extra handshake.
 */
export const calls = pgTable(
  'calls',
  {
    id: idCol(),
    /** Null for ad-hoc calls started from a profile rather than a thread. */
    conversationId: uuid('conversation_id').references(() => conversations.id, { onDelete: 'set null' }),
    initiatorId: uuid('initiator_id').references(() => users.id, { onDelete: 'set null' }),

    mode: text('mode').notNull().default('audio'), // audio | video
    state: callStateEnum('state').notNull().default('ringing'),

    /** LiveKit room name. Deterministic from the call id so a reconnecting
     *  client can rejoin without another API round trip. */
    roomName: text('room_name').notNull(),
    /** Which LiveKit region/cluster the room was placed in. */
    region: text('region'),

    /** Idempotency: double-tapping "call" must not start two rooms. */
    nonce: text('nonce'),

    maxParticipants: integer('max_participants').notNull().default(32),
    /** Peak concurrent, for analytics and billing attribution. */
    peakParticipants: integer('peak_participants').notNull().default(0),

    ringExpiresAt: tsCol('ring_expires_at'),
    startedAt: tsCol('started_at'),
    endedAt: tsCol('ended_at'),
    endReason: text('end_reason'), // hangup | declined | timeout | ended_by_host | failed
    durationSeconds: integer('duration_seconds'),

    /** Set when someone hits record; points at the resulting media row. */
    recordingMediaId: uuid('recording_media_id'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('calls_room_uq').on(t.roomName),
    uniqueIndex('calls_initiator_nonce_uq').on(t.initiatorId, t.nonce).where(sql`${t.nonce} is not null`),
    index('calls_conversation_idx').on(t.conversationId, t.createdAt.desc()),
    /** "Is there a live call here?" — hit on every conversation open. */
    index('calls_active_idx')
      .on(t.conversationId)
      .where(sql`${t.state} <> 'ended'`),
    index('calls_ring_timeout_idx').on(t.ringExpiresAt).where(sql`${t.state} = 'ringing'`),
  ],
);

export const callParticipants = pgTable(
  'call_participants',
  {
    callId: uuid('call_id')
      .notNull()
      .references(() => calls.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    state: callParticipantStateEnum('state').notNull().default('invited'),
    /** Which device actually answered — a user may be rung on four. */
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),

    isMuted: boolean('is_muted').notNull().default(false),
    isVideoEnabled: boolean('is_video_enabled').notNull().default(false),
    isScreenSharing: boolean('is_screen_sharing').notNull().default(false),
    isHost: boolean('is_host').notNull().default(false),

    joinedAt: tsCol('joined_at'),
    leftAt: tsCol('left_at'),
    /** Accumulated across rejoins, so a flaky connection reports honestly. */
    totalSeconds: integer('total_seconds').notNull().default(0),

    /** Last known quality sample, surfaced as the "poor connection" banner. */
    connectionQuality: text('connection_quality'),

    invitedAt: tsCol('invited_at').notNull().defaultNow(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.callId, t.userId] }),
    index('call_participants_user_idx').on(t.userId, t.invitedAt.desc()),
    index('call_participants_active_idx').on(t.callId).where(sql`${t.state} = 'joined'`),
  ],
);

/**
 * Append-only signalling relay for anything LiveKit does not model: raising a
 * hand, a reaction during a call, a "switching networks" hint. Rows are swept
 * shortly after the call ends.
 */
export const callEvents = pgTable(
  'call_events',
  {
    id: idCol(),
    callId: uuid('call_id')
      .notNull()
      .references(() => calls.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    kind: text('kind').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index('call_events_call_idx').on(t.callId, t.createdAt)],
);

export type Call = typeof calls.$inferSelect;
export type CallParticipant = typeof callParticipants.$inferSelect;
