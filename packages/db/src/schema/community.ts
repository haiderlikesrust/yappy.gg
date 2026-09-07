import {
  boolean,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, idCol, tsCol, updatedAt } from "./_shared.js";
import { users } from "./users.js";
import { conversations } from "./conversations.js";
import { messages, savedMessages } from "./messages.js";

export const communityEvents = pgTable(
  "community_events",
  {
    id: idCol(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    creatorId: uuid("creator_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    location: text("location").notNull().default(""),
    startsAt: tsCol("starts_at").notNull(),
    endsAt: tsCol("ends_at"),
    cancelledAt: tsCol("cancelled_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("community_events_room_time_idx").on(t.conversationId, t.startsAt),
  ],
);

export const eventResponses = pgTable(
  "community_event_responses",
  {
    eventId: uuid("event_id")
      .notNull()
      .references(() => communityEvents.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    response: text("response").notNull(),
    remind: boolean("remind").notNull().default(false),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.eventId, t.userId] })],
);

export const communityReminders = pgTable(
  "community_reminders",
  {
    id: idCol(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    messageId: uuid("message_id").references(() => messages.id, {
      onDelete: "cascade",
    }),
    eventId: uuid("event_id").references(() => communityEvents.id, {
      onDelete: "cascade",
    }),
    dueAt: tsCol("due_at").notNull(),
    deliveredAt: tsCol("delivered_at"),
    cancelledAt: tsCol("cancelled_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("community_reminders_due_idx").on(t.dueAt),
    index("community_reminders_owner_idx").on(t.userId, t.dueAt),
  ],
);

export const savedCollections = pgTable(
  "saved_collections",
  {
    id: idCol(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("saved_collections_owner_idx").on(t.userId)],
);

export const savedItemDetails = pgTable(
  "saved_item_details",
  {
    userId: uuid("user_id").notNull(),
    messageId: uuid("message_id").notNull(),
    collectionId: uuid("collection_id").references(() => savedCollections.id, {
      onDelete: "set null",
    }),
    note: text("note").notNull().default(""),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.messageId] }),
    foreignKey({
      columns: [t.userId, t.messageId],
      foreignColumns: [savedMessages.userId, savedMessages.messageId],
    }).onDelete("cascade"),
  ],
);

export const welcomeReads = pgTable(
  "community_welcome_reads",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    readAt: tsCol("read_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.conversationId] })],
);
