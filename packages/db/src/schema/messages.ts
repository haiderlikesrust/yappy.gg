import { desc, relations, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, deletedAt, idCol, messageTypeEnum, tsCol, updatedAt } from './_shared.js';
import { conversations } from './conversations.js';
import { media } from './media.js';
import { stickers } from './stickers.js';
import { users } from './users.js';

/** Inline formatting + mentions + links, Telegram-style offsets. Storing spans
 *  rather than markup keeps the plain text searchable and lets each client
 *  render in its own style. */
export type MessageEntity =
  | { type: 'mention'; offset: number; length: number; userId: string }
  | { type: 'mention_all'; offset: number; length: number }
  | { type: 'mention_role'; offset: number; length: number; roleId: string }
  | { type: 'link'; offset: number; length: number; url: string }
  | { type: 'bold' | 'italic' | 'strike' | 'spoiler' | 'code'; offset: number; length: number }
  | { type: 'pre'; offset: number; length: number; language?: string | null };

export interface GifPayload {
  provider: 'tenor' | 'giphy';
  id: string;
  url: string;
  previewUrl: string;
  width: number;
  height: number;
  title?: string;
}

export interface LocationPayload {
  latitude: number;
  longitude: number;
  name?: string | null;
  liveUntil?: string | null;
}

export interface CallSummaryPayload {
  callId: string;
  mode: 'audio' | 'video';
  outcome: 'completed' | 'missed' | 'declined' | 'cancelled';
  durationSeconds: number;
  participantIds: string[];
}

export interface SystemPayload {
  event: string;
  actorId?: string;
  targetIds?: string[];
  value?: string | null;
}

/**
 * Messages.
 *
 * At scale this table wants to be range-partitioned by `created_at` (monthly)
 * — see sql/0004_partitioning.sql.md for the DDL and the reasoning. The
 * ORM model is identical either way.
 */
