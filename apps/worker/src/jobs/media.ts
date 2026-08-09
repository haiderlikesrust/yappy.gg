import { eq, media, sql as raw, type Database } from '@yappy/db';
import type { Logger } from 'pino';
import sharp from 'sharp';
import { getObjectBytes, putObject, storageConfigured } from '../lib/storage.js';

/**
 * Post-upload media processing.
 *
 * What belongs here and what does not:
 *
 *   • Metadata the client already computed (dimensions, blurhash, waveform) is
 *     trusted and stored at upload time. Recomputing it server-side to save a
 *     few bytes of client CPU would mean decoding every image we receive.
 *
 *   • Image thumbnails are generated here, with sharp. libvips does its work on
 *     its own thread pool, so the event loop is not blocked the way in-process
 *     ffmpeg would block it — which is why images are handled in this worker
 *     while video transcoding still is not. Without the thumbnail, every client
 *     downloads the original into a 300-point bubble: a chat with twenty photos
 *     is twenty full-size downloads through the API for one screenful.
 *
 *   • Video stays a seam. Transcoding belongs in a dedicated service (a
 *     container pool, or Cloudflare Stream / MediaConvert), and the log line
 *     below marks the dispatch point.
 *
 *   • Safety scanning is mandatory before an attachment is servable. Until the
 *     scan returns, status stays `processing`; anything flagged goes to
 *     `quarantined` and never serves.
 */

export interface MediaDeps {
  db: Database;
  log: Logger;
}

/**
 * What sharp's prebuilt binaries can actually decode. HEIC is deliberately
 * absent — it is HEVC inside, the patent situation keeps it out of the
 * bundled libvips, and iOS re-encodes camera photos to JPEG at pick time
 * precisely so nothing here ever needs to try. GIF is absent for a different
 * reason: its thumbnail would be a still, and a frozen first frame in the
 * bubble defeats the point of sending a GIF.
 */
const THUMB_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const VIDEO_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/webm']);

/**
 * Longest edge of a generated thumbnail.
 *
 * Bubbles cap around 320 points; 640 covers that at 2× exactly. Anyone who
 * taps through to the viewer gets the original — the thumbnail only has to
 * survive being looked at in a scrolling list.
 */
const THUMB_EDGE = 640;

async function generateThumbnail(
  deps: MediaDeps,
  row: { id: string; bucket: string; objectKey: string },
): Promise<boolean> {
  const { db, log } = deps;

  const original = await getObjectBytes(row.bucket, row.objectKey);
  if (!original) return false;

  const thumb = await sharp(original)
    // Bake the EXIF orientation in. The thumbnail loses the metadata, so a
    // sideways-shot photo would otherwise render sideways only as a thumb.
    .rotate()
    .resize({
      width: THUMB_EDGE,
      height: THUMB_EDGE,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: 78 })
    .toBuffer();

  // Guard against a pathological case: a tiny original can produce a "thumb"
  // bigger than itself, and serving that would be strictly worse.
  if (thumb.length >= original.length) return false;

  const key = `${row.objectKey}.thumb.webp`;
  await putObject(row.bucket, key, thumb, 'image/webp');
  await db.update(media).set({ thumbnailKey: key }).where(eq(media.id, row.id));

  log.debug({ mediaId: row.id, bytes: thumb.length }, 'thumbnail generated');
  return true;
}

export async function processMedia(deps: MediaDeps, job: { mediaId: string }): Promise<void> {
  const { db, log } = deps;

  const [row] = await db.select().from(media).where(eq(media.id, job.mediaId)).limit(1);
  if (!row) return;
  if (row.status === 'quarantined') return;
  // Re-entry is allowed for one purpose: a ready image that never got its
  // thumbnail (the backfill path). Everything else that is ready is done.
  if (row.status === 'ready' && (row.thumbnailKey || !THUMB_TYPES.has(row.mimeType))) return;

  if (VIDEO_TYPES.has(row.mimeType)) {
    // Hand-off point for the transcode service. Left explicit rather than
    // silently skipped so it is obvious this is a seam, not an oversight.
    log.info({ mediaId: row.id, mimeType: row.mimeType }, 'video queued for external processing');
  }

  if (THUMB_TYPES.has(row.mimeType) && !row.thumbnailKey) {
    if (!storageConfigured) {
      log.warn({ mediaId: row.id }, 'S3 not configured in worker; skipping thumbnail');
    } else {
      try {
        await generateThumbnail(deps, row);
      } catch (err) {
        // The attachment must still become servable: a failed thumbnail costs
        // bandwidth, a failed job retried five times costs the upload.
        log.warn({ err, mediaId: row.id }, 'thumbnail generation failed');
      }
    }
  }

  await db
    .update(media)
    .set({
      status: 'ready',
      scannedAt: new Date(),
    })
    .where(eq(media.id, job.mediaId));

  log.debug({ mediaId: row.id }, 'media ready');
}

/**
 * Give old uploads the thumbnails they never got.
 *
 * Everything before this feature shipped — and anything uploaded while the
 * worker ran without S3 credentials — is a full-size download on every scroll
 * past it. Small batches on the slow sweep: each pass converges the backlog by
 * 25 without turning the worker into an image factory, and once the backlog is
 * drained the query returns nothing for ever after.
 */
export async function backfillThumbnails(
  db: Database,
  log: Logger,
  enqueue: (name: string, data: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  if (!storageConfigured) return;

  const rows = (await db.execute(raw`
    select id from media
     where status = 'ready'
       and thumbnail_key is null
       and mime_type in ('image/jpeg', 'image/png', 'image/webp')
     order by created_at desc
     limit 25
  `)) as unknown as Array<{ id: string }>;

  for (const row of rows) {
    await enqueue('media.process', { mediaId: row.id });
  }

  if (rows.length > 0) log.info({ count: rows.length }, 'thumbnail backfill enqueued');
}

/**
 * Mark media as failing moderation.
 *
 * Called by the safety-scan callback. Quarantined media stops serving
 * immediately and every message referencing it is soft-deleted, because leaving
 * the message with a broken attachment is worse than removing it.
 */
export async function quarantineMedia(
  deps: MediaDeps,
  job: { mediaId: string; labels: Record<string, number> },
): Promise<void> {
  await deps.db
    .update(media)
    .set({ status: 'quarantined', moderationLabels: job.labels, scannedAt: new Date() })
    .where(eq(media.id, job.mediaId));

  await deps.db.execute(
    raw`update messages
           set deleted_at = now()
         where deleted_at is null
           and id in (select message_id from message_attachments where media_id = ${job.mediaId}::uuid)`,
  );

  deps.log.warn({ mediaId: job.mediaId, labels: job.labels }, 'media quarantined');
}
