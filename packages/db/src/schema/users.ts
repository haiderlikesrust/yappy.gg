import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  citext,
  createdAt,
  deletedAt,
  idCol,
  presenceStatusEnum,
  tsCol,
  updatedAt,
} from './_shared.js';

export interface PrivacySettings {
  whoCanDm: 'everyone' | 'contacts' | 'nobody';
  whoCanAddToGroups: 'everyone' | 'contacts' | 'nobody';
  whoCanSeeLastSeen: 'everyone' | 'contacts' | 'nobody';
  whoCanSeeAvatar: 'everyone' | 'contacts' | 'nobody';
  whoCanCall: 'everyone' | 'contacts' | 'nobody';
  readReceipts: boolean;
  typingIndicators: boolean;
  discoverableByPhone: boolean;
  discoverableByUsername: boolean;
}

export interface NotificationSettings {
  dm: 'all' | 'mentions' | 'none';
  groups: 'all' | 'mentions' | 'none';
  calls: boolean;
  reactions: boolean;
  showPreview: boolean;
  sound: string | null;
  quietHours: { enabled: boolean; start: string; end: string; timezone: string } | null;
  /**
   * Unprompted messages from @yapper that are useful rather than urgent — the
   * welcome note, a nudge that a bot token is a year old, a webhook that has
   * stopped answering.
   *
   * Security notices are **not** covered by this and are sent regardless: a
   * sign-in from an unfamiliar device and a suspension are things an account
   * holder is owed, and a preference toggled once in a quiet moment is not
   * informed consent to never hear about either. The split is enforced in
   * `lib/yapperNotify.ts`, not here.
   */
  announcements: boolean;
}

export interface AppearanceSettings {
  theme: 'system' | 'light' | 'dark';
  accent: string;
  fontScale: number;
  reduceMotion: boolean;
}

export const DEFAULT_PRIVACY: PrivacySettings = {
  whoCanDm: 'everyone',
  whoCanAddToGroups: 'contacts',
  whoCanSeeLastSeen: 'contacts',
  whoCanSeeAvatar: 'everyone',
  whoCanCall: 'contacts',
  readReceipts: true,
  typingIndicators: true,
  discoverableByPhone: true,
  discoverableByUsername: true,
};

export const DEFAULT_NOTIFICATIONS: NotificationSettings = {
  dm: 'all',
  groups: 'mentions',
  calls: true,
  reactions: true,
  showPreview: true,
  sound: 'default',
  quietHours: null,
  announcements: true,
};

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  theme: 'system',
  accent: '#6C5CE7',
  fontScale: 1,
  reduceMotion: false,
};

export const users = pgTable(
  'users',
  {
    id: idCol(),

    /** Null until the user finishes onboarding — OTP login creates the row first. */
    username: citext('username'),
    displayName: text('display_name'),
    bio: text('bio'),
    pronouns: text('pronouns'),
    birthday: text('birthday'), // ISO date; text keeps it timezone-free

    avatarMediaId: uuid('avatar_media_id'),
    bannerMediaId: uuid('banner_media_id'),

    /** Identifiers. Stored normalised (E.164 / lowercase) and uniquely indexed
     *  only over non-deleted rows so a deleted account frees its handle. */
    phone: text('phone'),
    phoneVerifiedAt: tsCol('phone_verified_at'),
    email: citext('email'),
    emailVerifiedAt: tsCol('email_verified_at'),

    /** Blind index for contact sync: HMAC(phone, server_pepper). Lets us match
     *  a user's address book without ever receiving plaintext numbers. */
    phoneHash: text('phone_hash'),

    /** Argon2id. Null for OTP/OAuth-only accounts, which is the common case. */
    passwordHash: text('password_hash'),

    presenceStatus: presenceStatusEnum('presence_status').notNull().default('offline'),
    customStatus: text('custom_status'),
    customStatusExpiresAt: tsCol('custom_status_expires_at'),
    /** Coarse (minute-granularity) — exact values leak more than users expect. */
    lastSeenAt: tsCol('last_seen_at'),

    privacy: jsonb('privacy').$type<PrivacySettings>().notNull().default(DEFAULT_PRIVACY),
    notifications: jsonb('notifications')
      .$type<NotificationSettings>()
      .notNull()
      .default(DEFAULT_NOTIFICATIONS),
    appearance: jsonb('appearance').$type<AppearanceSettings>().notNull().default(DEFAULT_APPEARANCE),
    locale: text('locale').notNull().default('en'),

    isBot: boolean('is_bot').notNull().default(false),
    /** Boolean shorthand kept in sync with `badge`; several filters read it. */
    isVerified: boolean('is_verified').notNull().default(false),
    /**
     * Authorisation, not decoration. The staff *badge* is display and could in
     * principle be granted to someone as an honour; this column is what the
     * moderation endpoints, yapper's staff commands and the portal's staff tab
     * actually check. Kept separate so nobody ever widens a permission by
     * changing a label.
     */
    isStaff: boolean('is_staff').notNull().default(false),
    /**
     * The display truth for identity marks: `verified` | `partner` | `staff`,
     * or null. Text rather than an enum because the set of programmes changes
     * on a product timescale and an enum change is a migration with a lock.
     */
    badge: text('badge'),

    /**
     * The group this person displays as their affiliation — its logo renders
     * beside their name, the way an org badge does on Twitter.
     *
     * Two consents are required and neither is enough alone: the group marks
     * the member as an affiliate (`conversation_members.is_affiliate`), and the
     * member points this column at that group. Either side can withdraw. The
     * group must itself carry a badge, so affiliation inherits a verified
     * root rather than letting any group mint credibility for its members.
     */
    affiliationConversationId: uuid('affiliation_conversation_id'),
    /** Moderation state. `suspendedUntil` in the future blocks all writes. */
    suspendedUntil: tsCol('suspended_until'),
    suspensionReason: text('suspension_reason'),

    /** Bumped on password change / "log out everywhere". Any access token minted
     *  before this is rejected without a database lookup per request. */
    tokenEpoch: integer('token_epoch').notNull().default(0),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    uniqueIndex('users_username_uq').on(t.username).where(sql`${t.deletedAt} is null`),
    uniqueIndex('users_phone_uq').on(t.phone).where(sql`${t.deletedAt} is null`),
    uniqueIndex('users_email_uq').on(t.email).where(sql`${t.deletedAt} is null`),
    index('users_phone_hash_idx').on(t.phoneHash).where(sql`${t.deletedAt} is null`),
    /** Trigram index powering username/display-name search. */
    index('users_search_idx').using(
      'gin',
      sql`(coalesce(${t.username}, '') || ' ' || coalesce(${t.displayName}, '')) gin_trgm_ops`,
    ),
    index('users_last_seen_idx').on(t.lastSeenAt),
  ],
);

