import { relations, sql } from 'drizzle-orm';
import {
  bigint,
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
import {
  conversationTypeEnum,
  createdAt,
  deletedAt,
  idCol,
  memberRoleEnum,
  notificationLevelEnum,
  tsCol,
  updatedAt,
} from './_shared.js';
import { users } from './users.js';

export const conversations = pgTable(
  'conversations',
  {
    id: idCol(),
    type: conversationTypeEnum('type').notNull(),

    title: text('title'),
    description: text('description'),
    avatarMediaId: uuid('avatar_media_id'),

    /**
     * The space this channel belongs to. Null for everything else.
     *
     * Self-referential and exactly one level deep — a channel's parent is
     * always a space, and a space never has one. Arbitrary nesting is a
     * tempting generalisation that buys nothing and makes every permission
     * question recursive.
     */
    parentId: uuid('parent_id'),
    /** Channel order within its space. Ties break on title. */
    position: integer('position').notNull().default(0),
    /**
     * A drop-in voice room. Only meaningful on channels: no timeline of its
     * own, no ringing — its "call" row is persistent and people come and go.
     */
    isVoice: boolean('is_voice').notNull().default(false),

    /**
     * A board: a channel that reads as a page rather than a conversation.
     *
     * Same messages, same permissions, same everything — what changes is that
     * the client draws them oldest-first as a stack of cards, and that a card
     * edited in place does not move. That last part is the whole point: a
     * board is where something lives, not where it scrolls past. A price that
     * rewrites itself every ten seconds belongs on one; in a chat it would be
     * either spam or invisible.
     *
     * Almost always paired with the announcement permission floor, so members
     * read and react but do not post. Not enforced together, because a small
     * team wanting a shared editable page is a reasonable thing to want.
     */
    isBoard: boolean('is_board').notNull().default(false),

    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),

    /**
     * Sorted "<userA>:<userB>" for DMs, null otherwise. The unique index on it
     * is what stops two people who tap "message" simultaneously from creating
     * two parallel DM threads.
     */
    dmKey: text('dm_key'),

    /**
     * Marks the handful of conversations the *system* needs to find by role
     * rather than by id: 'staff_space', 'staff_reports', 'staff_general'.
     * Null for everything a user created. Looking these up by title would
     * break the moment someone renames the space; a key cannot be renamed
     * from inside the product.
     */
    systemKey: text('system_key'),

    /**
     * Monotonic message counter. Allocated with
     *   UPDATE conversations SET message_seq = message_seq + 1 RETURNING message_seq
     * inside the send transaction, so the row lock serialises writers and the
     * sequence is gapless. This single column powers ordering, unread counts,
     * "jump to first unread", and delta sync.
     */
    messageSeq: bigint('message_seq', { mode: 'number' }).notNull().default(0),

    /** Denormalised for the conversation list — avoids a lateral join per row
     *  on the single hottest screen in the app. */
    lastMessageId: uuid('last_message_id'),
    lastMessageAt: tsCol('last_message_at'),
    lastMessagePreview: text('last_message_preview'),
    lastMessageSenderId: uuid('last_message_sender_id'),

    memberCount: integer('member_count').notNull().default(0),

    /** Conversation-wide permission floor, decimal-string bitfield. Null falls
     *  back to the per-type default in @yappy/shared. */
    basePermissions: bigint('base_permissions', { mode: 'bigint' }),

    /** 0 = off. Applied to new messages as `expires_at`. */
    disappearingSeconds: integer('disappearing_seconds').notNull().default(0),
    slowModeSeconds: integer('slow_mode_seconds').notNull().default(0),

    /**
     * How far back a *newly joined* member may read.
     *
     * `since_join` pins them to `message_seq` as it stood when they joined —
     * the historical behaviour, and still the default, because silently
     * exposing an existing group's backlog to everyone who joins later would
     * be a retroactive privacy change nobody asked for.
     *
     * `full` sets their floor to 0, which is what people actually expect of a
     * public group and are surprised not to get.
     *
     * Only consulted at join time: it writes `conversation_members.history_start_seq`
     * and every read path keeps filtering on that column, so flipping this
     * never re-opens history for members who already joined.
     */
    historyVisibility: text('history_visibility').notNull().default('since_join'),

    /** Discoverable + joinable by link without an invite. */
    isPublic: boolean('is_public').notNull().default(false),
    /** Set once a channel/group has an @handle for deep links. */
    handle: text('handle'),

    /**
     * `verified` | `partner` | `staff`, or null. A badged group is also the
     * only kind that may affiliate its members — see
     * `users.affiliationConversationId`.
     */
    badge: text('badge'),

    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),

    /**
     * A campfire: a place that burns down.
     *
     * Non-null makes this conversation temporary — at `endsAt` the sweeper
     * soft-deletes it and everything in it goes with it. Every other app makes
     * the room permanent and the messages disposable; inverting that is the
     * whole feature, because a room with a visible end changes how people talk
     * in it.
     *
     * A nullable timestamp rather than a new `type`: campfires are groups in
     * every other respect, and widening `conversation_type` would ripple through
     * the permission defaults, the list filter, the create guard and the delete
     * branch for no behavioural gain.
     */
    endsAt: tsCol('ends_at'),
    /**
     * When the "this ends soon" system message was posted. Exists only so the
     * sweeper is idempotent — it runs every minute, and the other sweepers get
     * their idempotency from the state change itself (`deleted_at`, `closed_at`)
     * where a warning has nothing to flip.
     */
    endsWarnedAt: tsCol('ends_warned_at'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    uniqueIndex('conversations_dm_key_uq').on(t.dmKey).where(sql`${t.dmKey} is not null`),
    uniqueIndex('conversations_handle_uq').on(t.handle).where(sql`${t.handle} is not null`),
    uniqueIndex('conversations_system_key_uq').on(t.systemKey).where(sql`${t.systemKey} is not null`),
    index('conversations_last_message_idx').on(t.lastMessageAt.desc()),
    /** The channel list for a space, in display order. */
    index('conversations_parent_idx')
      .on(t.parentId, t.position, t.title)
      .where(sql`${t.parentId} is not null and ${t.deletedAt} is null`),
    index('conversations_public_idx')
      .on(t.type, t.lastMessageAt.desc())
      .where(sql`${t.isPublic} and ${t.deletedAt} is null`),
    /** Campfires due to burn down, for the once-a-minute sweep. */
    index('conversations_ends_idx')
      .on(t.endsAt)
      .where(sql`${t.endsAt} is not null and ${t.deletedAt} is null`),
  ],
);

