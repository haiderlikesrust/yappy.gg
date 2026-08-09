import { boolean, index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { conversations } from './conversations.js';
import { createdAt, deletedAt, idCol } from './_shared.js';
import { media } from './media.js';
import { users } from './users.js';

/**
 * Custom emoji, owned by a group or space.
 *
 * Deliberately *scoped to the conversation that made them* — usable there and
 * nowhere else. That is the restriction Discord charges to lift, and it is
 * the right default for a different reason here: an emoji is part of a
 * group's identity, like its logo and flair, and identity that leaks
 * everywhere stops being identity.
 *
 * On the wire an emoji appears in message text as `:name:`. The text stays
 * plain — search still works, notifications read sensibly, and a client that
 * predates the feature shows a legible token instead of a broken image.
 */
export const customEmojis = pgTable(
  'custom_emojis',
  {
    id: idCol(),

    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),

    /** Lowercase [a-z0-9_], 2–32 chars — enforced in the shared schema. */
    name: text('name').notNull(),

    mediaId: uuid('media_id')
      .notNull()
      .references(() => media.id, { onDelete: 'cascade' }),

    animated: boolean('animated').notNull().default(false),

    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    /** Soft delete keeps `:name:` in old messages resolvable to "was deleted"
     *  rather than rendering as a bare token with no explanation. */
    deletedAt: deletedAt(),
  },
  (t) => [
    /** One live meaning per name per group. A deleted name can be reused. */
    uniqueIndex('custom_emojis_name_uq')
      .on(t.conversationId, t.name)
      .where(sql`${t.deletedAt} is null`),
    index('custom_emojis_conversation_idx').on(t.conversationId).where(sql`${t.deletedAt} is null`),
  ],
);

export type CustomEmoji = typeof customEmojis.$inferSelect;
