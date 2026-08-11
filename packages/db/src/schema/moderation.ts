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

export type Report = typeof reports.$inferSelect;
export type BugReport = typeof bugReports.$inferSelect;
