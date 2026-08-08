import { sql } from 'drizzle-orm';
import { boolean, index, integer, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, idCol, tsCol } from './_shared.js';
import { devices, users } from './users.js';

/**
 * End-to-end encryption key distribution (X3DH / Double Ratchet shaped).
 *
 * The server is a *key directory and prekey vending machine only* — it never
 * sees a private key or a plaintext. Nothing here is wired into the message
 * path yet: messages are server-visible today, which is what makes search,
 * link previews, push previews and moderation work.
 *
 * These tables exist now because key distribution is the part that cannot be
 * retrofitted. Adding it later means every existing device has no identity key
 * and every historical conversation has no session — a migration users
 * experience as "all your old messages are gone". Shipping the directory from
 * day one keeps opt-in E2EE for DMs a feature flag rather than a rewrite.
 */
export const cryptoIdentities = pgTable(
  'crypto_identities',
  {
    deviceId: uuid('device_id')
      .primaryKey()
      .references(() => devices.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /** Long-term Curve25519 public identity key, base64. */
    identityKey: text('identity_key').notNull(),

    signedPreKeyId: integer('signed_pre_key_id').notNull(),
    signedPreKey: text('signed_pre_key').notNull(),
    signedPreKeySignature: text('signed_pre_key_signature').notNull(),
    signedPreKeyRotatedAt: tsCol('signed_pre_key_rotated_at').notNull().defaultNow(),

    /** Safety-number/QR verification between two humans. */
    fingerprint: text('fingerprint').notNull(),

    createdAt: createdAt(),
  },
  (t) => [index('crypto_identities_user_idx').on(t.userId)],
);

/**
 * One-time prekeys, consumed on first contact. Claiming deletes the row inside
 * the same transaction, so two senders can never be handed the same key.
 * The client refills when the count drops below a threshold.
 */
export const oneTimePreKeys = pgTable(
  'one_time_pre_keys',
  {
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    keyId: integer('key_id').notNull(),
    publicKey: text('public_key').notNull(),
    claimedAt: tsCol('claimed_at'),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.deviceId, t.keyId] }),
    index('otpk_available_idx').on(t.deviceId).where(sql`${t.claimedAt} is null`),
  ],
);

/**
 * Records that user A has verified user B's safety number. A change in the
 * other side's identity key flips this to `false` and the UI warns — the whole
 * point of the mechanism.
 */
export const keyVerifications = pgTable(
  'key_verifications',
  {
    id: idCol(),
    verifierId: uuid('verifier_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    verifiedUserId: uuid('verified_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Fingerprint at the time of verification. */
    fingerprint: text('fingerprint').notNull(),
    isValid: boolean('is_valid').notNull().default(true),
    verifiedAt: tsCol('verified_at').notNull().defaultNow(),
  },
  (t) => [index('key_verifications_pair_idx').on(t.verifierId, t.verifiedUserId)],
);

export type CryptoIdentity = typeof cryptoIdentities.$inferSelect;
