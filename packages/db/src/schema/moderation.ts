import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, idCol, reportStatusEnum, tsCol, updatedAt } from './_shared.js';
import { users } from './users.js';

export const reports = pgTable(
  'reports',
  {
    id: idCol(),
    reporterId: uuid('reporter_id').references(() => users.id, { onDelete: 'set null' }),
    targetType: text('target_type').notNull(), // user | message | conversation | sticker_pack
    targetId: uuid('target_id').notNull(),
    reason: text('reason').notNull(),
    detail: text('detail'),

    /**
     * Frozen copy of the reported content. Without it, a reporter's evidence
     * disappears the moment the offender deletes the message — which is
     * exactly what offenders do.
     */
    evidence: jsonb('evidence').$type<Record<string, unknown>>(),

    status: reportStatusEnum('status').notNull().default('open'),
    /** Higher = triage sooner. Bumped by report volume and classifier scores. */
    priority: integer('priority').notNull().default(0),

    assignedToId: uuid('assigned_to_id').references(() => users.id, { onDelete: 'set null' }),
    resolution: text('resolution'),
    resolvedAt: tsCol('resolved_at'),

    /**
     * The card yapper posted for this report in the staff #reports channel.
     * Held so an action taken from the portal can retire the card in chat and
     * vice versa — one report, one card, whichever surface acts first.
     */
    staffMessageId: uuid('staff_message_id'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('reports_queue_idx')
      .on(t.priority.desc(), t.createdAt)
      .where(sql`${t.status} = 'open'`),
    index('reports_target_idx').on(t.targetType, t.targetId),
    index('reports_reporter_idx').on(t.reporterId, t.createdAt.desc()),
  ],
);

/** Immutable record of every moderator action. */
export const moderationActions = pgTable(
  'moderation_actions',
  {
    id: idCol(),
    moderatorId: uuid('moderator_id').references(() => users.id, { onDelete: 'set null' }),
    reportId: uuid('report_id').references(() => reports.id, { onDelete: 'set null' }),
    action: text('action').notNull(), // warn | suspend | ban | delete_content | dismiss | shadow_limit
    targetType: text('target_type').notNull(),
    targetId: uuid('target_id').notNull(),
    reason: text('reason'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    expiresAt: tsCol('expires_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('mod_actions_target_idx').on(t.targetType, t.targetId, t.createdAt.desc()),
    index('mod_actions_moderator_idx').on(t.moderatorId, t.createdAt.desc()),
  ],
);

/**
 * Security-relevant events on an account: new device, password change, session
 * revoked, suspicious login. Surfaced in the app's security screen and used for
 * abuse investigation.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: idCol(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    action: text('action').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index('audit_user_idx').on(t.userId, t.createdAt.desc())],
);

/**
 * A bug somebody took the trouble to report.
 *
 * Separate from `reports`, which is moderation — one is "this person is
 * behaving badly", the other is "this software is broken", and they share a
 * queue only by accident of both being called a report.
 *
 * The environment columns are a *snapshot*, deliberately denormalised off the
 * reporter's device row rather than joined at read time. A bug is about the
 * build it happened on; resolving the device later would relabel every old
 * report with whatever version that person happens to be running now.
 */
export const bugReports = pgTable(
  'bug_reports',
  {
    id: idCol(),
    reporterId: uuid('reporter_id').references(() => users.id, { onDelete: 'set null' }),

    title: text('title').notNull(),
    description: text('description').notNull(),

    /**
     * Short, human, and said out loud: "any news on BUG-7QK3". A uuid is not
     * something anybody repeats back to you.
     */
    reference: text('reference').notNull(),

    /** open | fixed | known | need_more | invalid */
    status: text('status').notNull().default('open'),

    /** Where it happened, as at the moment of reporting. */
    platform: text('platform'),
    appVersion: text('app_version'),
    osVersion: text('os_version'),

    /**
     * Attachments, held here as well as on the posted card.
     *
     * The card is what staff read, but it is also the thing most likely to be
     * missing — the channel may not exist yet, and posting can fail. The proof
     * someone went to the trouble of taking should not depend on that.
     */
    mediaIds: uuid('media_ids').array().notNull().default([]),

    /** The card yapper posted in the staff #bug channel, if it got posted. */
    staffMessageId: uuid('staff_message_id'),

    resolvedById: uuid('resolved_by_id').references(() => users.id, { onDelete: 'set null' }),
    resolvedAt: tsCol('resolved_at'),
    /** Set when staff press "Need more" — the question put back to the reporter. */
    note: text('note'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('bug_reference_uq').on(t.reference),
    index('bug_open_idx').on(t.createdAt.desc()).where(sql`${t.status} = 'open'`),
    /**
     * "How many accepted bugs has this person filed" — the reward metric, and
     * the reason this index has `status` in it rather than just the reporter.
     */
    index('bug_reporter_idx').on(t.reporterId, t.status, t.createdAt.desc()),
  ],
);

/**
 * One person's claim on the early-tester reward.
 *
 * A row exists from the moment a slot is *reserved*, not from the moment
 * somebody asks to be paid — which is the whole design. The treasury is three
 * payments wide, so telling a fourth person they qualify and letting them find
 * out later is the failure worth engineering against. yapper only says "you can
 * claim this" after the slot is already theirs, and an unclaimed reservation
 * expires back into the pool rather than sitting on it forever.
 *
 * Deliberately temporary. The whole feature comes out when the app is on the
 * stores, and this table goes with it.
 */
export const earlyClaims = pgTable(
  'early_claims',
  {
    id: idCol(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /** reserved | submitted | paid | expired | cancelled */
    status: text('status').notNull().default('reserved'),

    /**
     * Base58, exactly as typed and then confirmed in the app.
     *
     * Never normalised, never trimmed into shape beyond whitespace: a Solana
     * address one character wrong is a different valid-looking address, and
     * anything sent there is gone. It is echoed back in full for confirmation
     * for the same reason.
     */
    walletAddress: text('wallet_address'),

    amountUsd: integer('amount_usd').notNull(),

    /** When the reservation lapses, if it is still unclaimed. */
    expiresAt: tsCol('expires_at').notNull(),

    /** They typed an address on the web. Not yet worth acting on. */
    submittedAt: tsCol('submitted_at'),

    /**
     * They read it back in the app and said yes.
     *
     * The distinction is the whole safety story. An address that has been typed
     * has been checked by nobody; an address that has been confirmed has been
     * read by the person it belongs to, which is the only defence a Solana
     * address has — it carries no checksum. Payment works from this column, not
     * from `submitted_at`.
     */
    confirmedAt: tsCol('confirmed_at'),

    /**
     * Paid by hand, and recorded by hand.
     *
     * Three payments do not justify a hot wallet holding real money inside the
     * API. Somebody sends the USDC and pastes the signature back, which leaves
     * an auditable trail and no key anywhere near this process.
     */
    paidAt: tsCol('paid_at'),
    txSignature: text('tx_signature'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // One claim per person, enforced here rather than checked before insert:
    // two tabs pressing at once is exactly how a treasury of three pays four.
    uniqueIndex('early_claim_user_uq').on(t.userId),
    index('early_claim_open_idx').on(t.status, t.expiresAt),
  ],
);

export type Report = typeof reports.$inferSelect;
export type BugReport = typeof bugReports.$inferSelect;
export type EarlyClaim = typeof earlyClaims.$inferSelect;
