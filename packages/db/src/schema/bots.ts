import { boolean, index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, idCol, tsCol, updatedAt } from './_shared.js';
import { users } from './users.js';

/**
 * Bots.
 *
 * A bot is not a parallel kind of actor — it is a **user row** with `is_bot`
 * set, plus this application record holding the credential and its owner. That
 * choice pays for itself everywhere downstream: a bot joins conversations,
 * appears in the member list, gets a role, is subject to the same permission
 * bitfield, can be kicked and can be blocked. None of that had to be rebuilt,
 * and there is no second authorisation path to keep in sync with the first.
 *
 * The token is a high-entropy random string, so only its SHA-256 is stored and
 * lookup is a single indexed read on that hash. Argon2 would be the right
 * answer for a human-chosen password and the wrong one here — it buys nothing
 * against 256 bits of entropy and costs 100 ms on every bot request.
 */
export const applications = pgTable(
  'applications',
  {
    id: idCol(),

    /** The human accountable for this bot. Deleting them deletes the bot. */
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /** The bot's own identity in conversations. */
    botUserId: uuid('bot_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    name: text('name').notNull(),
    description: text('description'),

    tokenHash: text('token_hash').notNull(),
    /** Leading characters, shown back to the owner so two tokens are tellable
     *  apart in a list. Never enough to authenticate with. */
    tokenPrefix: text('token_prefix').notNull(),
    tokenIssuedAt: tsCol('token_issued_at').notNull().defaultNow(),
    lastUsedAt: tsCol('last_used_at'),

    /** Listed in the bot directory and addable by anyone. */
    isPublic: boolean('is_public').notNull().default(false),

    revokedAt: tsCol('revoked_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('applications_bot_user_uq').on(t.botUserId),
    /** The authentication path: one lookup per bot request. */
    uniqueIndex('applications_token_hash_uq').on(t.tokenHash),
    index('applications_owner_idx').on(t.ownerId, t.createdAt.desc()),
  ],
);

export type Application = typeof applications.$inferSelect;