export const messages = pgTable(
  'messages',
  {
    id: idCol(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),

    /** Gapless per-conversation ordinal. See conversations.messageSeq. */
    seq: bigint('seq', { mode: 'number' }).notNull(),

    /** Null for system messages authored by the server. */
    senderId: uuid('sender_id').references(() => users.id, { onDelete: 'set null' }),

    type: messageTypeEnum('type').notNull().default('text'),

    /**
     * Whether the body lives in `message_envelopes` rather than in `content`.
     *
     * `content` is not empty for these: it holds a fixed notice, in plain
     * text, saying the message is encrypted and this client cannot read it.
     * That is deliberate. A client that has never heard of encryption still
     * renders *something* instead of an empty bubble, and the notice says
     * nothing private — it is the same sentence on every encrypted message.
     */
    isEncrypted: boolean('is_encrypted').notNull().default(false),
    content: text('content'),
    entities: jsonb('entities').$type<MessageEntity[]>(),

    replyToId: uuid('reply_to_id').references((): AnyPgColumn => messages.id, { onDelete: 'set null' }),
    /** Set on every message in a thread, including the root. Makes fetching a
     *  thread a single indexed range scan. */
    threadRootId: uuid('thread_root_id').references((): AnyPgColumn => messages.id, { onDelete: 'set null' }),
    threadReplyCount: integer('thread_reply_count').notNull().default(0),
    /**
     * When the thread rooted here last got a reply.
     *
     * Denormalised onto the root so a forum can sort its posts by liveliness
     * without touching the replies. Bumped in the same statement as the
     * count, so it costs nothing beyond the write already happening.
     */
    threadLastReplyAt: tsCol('thread_last_reply_at'),

    /**
     * A forum post's title.
     *
     * Only meaningful on the root message of a post in a forum channel. A
     * forum is a list of titles — that is the entire difference between
     * "scroll to see if anyone answered" and "scan for the one that is mine".
     */
    title: text('title'),

    forwardedFromMessageId: uuid('forwarded_from_message_id'),
    forwardedFromUserId: uuid('forwarded_from_user_id').references(() => users.id, { onDelete: 'set null' }),

    stickerId: uuid('sticker_id').references(() => stickers.id, { onDelete: 'set null' }),
    gif: jsonb('gif').$type<GifPayload>(),
    location: jsonb('location').$type<LocationPayload>(),
    contact: jsonb('contact').$type<{ name: string; phone?: string | null; userId?: string | null }>(),
    callSummary: jsonb('call_summary').$type<CallSummaryPayload>(),
    system: jsonb('system').$type<SystemPayload>(),

    /**
     * Client-generated idempotency key, unique per sender. A retried send after
     * a dropped response returns the original row instead of double-posting —
     * the single most common duplicate-message bug in mobile chat apps.
     */
    nonce: text('nonce'),

    editedAt: tsCol('edited_at'),

    /**
     * A stable name its author can address this message by, instead of an id.
     *
     * Everything about a bot that maintains a card is hostile to remembering
     * an id: it restarts, it redeploys, it runs as a cron job that shares no
     * memory with the last run. Handed a name, the server does the
     * remembering — `PUT /conversations/:id/cards/sol-price` creates the
     * message the first time and edits the same one forever after.
     *
     * Scoped per sender, so two bots on one board can both own a card called
     * `price` without either of them knowing the other exists.
     */
    cardKey: text('card_key'),
    /** Disappearing messages. A sweeper job soft-deletes past this. */
    expiresAt: tsCol('expires_at'),

    /** Suppress push for this one message ("send silently"). */
    silent: boolean('silent').notNull().default(false),

    /** Reaction rollup, maintained by trigger: { "🔥": 12, "😂": 3 }. Avoids an
     *  aggregate over message_reactions on every history page. */
    reactionCounts: jsonb('reaction_counts').$type<Record<string, number>>().notNull().default({}),

    /** Bot/webhook-authored rich cards. Link previews are *not* stored here —
     *  they live in `link_previews`, shared across every message citing the
     *  same URL, and are merged into the same wire field at serialization. */
    embeds: jsonb('embeds').$type<unknown[]>().notNull().default([]),

    /** Interactive rows a bot attached. Rewritten in place when a button is
     *  pressed, which is how a spent prompt stops being pressable. */
    components: jsonb('components').$type<unknown[]>().notNull().default([]),

    deletedById: uuid('deleted_by_id').references(() => users.id, { onDelete: 'set null' }),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    /** The history query. DESC because every read starts at the newest message. */
    uniqueIndex('messages_conversation_seq_uq').on(t.conversationId, t.seq),
    /** One card per name per author per channel — the upsert depends on it. */
    uniqueIndex('messages_card_key_uq')
      .on(t.conversationId, t.senderId, t.cardKey)
      .where(sql`${t.cardKey} is not null`),
    index('messages_conversation_created_idx').on(t.conversationId, t.createdAt.desc()),
    uniqueIndex('messages_sender_nonce_uq').on(t.senderId, t.nonce).where(sql`${t.nonce} is not null`),
    index('messages_thread_idx').on(t.threadRootId, t.seq).where(sql`${t.threadRootId} is not null`),
    /* A forum's post list: roots in one channel, liveliest first. */
    index('messages_forum_idx')
      .on(t.conversationId, sql`coalesce(${t.threadLastReplyAt}, ${t.createdAt}) desc`)
      .where(sql`${t.threadRootId} is null and ${t.deletedAt} is null`),
    index('messages_reply_idx').on(t.replyToId).where(sql`${t.replyToId} is not null`),
    index('messages_expires_idx').on(t.expiresAt).where(sql`${t.expiresAt} is not null and ${t.deletedAt} is null`),
    // Full-text search lives entirely in sql/0001_constraints.sql: it needs a
    // GENERATED tsvector column, which Drizzle's DSL cannot declare. Keeping
    // the index out of here too stops `drizzle-kit generate` from trying to
    // drop an index it does not understand on every diff.
    /** Media galleries ("photos in this chat"). */
    index('messages_type_idx')
      .on(t.conversationId, t.type, t.seq.desc())
      .where(sql`${t.deletedAt} is null`),
  ],
);

export const messageAttachments = pgTable(
  'message_attachments',
  {
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    mediaId: uuid('media_id')
      .notNull()
      .references(() => media.id, { onDelete: 'restrict' }),
    position: smallint('position').notNull().default(0),
    caption: text('caption'),
    /** Tap-to-reveal. */
    isSpoiler: boolean('is_spoiler').notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.messageId, t.mediaId] }),
    index('attachments_media_idx').on(t.mediaId),
  ],
);

/**
 * One row per (message, user, emoji). The aggregate lives on
 * `messages.reaction_counts`; this table exists so "who reacted" and "did I
 * react" stay answerable.
 */
