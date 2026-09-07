import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createdAt, idCol, tsCol } from './_shared.js';
import { users } from './users.js';
import { reports } from './moderation.js';
import { conversations } from './conversations.js';

/** Private support intake. Staff can queue email replies through Yapper. */
export const supportTickets = pgTable(
  'support_tickets',
  {
    id: idCol(),
    reference: text('reference').notNull(),
    requestId: uuid('request_id').notNull(),
    payloadHash: text('payload_hash').notNull(),
    category: text('category').notNull(),
    status: text('status').notNull().default('open'),
    contactEmail: text('contact_email').notNull(),
    accountHint: text('account_hint'),
    message: text('message').notNull(),
    /** Only populated by a verified, support-only appeal link; never by form fields. */
    verifiedUserId: uuid('verified_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    reportId: uuid('report_id').references(() => reports.id, {
      onDelete: 'set null',
    }),
    client: text('client'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('support_ticket_reference_uq').on(t.reference),
    uniqueIndex('support_ticket_request_uq').on(t.requestId),
    index('support_ticket_account_idx').on(t.verifiedUserId, t.createdAt),
    index('support_ticket_queue_idx').on(t.category, t.status, t.createdAt),
  ],
);

export const staffCommandDrafts = pgTable(
  'staff_command_drafts',
  {
    id: idCol(),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    data: jsonb('data').notNull(),
    state: text('state').notNull().default('pending'),
    expiresAt: tsCol('expires_at')
      .notNull()
      .default(sql`now() + interval '15 minutes'`),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      'staff_command_drafts_kind_check',
      sql`${t.kind} in ('reply', 'warn', 'suspend')`,
    ),
    check(
      'staff_command_drafts_state_check',
      sql`${t.state} in ('pending', 'prepared', 'confirmed', 'cancelled')`,
    ),
  ],
);

export const supportTicketReplies = pgTable(
  'support_ticket_replies',
  {
    id: uuid('id').primaryKey(),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => supportTickets.id, { onDelete: 'cascade' }),
    staffId: uuid('staff_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    body: text('body').notNull(),
    recipient: text('recipient').notNull(),
    emailJobId: uuid('email_job_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('support_reply_ticket_idx').on(t.ticketId, t.createdAt)],
);

export const staffCaseNotes = pgTable(
  'staff_case_notes',
  {
    id: idCol(),
    reportId: uuid('report_id').references(() => reports.id, {
      onDelete: 'cascade',
    }),
    ticketId: uuid('ticket_id').references(() => supportTickets.id, {
      onDelete: 'cascade',
    }),
    staffId: uuid('staff_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    body: text('body').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      'staff_case_notes_check',
      sql`(${t.reportId} is null) <> (${t.ticketId} is null)`,
    ),
    index('staff_notes_report_idx').on(t.reportId, t.createdAt),
    index('staff_notes_ticket_idx').on(t.ticketId, t.createdAt),
  ],
);
