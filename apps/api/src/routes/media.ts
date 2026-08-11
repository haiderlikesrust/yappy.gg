import { and, eq, isNull, media, sql as raw } from '@yappy/db';
import { AppError, ErrorCode, createUploadBody, newId, notFound, unprocessable } from '@yappy/shared';
import type { FastifyInstance } from 'fastify';
import { Storage } from '../lib/storage.js';
import { toMedia } from '../lib/serialize.js';

/**
 * Media upload, in three steps.
 *
 *   POST /media/uploads      → row in `pending`, plus a presigned PUT
 *   PUT  <presigned url>     → client uploads directly to S3/R2
 *   POST /media/:id/confirm  → we HEAD the object, mark it ready, queue work
 *
 * The confirm step is not ceremony: without it, a client that crashes mid-
 * upload leaves an object nothing references, and a message could be sent
 * pointing at bytes that never arrived. The sweeper deletes anything that stays
 * unconfirmed for an hour.
 */
export async function mediaRoutes(app: FastifyInstance) {
  app.post('/uploads', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const body = createUploadBody.parse(req.body);
    await app.limiter.consume(`user:${req.user.id}`, 'media.upload');

    const validated = Storage.validate(body.mimeType, body.size);
    if (!validated.ok) {
      throw new AppError(
        body.size > 0 ? 413 : 415,
        body.size > 0 ? ErrorCode.PayloadTooLarge : ErrorCode.UnsupportedMediaType,
        validated.reason,
      );
    }

    /**
     * Content-addressed dedupe: the same file uploaded again reuses the stored
     * object. Popular memes get sent thousands of times.
     *
     * Only within the same bucket, and that is not a detail. Purposes are split
     * across a public bucket and a private one — an avatar or a banner is served
     * straight from storage, an attachment goes through an authorised route. So
     * reusing a private object for a public purpose produced a row whose URL was
     * built as public and whose bytes were not: a banner someone had previously
     * sent as an attachment saved successfully, returned a URL, and 404'd.
     *
     * Which looked exactly like the upload failing, except everything reported
     * success. Matching the bucket makes the dedupe re-upload in that case,
     * which is the correct answer — the same bytes genuinely do need to exist in
     * both places when they are readable under different rules.
     */
    const targetBucket = Storage.bucketFor(body.purpose);
    if (body.checksum) {
      const [existing] = await app.db
        .select()
        .from(media)
        .where(
          and(
            eq(media.checksum, body.checksum),
            eq(media.status, 'ready'),
            eq(media.bucket, targetBucket),
            isNull(media.deletedAt),
          ),
        )
        .limit(1);

      if (existing) {
        const [copy] = await app.db
          .insert(media)
          .values({
            id: newId(),
            ownerId: req.user.id,
            purpose: body.purpose,
            status: 'ready',
            bucket: existing.bucket,
            objectKey: existing.objectKey,
            mimeType: existing.mimeType,
            size: existing.size,
            filename: body.filename,
            width: existing.width,
            height: existing.height,
            durationMs: existing.durationMs,
            blurhash: existing.blurhash,
            waveform: existing.waveform,
            thumbnailKey: existing.thumbnailKey,
            variants: existing.variants,
            checksum: body.checksum,
            confirmedAt: new Date(),
          })
          .returning();

        return reply.send({ media: toMedia(copy!), upload: null, deduplicated: true });
      }
    }

    const presigned = await app.storage.presignUpload({
      purpose: body.purpose,
      ownerId: req.user.id,
      mimeType: body.mimeType,
      size: body.size,
      checksum: body.checksum,
    });

    const [row] = await app.db
      .insert(media)
      .values({
        id: newId(),
        ownerId: req.user.id,
        purpose: body.purpose,
        status: 'pending',
        bucket: presigned.bucket,
        objectKey: presigned.objectKey,
        mimeType: body.mimeType,
        size: body.size,
        filename: body.filename,
        width: body.width ?? null,
        height: body.height ?? null,
        durationMs: body.durationMs ?? null,
        blurhash: body.blurhash ?? null,
        waveform: body.waveform ?? null,
        checksum: body.checksum ?? null,
      })
      .returning();

    return reply.status(201).send({
      media: toMedia(row!),
      upload: {
        url: presigned.uploadUrl,
        method: 'PUT',
        headers: presigned.headers,
        expiresIn: presigned.expiresIn,
      },
      deduplicated: false,
    });
  });

  app.post('/:id/confirm', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };

    const [row] = await app.db
      .select()
      .from(media)
      .where(and(eq(media.id, id), eq(media.ownerId, req.user.id), isNull(media.deletedAt)))
      .limit(1);
    if (!row) throw notFound('Upload');
    if (row.confirmedAt) return reply.send({ media: toMedia(row) });

    const head = await app.storage.head(row.bucket, row.objectKey);
    if (!head) throw unprocessable('The file was not uploaded');

    // Trust the bucket over the client's declared size.
    const [updated] = await app.db
      .update(media)
      .set({
        confirmedAt: new Date(),
        size: head.size,
        status: 'processing',
      })
      .where(eq(media.id, id))
      .returning();

    // Thumbnails, transcodes, blurhash, waveform, safety scan.
    await app.enqueue('media.process', { mediaId: id });

    return reply.send({ media: toMedia(updated!) });
  });

  /**
   * The bytes of a private object, for viewers allowed to see them.
   *
   * "Allowed" is: you uploaded it, or it is attached to a message in a
   * conversation you are still a member of and that you can see history for.
   * That last clause matters — a member added yesterday must not be able to
   * fetch last year's photos by guessing media ids.
   */
  app.get('/:id/content', { preHandler: app.authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string };

    const [row] = await app.db
      .select()
      .from(media)
      .where(and(eq(media.id, id), isNull(media.deletedAt)))
      .limit(1);
    if (!row) throw notFound('Media');

    if (row.ownerId !== req.user.id) {
      /**
       * Can this viewer see a message carrying it?
       *
       * Membership is resolved the way `loadMemberContext` resolves it, and
       * that is the whole point of the shape below. A channel's authority comes
       * from its *space*: someone who has never opened a particular channel
       * still reads as a member there, on a stand-in row that is never written.
       * This query used to demand a literal row for the conversation itself, so
       * a channel you could read perfectly well served none of its pictures —
       * the messages arrived and every attachment in them 404'd.
       *
       * The history floor still comes from their own row where one exists. A
       * stand-in member has no floor, which matches the rule that joining a
       * space shows you its channels from the beginning.
       */
      const allowed = (await app.db.execute(
        raw`select 1
              from message_attachments a
              join messages m on m.id = a.message_id
              join conversations c on c.id = m.conversation_id
              left join conversation_members own
                on own.conversation_id = c.id
               and own.user_id = ${req.user.id}::uuid
               and own.left_at is null
              left join conversation_members parent
                on c.parent_id is not null
               and parent.conversation_id = c.parent_id
               and parent.user_id = ${req.user.id}::uuid
               and parent.left_at is null
             where a.media_id = ${id}::uuid
               and (own.user_id is not null or parent.user_id is not null)
               and m.seq >= coalesce(own.history_start_seq, 0)
             limit 1`,
      )) as unknown as unknown[];
      // 404, not 403: whether a given media id exists is not public either.
      if (allowed.length === 0) throw notFound('Media');
    }

    const { variant } = req.query as { variant?: string };
    const key = variant === 'thumb' && row.thumbnailKey ? row.thumbnailKey : row.objectKey;

    const object = await app.storage.getObject(row.bucket, key);
    if (!object) throw notFound('Media');

    // Immutable: keys are content-addressed by random id and never rewritten.
    return reply
      .header('content-type', object.contentType)
      .header('cache-control', 'private, max-age=31536000, immutable')
      .send(object.body);
  });

  app.get('/:id', { preHandler: app.authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const [row] = await app.db
      .select()
      .from(media)
      .where(and(eq(media.id, id), isNull(media.deletedAt)))
      .limit(1);
    if (!row) throw notFound('Media');
    return reply.send({ media: toMedia(row) });
  });
}