/**
 * One row per logged-in device. This is the unit of session revocation, push
 * delivery and E2EE key material — never the user.
 */
export const devices = pgTable(
  'devices',
  {
    id: idCol(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    name: text('name'),
    platform: text('platform').notNull(),
    appVersion: text('app_version'),
    osVersion: text('os_version'),

    /** SHA-256 of the refresh token. Rotated on every refresh. */
    refreshTokenHash: text('refresh_token_hash'),
    /**
     * The hash from before the last rotation, honoured until
     * `previousRefreshExpiresAt`. This is the retry window: a client that sends
     * a refresh, loses the response to a dropped connection, and retries must
     * not be logged out. Presenting a previous token *after* that window is
     * treated as theft and kills the session.
     */
    previousRefreshTokenHash: text('previous_refresh_token_hash'),
    previousRefreshExpiresAt: tsCol('previous_refresh_expires_at'),
    refreshTokenExpiresAt: tsCol('refresh_token_expires_at'),

    pushToken: text('push_token'),
    /** iOS VoIP token — required for CallKit to ring a killed app. */
    voipToken: text('voip_token'),
    pushEnvironment: text('push_environment').notNull().default('production'),
    pushFailureCount: integer('push_failure_count').notNull().default(0),

    /** Approximate, for the "active sessions" screen. */
    lastIp: text('last_ip'),
    lastUserAgent: text('last_user_agent'),
    lastActiveAt: tsCol('last_active_at').notNull().defaultNow(),

    revokedAt: tsCol('revoked_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('devices_user_idx').on(t.userId).where(sql`${t.revokedAt} is null`),
    uniqueIndex('devices_refresh_uq').on(t.refreshTokenHash),
    index('devices_push_token_idx').on(t.pushToken).where(sql`${t.pushToken} is not null`),
  ],
);

/**
 * OTP challenges. The code itself is hashed — a database leak must not hand an
 * attacker live login codes.
 */
export const otpChallenges = pgTable(
  'otp_challenges',
  {
    id: idCol(),
    /** Normalised phone or email. */
    identifier: citext('identifier').notNull(),
    channel: text('channel').notNull(), // sms | email
    purpose: text('purpose').notNull(),
    codeHash: text('code_hash').notNull(),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    consumedAt: tsCol('consumed_at'),
    expiresAt: tsCol('expires_at').notNull(),
    requestIp: text('request_ip'),
    createdAt: createdAt(),
  },
  (t) => [
    index('otp_identifier_idx').on(t.identifier, t.purpose).where(sql`${t.consumedAt} is null`),
    index('otp_expires_idx').on(t.expiresAt),
  ],
);

/** Third-party identities (Sign in with Apple, Google). */
export const oauthIdentities = pgTable(
  'oauth_identities',
  {
    id: idCol(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    /** `sub` from the identity token. */
    subject: text('subject').notNull(),
    email: citext('email'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('oauth_provider_subject_uq').on(t.provider, t.subject), index('oauth_user_idx').on(t.userId)],
);

export const usersRelations = relations(users, ({ many }) => ({
  devices: many(devices),
  oauthIdentities: many(oauthIdentities),
}));

export const devicesRelations = relations(devices, ({ one }) => ({
  user: one(users, { fields: [devices.userId], references: [users.id] }),
}));

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Device = typeof devices.$inferSelect;
