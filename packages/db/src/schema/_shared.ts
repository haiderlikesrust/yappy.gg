import { customType, pgEnum, timestamp, uuid } from 'drizzle-orm/pg-core';
import {
  CALL_PARTICIPANT_STATES,
  CALL_STATES,
  CONVERSATION_TYPES,
  MEMBER_ROLES,
  MESSAGE_TYPES,
  NOTIFICATION_LEVELS,
  PLATFORMS,
  PRESENCE_STATUSES,
  PRIVACY_AUDIENCES,
} from '@yappy/shared';

/** Case-insensitive text — usernames and emails compare and index correctly
 *  without scattering `lower()` through every query. Requires the citext
 *  extension (created in migrations/0000_extensions.sql). */
export const citext = customType<{ data: string; driverData: string }>({
  dataType: () => 'citext',
});

/** Postgres `bytea`, surfaced as a Node Buffer. */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

export const conversationTypeEnum = pgEnum('conversation_type', CONVERSATION_TYPES);
export const memberRoleEnum = pgEnum('member_role', MEMBER_ROLES);
export const messageTypeEnum = pgEnum('message_type', MESSAGE_TYPES);
export const presenceStatusEnum = pgEnum('presence_status', PRESENCE_STATUSES);
export const notificationLevelEnum = pgEnum('notification_level', NOTIFICATION_LEVELS);
export const callStateEnum = pgEnum('call_state', CALL_STATES);
export const callParticipantStateEnum = pgEnum('call_participant_state', CALL_PARTICIPANT_STATES);
export const platformEnum = pgEnum('platform', PLATFORMS);
export const privacyAudienceEnum = pgEnum('privacy_audience', PRIVACY_AUDIENCES);
export const mediaStatusEnum = pgEnum('media_status', ['pending', 'processing', 'ready', 'failed', 'quarantined']);
export const reportStatusEnum = pgEnum('report_status', ['open', 'reviewing', 'actioned', 'dismissed']);

/**
 * All timestamps are `timestamptz`. Never `timestamp` — a chat app that stores
 * naive local times will corrupt message ordering the first time a server moves
 * region or a user crosses a DST boundary.
 */
export const tsCol = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const createdAt = () => tsCol('created_at').notNull().defaultNow();
export const updatedAt = () => tsCol('updated_at').notNull().defaultNow();
/** Soft delete. Every user-visible row carries one: hard deletes break replies,
 *  quote-chains and the audit trail moderation depends on. */
export const deletedAt = () => tsCol('deleted_at');

export const idCol = () => uuid('id').primaryKey();
