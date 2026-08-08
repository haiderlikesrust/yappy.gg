import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
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

export type Report = typeof reports.$inferSelect;