export const messageReactions = pgTable(
  'message_reactions',
  {
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Unicode emoji, or `sticker:<uuid>` for a sticker reaction. */
    emoji: text('emoji').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.messageId, t.userId, t.emoji] }),
    index('reactions_message_idx').on(t.messageId),
    index('reactions_user_idx').on(t.userId),
  ],
);

/**
 * Denormalised mention index.
 *
 * Without it, "how many unread mentions in this group" is a full-text scan over
 * the message history on every app open. With it, it is a range scan on
 * (user_id, conversation_id, seq).
 */
export const messageMentions = pgTable(
  'message_mentions',
  {
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    /** True for @everyone rather than a direct mention — clients style these
     *  differently and some users mute them. */
    isBroadcast: boolean('is_broadcast').notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.messageId, t.userId] }),
    index('mentions_inbox_idx').on(t.userId, t.conversationId, t.seq),
    /**
     * The global inbox: everywhere one person was called, newest first.
     *
     * A separate index from the one above rather than a reordering of it —
     * that one answers "what is unread *in this room*", which is what the
     * badge counter asks and needs the conversation in the middle. This one
     * has no room in the question at all.
     *
     * Ordered by message id because ids are UUIDv7, so id order is time order
     * and the page cursor is just the last id on the page.
     */
    index('mentions_by_time_idx').on(t.userId, desc(t.messageId)),
  ],
);

export const pinnedMessages = pgTable(
  'pinned_messages',
  {
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    pinnedById: uuid('pinned_by_id').references(() => users.id, { onDelete: 'set null' }),
    /** Manual ordering in the pinned drawer. */
    position: integer('position').notNull().default(0),
    pinnedAt: tsCol('pinned_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.conversationId, t.messageId] }),
    index('pins_conversation_idx').on(t.conversationId, t.position, t.pinnedAt.desc()),
  ],
);

/**
 * Personal bookmarks — "saved messages", Telegram-style but as metadata
 * rather than a self-conversation. A row means this user bookmarked this
 * message; the message itself stays where it lives, and visibility is
 * re-checked against membership at read time, so leaving a group quietly
 * drops its saved messages rather than smuggling them out.
 */
export const savedMessages = pgTable(
  'saved_messages',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    savedAt: tsCol('saved_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.messageId] }),
    index('saved_messages_user_idx').on(t.userId, t.savedAt.desc()),
  ],
);

/** Edit history, so "edited" can show a diff and moderation can see the original. */
export const messageRevisions = pgTable(
  'message_revisions',
  {
    id: idCol(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    content: text('content'),
    entities: jsonb('entities').$type<MessageEntity[]>(),
    editedAt: tsCol('edited_at').notNull().defaultNow(),
  },
  (t) => [index('revisions_message_idx').on(t.messageId, t.editedAt.desc())],
);

/**
 * "Delete for me" — a per-user tombstone. The message stays intact for everyone
 * else, so a shared thread does not develop holes.
 */
export const messageDeletions = pgTable(
  'message_deletions',
  {
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.userId] })],
);

// ─── Polls ───────────────────────────────────────────────────────────────────

export const polls = pgTable('polls', {
  id: idCol(),
  messageId: uuid('message_id')
    .notNull()
    .references(() => messages.id, { onDelete: 'cascade' })
    .unique(),
  question: text('question').notNull(),
  multiSelect: boolean('multi_select').notNull().default(false),
  isAnonymous: boolean('is_anonymous').notNull().default(false),
  closesAt: tsCol('closes_at'),
  closedAt: tsCol('closed_at'),
  totalVoters: integer('total_voters').notNull().default(0),
  createdAt: createdAt(),
});

export const pollOptions = pgTable(
  'poll_options',
  {
    id: idCol(),
    pollId: uuid('poll_id')
      .notNull()
      .references(() => polls.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    position: smallint('position').notNull(),
    voteCount: integer('vote_count').notNull().default(0),
  },
  (t) => [index('poll_options_poll_idx').on(t.pollId, t.position)],
);

export const pollVotes = pgTable(
  'poll_votes',
  {
    pollId: uuid('poll_id')
      .notNull()
      .references(() => polls.id, { onDelete: 'cascade' }),
    optionId: uuid('option_id')
      .notNull()
      .references(() => pollOptions.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.optionId, t.userId] }),
    index('poll_votes_poll_user_idx').on(t.pollId, t.userId),
  ],
);

// ─── Link previews ───────────────────────────────────────────────────────────

