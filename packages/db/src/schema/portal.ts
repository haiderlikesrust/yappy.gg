import { index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, idCol, tsCol } from './_shared.js';
import { users } from './users.js';

/**
 * Signing in to the developer portal, from the app.
 *
 * The direction of this flow is the whole point, and it is the opposite of a
 * password reset. A code that travels *to* the user (by SMS, email or a bot
 * message) can be read out to whoever asked for it, and people can be talked
 * into that. Here the browser displays the code and the user carries it into
 * the app, which is a place they are already authenticated. To be phished, a
 * victim would have to be persuaded to type an attacker's code into their own
 * client, and then confirm a prompt naming a browser and location that are not
 * theirs.
 *
 * This is RFC 8628's device authorization grant in shape: the same reason a
 * television asks you to type a code into your phone rather than reading you
 * one out.
 */
export const deviceGrants = pgTable(
  'device_grants',
  {
    id: idCol(),

    /**
     * The short code the browser shows and the human retypes. Stored hashed
     * for the same reason an OTP is: a database leak must not hand out live
     * sessions. Short and unambiguous, so it is rate limited hard rather than
     * made long enough to resist guessing.
     */
    userCodeHash: text('user_code_hash').notNull(),

    /**
     * The browser's own handle for this attempt, sent on every poll. Long and
     * random, unlike the user code, because nobody has to read it aloud.
     */
    pollTokenHash: text('poll_token_hash').notNull(),

    /**
     * What the person is being asked to approve. Recorded at *request* time
     * and shown back verbatim by the bot, because "approve a sign-in" with no
     * detail is a prompt people click through.
     */
    clientDescription: text('client_description').notNull(),
    requestIp: text('request_ip'),

    /** pending → awaiting_confirm → approved | denied. Never back. */
    status: text('status').notNull().default('pending'),

    /**
     * Set when someone claims the code with `/login dev`, before they confirm.
     * Recorded early so a second person cannot claim the same code, and so an
     * abandoned confirmation is attributable.
     */
    claimedByUserId: uuid('claimed_by_user_id').references(() => users.id, { onDelete: 'cascade' }),
    claimedAt: tsCol('claimed_at'),

    approvedAt: tsCol('approved_at'),
    /** Consumed on the first successful poll; a grant is single use. */
    consumedAt: tsCol('consumed_at'),

    /** Wrong codes typed at the bot. A handful, then the grant is dead. */
    attempts: text('attempts').notNull().default('0'),

    expiresAt: tsCol('expires_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('device_grants_poll_uq').on(t.pollTokenHash),
    /** The bot's lookup: find a live grant by the code someone just typed. */
    index('device_grants_code_idx').on(t.userCodeHash),
    index('device_grants_expiry_idx').on(t.expiresAt),
  ],
);

export type DeviceGrant = typeof deviceGrants.$inferSelect;
