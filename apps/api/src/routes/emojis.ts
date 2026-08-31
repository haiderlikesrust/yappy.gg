import { and, customEmojis, eq, inArray, isNull, media, sql as raw } from '@yappy/db';
import { Permission, conflict, createEmojiBody, newId, notFound, unprocessable } from '@yappy/shared';
import type { FastifyInstance } from 'fastify';
import { requireMember, requirePermission } from '../lib/access.js';
import { mediaUrl } from '../lib/serialize.js';

/** More than this and the picker becomes a search problem. Discord's tier-one
 *  cap, for the same reason. */
const MAX_EMOJIS_PER_CONVERSATION = 50;

/**
 * Custom emoji management.
 *
 * Gated on MANAGE_STICKERS rather than a new bit: emoji and stickers are the
 * same kind of asset — group-owned expression — and a role trusted with one
 * is trusted with the other. Inventing a bit per asset type is how permission
 * screens become airplane cockpits.
 */
export async function emojiRoutes(app: FastifyInstance) {
  /**
   * The emoji usable *here*.
   *
   * A channel's answer includes its space's, because that is where a space's
   * emoji live and every channel in it can use them. This used to return only
   * the exact conversation's own rows, which meant a channel always answered
   * with an empty list — the picker offered nothing and the composer could
   * not turn `:party_parrot:` into an entity, in the one kind of room most
   * people are actually typing in.
   *
   * It matters that this matches the scope the message hydrator resolves
   * against exactly. A picker offering an emoji the renderer will not resolve
   * is a shortcode that looks live and sends as text.
   */
  app.get('/:id/emojis', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const ctx = await requireMember(app.db, id, req.user.id);
    const scope = [id, ctx.conversation.parentId].filter((v): v is string => Boolean(v));

    const rows = await app.db
      .select({
        id: customEmojis.id,
        name: customEmojis.name,
        animated: customEmojis.animated,
        objectKey: media.objectKey,
      })
      .from(customEmojis)
      .innerJoin(media, eq(media.id, customEmojis.mediaId))
      .where(and(inArray(customEmojis.conversationId, scope), isNull(customEmojis.deletedAt)))
      .orderBy(customEmojis.name);

    return reply.send({
      emojis: rows.map((r) => ({
        id: r.id,
        name: r.name,
        animated: r.animated,
        url: mediaUrl(r.objectKey),
      })),
    });
  });

  app.post('/:id/emojis', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = createEmojiBody.parse(req.body);
    const ctx = await requirePermission(app.db, id, req.user.id, Permission.MANAGE_STICKERS);

    // Emoji belong to groups. A DM has no identity to express.
    if (ctx.conversation.type === 'dm') {
      throw unprocessable('Custom emoji live in groups and spaces');
    }

    const [upload] = await app.db
      .select()
      .from(media)
      .where(and(eq(media.id, body.mediaId), isNull(media.deletedAt)))
      .limit(1);

    // The uploader must be the caller: accepting any media id would let
    // someone attach another person's private upload to a public name.
    if (!upload || upload.ownerId !== req.user.id) throw notFound('Media');
    /*
     * `processing` counts. Demanding `ready` was a race nobody could win.
     *
     * `confirm` is what establishes everything this route actually depends
     * on: it HEADs the real object and records the size from storage rather
     * than the client's word for it. What `ready` adds on top is the
     * worker's thumbnail and scan stamp — neither of which an emoji uses.
     *
     * But `confirm` leaves the row at `processing`, and the client posts
     * here the instant it returns. So whenever the worker was a beat
     * behind — which is most of the time, since it is a queue — a perfectly
     * good upload came back "Upload has not completed", and retrying only
     * made another row that lost the same race. This was the only route in
     * the API that required `ready`, which is why nothing else ever broke.
     *
     * `pending` is still refused: the bytes may not be there at all.
     * `quarantined` and `failed` are refused because they are real answers.
     */
    if (upload.status !== 'ready' && upload.status !== 'processing') {
      throw unprocessable('Upload has not completed');
    }
    if (!upload.mimeType.startsWith('image/')) throw unprocessable('An emoji is an image');
    if (upload.size > 512 * 1024) throw unprocessable('Emoji images are capped at 512 KB');

    const countRows = (await app.db.execute(
      raw`select count(*)::int as n from custom_emojis
           where conversation_id = ${id}::uuid and deleted_at is null`,
    )) as unknown as Array<{ n: number }>;
    if ((countRows[0]?.n ?? 0) >= MAX_EMOJIS_PER_CONVERSATION) {
      throw unprocessable(`A group can have at most ${MAX_EMOJIS_PER_CONVERSATION} emoji`);
    }

    try {
      const [row] = await app.db
        .insert(customEmojis)
        .values({
          id: newId(),
          conversationId: id,
          name: body.name,
          mediaId: body.mediaId,
          animated: upload.mimeType === 'image/gif',
          createdById: req.user.id,
        })
        .returning();

      return reply.status(201).send({
        emoji: {
          id: row!.id,
          name: row!.name,
          animated: row!.animated,
          url: mediaUrl(upload.objectKey),
        },
      });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw conflict(`:${body.name}: already exists here`);
      }
      throw err;
    }
  });

  app.delete('/:id/emojis/:emojiId', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id, emojiId } = req.params as { id: string; emojiId: string };
    await requirePermission(app.db, id, req.user.id, Permission.MANAGE_STICKERS);

    const [row] = await app.db
      .update(customEmojis)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(customEmojis.id, emojiId),
          eq(customEmojis.conversationId, id),
          isNull(customEmojis.deletedAt),
        ),
      )
      .returning({ id: customEmojis.id });

    if (!row) throw notFound('Emoji');
    return reply.send({ deleted: true });
  });
}
