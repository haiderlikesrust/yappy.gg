import { sql } from 'drizzle-orm';
import { bigint, index, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, deletedAt, idCol, mediaStatusEnum, tsCol, updatedAt } from './_shared.js';
import { users } from './users.js';

/**
 * Every uploaded byte, from any surface, is one row here.
 *
 * Upload flow: client asks for a presigned PUT → uploads straight to S3/R2 →
 * confirms → a worker probes, transcodes and thumbnails. Bytes never transit
 * the API process, which is what keeps a 100 MB video from occupying a Node
 * event loop for thirty seconds.
 */
export const media = pgTable(
  'media',
  {
    id: idCol(),
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),

    purpose: text('purpose').notNull(), // attachment | avatar | conversation_avatar | sticker | banner | voice
    status: mediaStatusEnum('status').notNull().default('pending'),

    bucket: text('bucket').notNull(),
    objectKey: text('object_key').notNull(),
    mimeType: text('mime_type').notNull(),
    /** Bigint: a 4K video comfortably exceeds a 32-bit integer. */
    size: bigint('size', { mode: 'number' }).notNull().default(0),
    filename: text('filename'),

    width: integer('width'),
    height: integer('height'),
    durationMs: integer('duration_ms'),

    /** Compact placeholder rendered before the image loads. */
    blurhash: text('blurhash'),
    /** Normalised 0-100 buckets for voice-note waveforms. */
    waveform: jsonb('waveform').$type<number[]>(),

    thumbnailKey: text('thumbnail_key'),
    /** Ladder of transcoded renditions: [{ key, width, height, bitrate, codec }] */
    variants: jsonb('variants').$type<Array<Record<string, unknown>>>().notNull().default([]),

    /**
     * SHA-256 of the content. Two users sending the same meme reference one
     * object; the row is per-upload but the storage is shared.
     */
    checksum: text('checksum'),

    /** Set by the async safety scan. `quarantined` media never serves. */
    moderationLabels: jsonb('moderation_labels').$type<Record<string, number>>(),
    scannedAt: tsCol('scanned_at'),

    /** Uploads that are never confirmed get swept. */
    confirmedAt: tsCol('confirmed_at'),
    /** Reference counter — media is only really deletable at zero. */
    refCount: integer('ref_count').notNull().default(0),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    index('media_owner_idx').on(t.ownerId, t.createdAt.desc()),
    index('media_checksum_idx').on(t.checksum).where(sql`${t.checksum} is not null`),
    index('media_orphan_idx')
      .on(t.createdAt)
      .where(sql`${t.confirmedAt} is null`),
    index('media_gc_idx').on(t.refCount).where(sql`${t.refCount} = 0 and ${t.deletedAt} is null`),
  ],
);

export type Media = typeof media.$inferSelect;
export type NewMedia = typeof media.$inferInsert;