/**
 * Membership + all per-user, per-conversation state.
 *
 * Read state lives here as `lastReadSeq`, not as a row per (message, user).
 * That is the single most important scaling decision in the schema: per-message
 * receipts are O(members × messages) and will bury the database. Unread count
 * is `conversations.message_seq - last_read_seq`, computed at read time.
 */
export const conversationMembers = pgTable(
  'conversation_members',
  {
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    role: memberRoleEnum('role').notNull().default('member'),
    // `sql\`0\`` rather than the literal `0n`: drizzle-kit cannot serialise a
    // BigInt into its migration snapshot JSON.
    allow: bigint('allow', { mode: 'bigint' }).notNull().default(sql`0`),
    deny: bigint('deny', { mode: 'bigint' }).notNull().default(sql`0`),
    mutedUntil: tsCol('muted_until'),

    /** Per-group display name override ("Dad" instead of "@robert"). */
    nickname: text('nickname'),

    lastReadSeq: bigint('last_read_seq', { mode: 'number' }).notNull().default(0),
    lastReadAt: tsCol('last_read_at'),
    /** Highest seq confirmed delivered to at least one of this user's devices. */
    lastDeliveredSeq: bigint('last_delivered_seq', { mode: 'number' }).notNull().default(0),
    /** Kept in sync by trigger; lets the list screen badge mentions without a
     *  correlated subquery over the mentions table. */
    mentionCount: integer('mention_count').notNull().default(0),

    /**
     * Null means **inherit**, not "all".
     *
     * The distinction only became visible with channels, and it matters: a
     * channel row is created the first time you so much as post there, purely
     * to hold a read cursor. If that row carried a concrete `all`, the act of
     * posting would silently pin the channel to `all` and it would stop
     * following the space's setting — a preference the user never expressed,
     * recorded as though they had.
     *
     * So: a channel inherits its space, and anything else inherits the
     * account-level default in `users.notifications`. Only a deliberate choice
     * writes a value here.
     */
    notificationLevel: notificationLevelEnum('notification_level'),
    isPinned: boolean('is_pinned').notNull().default(false),
    isArchived: boolean('is_archived').notNull().default(false),

    /**
     * Out of the list entirely, for this member only.
     *
     * Archiving is tidying — the chat is still there, one tap away, and
     * everyone knows where. Hiding is for the other thing: handing someone
     * your unlocked phone. So it is enforced where every client reads its
     * list rather than drawn client-side, and the worker holds its
     * notifications, because a hidden chat that buzzes is not hidden.
     */
    isHidden: boolean('is_hidden').notNull().default(false),

    /** Cross-device draft sync — type on your phone, finish on the tablet. */
    draft: text('draft'),
    draftUpdatedAt: tsCol('draft_updated_at'),

    /** History visibility: members added later start here, so they cannot read
     *  what was said before they joined (unless the group allows it). */
    historyStartSeq: bigint('history_start_seq', { mode: 'number' }).notNull().default(0),

    /**
     * The group's half of an affiliation: "this person speaks for us." Says
     * nothing on its own — the member still has to choose to display it.
     */
    isAffiliate: boolean('is_affiliate').notNull().default(false),

    invitedById: uuid('invited_by_id').references(() => users.id, { onDelete: 'set null' }),
    joinedAt: tsCol('joined_at').notNull().defaultNow(),
    /** Set instead of deleting the row: keeps "X left the group" and lets a
     *  rejoin restore state. */
    leftAt: tsCol('left_at'),
  },
  (t) => [
    primaryKey({ columns: [t.conversationId, t.userId] }),
    /** The conversation-list query: my active conversations, newest first. */
    index('members_user_active_idx')
      .on(t.userId, t.isPinned.desc(), t.isArchived)
      .where(sql`${t.leftAt} is null`),
    index('members_conversation_idx').on(t.conversationId).where(sql`${t.leftAt} is null`),
    index('members_unread_idx').on(t.userId, t.lastReadSeq).where(sql`${t.leftAt} is null`),
  ],
);

