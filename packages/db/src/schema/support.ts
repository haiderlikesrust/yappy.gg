import { index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, idCol } from './_shared.js';
import { users } from './users.js';
import { reports } from './moderation.js';

/** Private support intake. Replies are handled by the support mailbox. */
export const supportTickets = pgTable('support_tickets', {
  id: idCol(),
  reference: text('reference').notNull(),
  requestId: uuid('request_id').notNull(),
  payloadHash: text('payload_hash').notNull(),
  category: text('category').notNull(),
  contactEmail: text('contact_email').notNull(),
  accountHint: text('account_hint'),
  message: text('message').notNull(),
  /** Only populated by a verified, support-only appeal link; never by form fields. */
  verifiedUserId: uuid('verified_user_id').references(() => users.id, { onDelete: 'set null' }),
  reportId: uuid('report_id').references(() => reports.id, { onDelete: 'set null' }),
  client: text('client'),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('support_ticket_reference_uq').on(t.reference),
  uniqueIndex('support_ticket_request_uq').on(t.requestId),
  index('support_ticket_account_idx').on(t.verifiedUserId, t.createdAt),
]);
