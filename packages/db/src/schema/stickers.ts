import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { citext, createdAt, deletedAt, idCol, tsCol, updatedAt } from './_shared.js';
import { media } from './media.js';
import { users } from './users.js';

export const stickerPacks = pgTable(
  'sticker_packs',
  {
    id: idCol(),
    /** URL-safe, used for share links: yappy.gg/addstickers/<slug> */
    slug: citext('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    coverMediaId: uuid('cover_media_id').references(() => media.id, { onDelete: 'set null' }),

    /** Lottie/WebP-animated packs render differently on the client. */
    isAnimated: boolean('is_animated').notNull().default(false),
    isOfficial: boolean('is_official').notNull().default(false),
    /** Public packs appear in the store; private ones only via direct link. */
    isPublic: boolean('is_public').notNull().default(false),

    installCount: integer('install_count').notNull().default(0),
    stickerCount: integer('sticker_count').notNull().default(0),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    uniqueIndex('sticker_packs_slug_uq').on(t.slug),
    index('sticker_packs_store_idx')
      .on(t.installCount.desc())
      .where(sql`${t.isPublic} and ${t.deletedAt} is null`),
    index('sticker_packs_author_idx').on(t.authorId),
  ],
);

export const stickers = pgTable(
  'stickers',
  {
    id: idCol(),
    packId: uuid('pack_id')
      .notNull()
      .references(() => stickerPacks.id, { onDelete: 'cascade' }),
    mediaId: uuid('media_id')
      .notNull()
      .references(() => media.id, { onDelete: 'restrict' }),
    /** The emoji this sticker stands in for — drives emoji→sticker suggestions
     *  in the composer, which is how people actually find stickers. */
    emoji: text('emoji').notNull(),
    name: text('name'),
    position: smallint('position').notNull().default(0),
    createdAt: createdAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    index('stickers_pack_idx').on(t.packId, t.position),
    index('stickers_emoji_idx').on(t.emoji),
  ],
);

/** Packs a user has installed, in their chosen order. */
export const userStickerPacks = pgTable(
  'user_sticker_packs',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    packId: uuid('pack_id')
      .notNull()
      .references(() => stickerPacks.id, { onDelete: 'cascade' }),
    position: smallint('position').notNull().default(0),
    installedAt: tsCol('installed_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.packId] }),
    index('user_packs_order_idx').on(t.userId, t.position),
  ],
);

/**
 * Recently-used stickers, GIFs and emoji, so the picker opens on what you
 * actually send. Capped per user by the same upsert that writes it.
 */
export const recentItems = pgTable(
  'recent_items',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(), // sticker | gif | emoji
    /** Sticker uuid, `tenor:<id>`, or the emoji itself. */
    itemKey: text('item_key').notNull(),
    /** Enough to render the GIF picker offline without re-hitting Tenor. */
    payload: text('payload'),
    useCount: integer('use_count').notNull().default(1),
    lastUsedAt: tsCol('last_used_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.kind, t.itemKey] }),
    index('recent_items_lookup_idx').on(t.userId, t.kind, t.lastUsedAt.desc()),
  ],
);

/** Server-side favourites, synced across devices. */
export const favoriteGifs = pgTable(
  'favorite_gifs',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    providerId: text('provider_id').notNull(),
    url: text('url').notNull(),
    previewUrl: text('preview_url').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.provider, t.providerId] })],
);

export type StickerPack = typeof stickerPacks.$inferSelect;
export type Sticker = typeof stickers.$inferSelect;