/** Cached OG scrapes, keyed by URL hash and shared across every message that
 *  links the same page. Fetched by the worker, never inline on send. */
export const linkPreviews = pgTable(
  'link_previews',
  {
    urlHash: text('url_hash').primaryKey(),
    url: text('url').notNull(),
    title: text('title'),
    description: text('description'),
    siteName: text('site_name'),
    imageMediaId: uuid('image_media_id').references(() => media.id, { onDelete: 'set null' }),
    /** oembed html for video providers, sanitised. */
    embedHtml: text('embed_html'),
    fetchedAt: tsCol('fetched_at').notNull().defaultNow(),
    expiresAt: tsCol('expires_at').notNull(),
    failed: boolean('failed').notNull().default(false),
  },
  (t) => [index('link_previews_expires_idx').on(t.expiresAt)],
);

export const messagePreviews = pgTable(
  'message_previews',
  {
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    urlHash: text('url_hash')
      .notNull()
      .references(() => linkPreviews.urlHash, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.urlHash] })],
);

// ─── Scheduled messages ──────────────────────────────────────────────────────

export const scheduledMessages = pgTable(
  'scheduled_messages',
  {
    id: idCol(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    senderId: uuid('sender_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The full sendMessage body, replayed by the worker at `sendAt`. */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    sendAt: tsCol('send_at').notNull(),
    sentMessageId: uuid('sent_message_id').references(() => messages.id, { onDelete: 'set null' }),
    cancelledAt: tsCol('cancelled_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('scheduled_due_idx')
      .on(t.sendAt)
      .where(sql`${t.sentMessageId} is null and ${t.cancelledAt} is null`),
    index('scheduled_user_idx').on(t.senderId, t.sendAt),
  ],
);

/**
 * A location that is still moving.
 *
 * The message is the anchor: it holds the point the share *started* from and
 * keeps its place in the timeline forever. The current position lives here and
 * is overwritten, because a live share is a few hundred pings and writing each
 * one into the message would rewrite a history row — and fan a `message.update`
 * out to everyone — every fifteen seconds.
 *
 * One row per message rather than per user, so a person can be sharing in two
 * conversations at once without one stopping the other. `expiresAt` is the
 * authority on when it is over: clients enforce it too, but a client that
 * stops asking is not the same as a share that has ended, and only the server
 * can be trusted with the difference.
 */
export const liveLocations = pgTable(
  'live_locations',
  {
    messageId: uuid('message_id')
      .primaryKey()
      .references(() => messages.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    latitude: doublePrecision('latitude').notNull(),
    longitude: doublePrecision('longitude').notNull(),
    /** Metres. Drawn as the circle around the dot, when a client draws one. */
    accuracy: doublePrecision('accuracy'),
    /** Degrees from true north, when the device knows which way it is going. */
    heading: doublePrecision('heading'),

    expiresAt: tsCol('expires_at').notNull(),
    /** Set when the sender stopped early, or when the sweep retired it. */
    endedAt: tsCol('ended_at'),
    updatedAt: updatedAt(),
    createdAt: createdAt(),
  },
  (t) => [
    /** "What is still live in this conversation" — the only read on open. */
    index('live_location_active_idx')
      .on(t.conversationId)
      .where(sql`${t.endedAt} is null`),
    /** The sweep: everything past its end that nobody has retired yet. */
    index('live_location_expiry_idx')
      .on(t.expiresAt)
      .where(sql`${t.endedAt} is null`),
    index('live_location_user_idx').on(t.userId),
  ],
);

export const messagesRelations = relations(messages, ({ one, many }) => ({
  conversation: one(conversations, {
    fields: [messages.conversationId],
    references: [conversations.id],
  }),
  sender: one(users, { fields: [messages.senderId], references: [users.id] }),
  replyTo: one(messages, {
    fields: [messages.replyToId],
    references: [messages.id],
    relationName: 'replyTo',
  }),
  attachments: many(messageAttachments),
  reactions: many(messageReactions),
  mentions: many(messageMentions),
}));

export const messageAttachmentsRelations = relations(messageAttachments, ({ one }) => ({
  message: one(messages, { fields: [messageAttachments.messageId], references: [messages.id] }),
  media: one(media, { fields: [messageAttachments.mediaId], references: [media.id] }),
}));

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type MessageAttachment = typeof messageAttachments.$inferSelect;
export type Poll = typeof polls.$inferSelect;
export type LiveLocation = typeof liveLocations.$inferSelect;
