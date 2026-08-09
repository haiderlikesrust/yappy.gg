import { boolean, index, jsonb, pgTable, primaryKey, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { conversations } from './conversations.js';
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

    /**
     * Slash commands this bot answers, so clients can offer autocomplete
     * without asking the bot at keystroke time.
     *
     * Declared data rather than a live lookup on purpose: the composer needs
     * this on every "/" keypress, and a bot that is asleep or slow must not
     * make typing feel broken.
     */
    commands: jsonb('commands').$type<unknown[]>().notNull().default([]),

    /**
     * Where this bot hears about the world, when set: message.created in its
     * conversations and presses on its buttons, POSTed as JSON with an
     * `X-Yappy-Signature` HMAC-SHA256 header over the raw body. The secret is
     * generated server-side and shown to the owner once, like the token —
     * without the signature a webhook URL is an open door anyone who guesses
     * it can shout through.
     */
    webhookUrl: text('webhook_url'),
    webhookSecret: text('webhook_secret'),

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

/**
 * One outstanding question a bot has asked someone.
 *
 * A bot that says "send me the code" has to recognise the *next* message as an
 * answer rather than a command, and that is state between two messages. It
 * lives in Postgres rather than in the process for the same reason everything
 * else here does: the API is expected to run as more than one instance, and a
 * prompt answered on whichever one happened to take the request would
 * otherwise be forgotten.
 *
 * At most one per (bot, person). A new question replaces the old one — the
 * alternative is a queue of stale prompts competing to interpret a reply.
 */
export const botPrompts = pgTable(
  'bot_prompts',
  {
    botUserId: uuid('bot_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /** Where it was asked, so an answer typed elsewhere is not accepted. */
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),

    /** What the bot is waiting for, e.g. `awaiting_code`. Bot-defined. */
    state: text('state').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),

    /** Bounded so an abandoned prompt stops hijacking ordinary messages. */
    expiresAt: tsCol('expires_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.botUserId, t.userId] }),
    index('bot_prompts_expiry_idx').on(t.expiresAt),
  ],
);

export type BotPrompt = typeof botPrompts.$inferSelect;