/**
 * Named, colour-coded roles — "Maintainers", "Release captain", "Muted".
 *
 * These sit *alongside* the fixed owner/admin/moderator ladder rather than
 * replacing it, and the division is deliberate:
 *
 *   the ladder  decides who may act on whom  (authority over people)
 *   a role      decides what you may do      (capabilities)
 *
 * So a custom role can carry KICK_MEMBERS, and its holder still cannot kick an
 * admin, because `outranks` reads the ladder. Two competing hierarchies is how
 * permission systems grow holes — Discord's position-based model needs a great
 * deal of care precisely because rank and capability are the same number there.
 *
 * `position` is therefore *display* order: which role names a member in the
 * list, and whose colour their name takes. It confers nothing.
 */
export const conversationRoles = pgTable(
  'conversation_roles',
  {
    id: idCol(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),

    name: text('name').notNull(),
    /** #RRGGBB, or null to inherit the normal name colour. */
    color: text('color'),
    permissions: bigint('permissions', { mode: 'bigint' }).notNull().default(sql`0`),

    /** Higher sorts first. Ties break on name. */
    position: integer('position').notNull().default(0),
    /** Show holders as their own section in the member list. */
    isHoisted: boolean('is_hoisted').notNull().default(false),
    /** Allow @role to notify everyone holding it. */
    isMentionable: boolean('is_mentionable').notNull().default(false),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('roles_conversation_idx').on(t.conversationId, t.position.desc()),
    /** Two roles with the same name in one group is a support ticket. */
    uniqueIndex('roles_conversation_name_uq').on(t.conversationId, sql`lower(${t.name})`),
  ],
);

/**
 * Role assignments. `conversationId` is carried redundantly so the common
 * query — every role held in this conversation, for these members — is a
 * single indexed lookup rather than a join through the roles table.
 */
export const memberRoles = pgTable(
  'member_roles',
  {
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id')
      .notNull()
      .references(() => conversationRoles.id, { onDelete: 'cascade' }),
    assignedById: uuid('assigned_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.conversationId, t.userId, t.roleId] }),
    index('member_roles_role_idx').on(t.roleId),
  ],
);

/** Bans survive leaving and rejoining; kicks do not. */
export const conversationBans = pgTable(
  'conversation_bans',
  {
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    bannedById: uuid('banned_by_id').references(() => users.id, { onDelete: 'set null' }),
    reason: text('reason'),
    expiresAt: tsCol('expires_at'),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.conversationId, t.userId] })],
);

/**
 * The group pet.
 *
 * Every group has a creature whose wellbeing is the group's own activity,
 * reflected back at it. Feeding is not a button — a day of real conversation
 * (a handful of messages from more than one person) is a fed day. Streaks
 * grow it through stages; two silent weeks and it wanders off, taking the
 * streak with it. It comes back when the group does, because the point is a
 * pang, not a punishment.
 *
 * One row per group, created lazily by the daily cron. Mood is deliberately
 * NOT a column: it decays hour by hour and is derived at read time from
 * `conversations.last_message_at`, which the list query already carries — a
 * stored mood would need a sweeper to keep honest.
 */
export const groupPets = pgTable('group_pets', {
  conversationId: uuid('conversation_id')
    .primaryKey()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  /** What the group calls it. Null until someone names it. */
  name: text('name'),
  /** Total fed days — the growth clock. Stages are thresholds over this. */
  fedDays: integer('fed_days').notNull().default(0),
  /** Consecutive fed days. Reset by a missed day, zeroed by wandering off. */
  streak: integer('streak').notNull().default(0),
  /** The last day that counted as fed, as 'YYYY-MM-DD'. */
  lastFedOn: text('last_fed_on'),
  /** Set when two silent weeks pass; cleared the day the group feeds it again. */
  wanderedAt: tsCol('wandered_at'),
  bornAt: tsCol('born_at').notNull().defaultNow(),
});

export const conversationsRelations = relations(conversations, ({ many, one }) => ({
  members: many(conversationMembers),
  owner: one(users, { fields: [conversations.ownerId], references: [users.id] }),
}));

export const conversationMembersRelations = relations(conversationMembers, ({ one }) => ({
  conversation: one(conversations, {
    fields: [conversationMembers.conversationId],
    references: [conversations.id],
  }),
  user: one(users, { fields: [conversationMembers.userId], references: [users.id] }),
}));

export type ConversationRole = typeof conversationRoles.$inferSelect;
export type NewConversationRole = typeof conversationRoles.$inferInsert;
export type MemberRoleAssignment = typeof memberRoles.$inferSelect;

export type Conversation = typeof conversations.$inferSelect;
export type GroupPet = typeof groupPets.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;
export type ConversationMember = typeof conversationMembers.$inferSelect;
