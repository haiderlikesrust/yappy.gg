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

    /**
     * Delivery health, so a webhook that has quietly stopped answering can be
     * noticed and its owner told.
     *
     * Kept as *consecutive* failures rather than a total: the number that
     * matters is "is it down now", and a lifetime counter answers a different
     * question nobody asked. Reset by the first success, which is also what
     * makes the alert self-clearing — the same shape as `pushFailureCount` on
     * a device, for the same reason.
     */
    webhookFailureCount: integer('webhook_failure_count').notNull().default(0),
    webhookLastFailureAt: tsCol('webhook_last_failure_at'),
    webhookLastSuccessAt: tsCol('webhook_last_success_at'),

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

/**
 * Group lore: facts a group has asked yapper to remember.
 *
 * `/remember the lads never talk about Mario Kart night` — a shared, group-owned
 * list, not a per-user one, which is what makes it lore rather than notes. The
 * whole list is injected into yapper's context when the group summons it, so
 * the cap is a prompt-size budget as much as a storage one, enforced in code.
 *
 * Attribution is kept (`authorId`) so /lore can say who taught the bot what,
 * but the author holds no special rights: any member can /forget, the same way
 * any member could have shouted the fact down in chat.
 */
export const yapperLore = pgTable(
  'yapper_lore',
  {
    id: idCol(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    /** Kept for attribution; the fact outlives the author leaving. */
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    body: text('body').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    // /lore lists in taught order, and the AI injection reads newest-first —
    // both are this one index walked in opposite directions.
    index('yapper_lore_conversation_idx').on(t.conversationId, t.createdAt),
  ],
);

export type YapperLoreFact = typeof yapperLore.$inferSelect;

/**
 * The bot event inspector's memory: recent webhook delivery attempts, per
 * application.
 *
 * One row per *attempt* — a retried delivery appears once per try, because
 * "it failed twice then went through" is exactly what a developer debugging a
 * flaky endpoint needs to see. The payload is stored as pre-serialized text,
 * clamped at write time: this is a debugging window, not an archive, and a
 * multi-megabyte message payload would make it neither.
 *
 * Ring-capped in code (the writer prunes past the newest N per app), so the
 * table cannot grow with traffic — only with the number of bots.
 */
export const botEventLog = pgTable(
  'bot_event_log',
  {
    id: idCol(),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    /** The event name, e.g. `message.create`, `interaction.pressed`, `webhook.test`. */
    type: text('type').notNull(),
    /** Serialized event body, clamped to a few KB at write time. */
    payload: text('payload'),
    /** 'delivered' | 'failed' — per attempt. */
    status: text('status').notNull(),
    httpStatus: integer('http_status'),
    durationMs: integer('duration_ms'),
    /** The useful half of a failure: 'timeout', 'ECONNREFUSED', 'HTTP 500'. */
    detail: text('detail'),
    createdAt: createdAt(),
  },
  (t) => [index('bot_event_log_app_idx').on(t.applicationId, t.createdAt.desc())],
);

export type BotEventLogRow = typeof botEventLog.$inferSelect;
