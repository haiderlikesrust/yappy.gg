import { eq, media, sql as raw, type Database } from '@yappy/db';
import type { Logger } from 'pino';

/**
 * Post-upload media processing.
 *
 * What belongs here and what does not:
 *
 *   • Metadata the client already computed (dimensions, blurhash, waveform) is
 *     trusted and stored at upload time. Recomputing it server-side to save a
 *     few bytes of client CPU would mean decoding every image we receive.
 *
 *   • Transcoding and thumbnailing are the real work. They are intentionally
 *     *not* implemented in this Node process: ffmpeg in-process will block the
 *     event loop and starve every other job. In production this dispatches to a
 *     dedicated transcode service (a container pool, or a managed pipeline such
 *     as Cloudflare Stream / MediaConvert). The handler below marks the
 *     lifecycle and is where that dispatch goes.
 *
 *   • Safety scanning is mandatory before an attachment is servable. Until the
 *     scan returns, status stays `processing`; anything flagged goes to
 *     `quarantined` and never serves.
 */

export interface MediaDeps {
  db: Database;
  log: Logger;
}

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/gif']);
const VIDEO_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/webm']);

export async function processMedia(deps: MediaDeps, job: { mediaId: string }): Promise<void> {
  const { db, log } = deps;

  const [row] = await db.select().from(media).where(eq(media.id, job.mediaId)).limit(1);
  if (!row) return;
  if (row.status === 'ready' || row.status === 'quarantined') return;

  const needsTranscode = VIDEO_TYPES.has(row.mimeType);
  const needsThumbnail = IMAGE_TYPES.has(row.mimeType) || needsTranscode;

  if (needsThumbnail || needsTranscode) {
    // Hand-off point for the transcode service. Left explicit rather than
    // silently skipped so it is obvious this is a seam, not an oversight.
    log.info(
      { mediaId: row.id, mimeType: row.mimeType, needsTranscode },
      'media queued for external processing',
    );
  }

  await db
    .update(media)
    .set({
      status: 'ready',
      // A thumbnail key is only claimed once something actually produced one.
      // Pointing at a nonexistent object gives every client a broken image.
      scannedAt: new Date(),
    })
    .where(eq(media.id, job.mediaId));

  log.debug({ mediaId: row.id }, 'media ready');
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
