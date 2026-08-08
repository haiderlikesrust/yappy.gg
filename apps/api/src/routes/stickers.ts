import {
  and,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  media,
  or,
  recentItems,
  sql as raw,
  stickerPacks,
  stickers,
  userStickerPacks,
} from '@yappy/db';
import {
  LIMITS,
  addStickerBody,
  conflict,
  createStickerPackBody,
  cursorPagination,
  forbidden,
  newId,
  notFound,
} from '@yappy/shared';
import type { FastifyInstance } from 'fastify';
import { toStickerPack } from '../lib/serialize.js';

/**
 * Stickers.
 *
 * Packs, not loose stickers, are the unit users install and share — a share
 * link installs a pack, and the picker is organised by pack. Each sticker
 * carries an emoji so the composer can suggest a sticker when someone types
 * "😂", which is how most sticker sends actually start.
 */
export async function stickerRoutes(app: FastifyInstance) {
  const loadPack = async (packId: string, viewerId: string) => {
    const [pack] = await app.db
      .select({ pack: stickerPacks, coverKey: media.objectKey })
      .from(stickerPacks)
      .leftJoin(media, eq(media.id, stickerPacks.coverMediaId))
      .where(and(eq(stickerPacks.id, packId), isNull(stickerPacks.deletedAt)))
      .limit(1);
    if (!pack) throw notFound('Sticker pack');

    const rows = await app.db
      .select({ sticker: stickers, mediaKey: media.objectKey })
      .from(stickers)
      .innerJoin(media, eq(media.id, stickers.mediaId))
      .where(and(eq(stickers.packId, packId), isNull(stickers.deletedAt)))
      .orderBy(stickers.position);

    const [installed] = await app.db
      .select({ packId: userStickerPacks.packId })
      .from(userStickerPacks)
      .where(and(eq(userStickerPacks.userId, viewerId), eq(userStickerPacks.packId, packId)))
      .limit(1);

    return toStickerPack(
      pack.pack,
      rows.map((r) => ({ ...r.sticker, mediaKey: r.mediaKey })),
      pack.coverKey,
      Boolean(installed),
    );
  };

  /** Packs the user has installed, in their order — the picker's source. */
  app.get('/installed', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const rows = await app.db
      .select({ pack: stickerPacks, coverKey: media.objectKey, position: userStickerPacks.position })
      .from(userStickerPacks)
      .innerJoin(stickerPacks, eq(stickerPacks.id, userStickerPacks.packId))
      .leftJoin(media, eq(media.id, stickerPacks.coverMediaId))
      .where(and(eq(userStickerPacks.userId, req.user.id), isNull(stickerPacks.deletedAt)))
      .orderBy(userStickerPacks.position);

    if (rows.length === 0) return reply.send({ packs: [] });

    // One query for every sticker across every installed pack, rather than one
    // per pack — the picker needs all of them at once anyway.
    const packIds = rows.map((r) => r.pack.id);
    const stickerRows = await app.db
      .select({ sticker: stickers, mediaKey: media.objectKey })
      .from(stickers)
      .innerJoin(media, eq(media.id, stickers.mediaId))
      .where(and(inArray(stickers.packId, packIds), isNull(stickers.deletedAt)))
      .orderBy(stickers.position);

    const byPack = new Map<string, Array<(typeof stickerRows)[number]>>();
    for (const s of stickerRows) {
      const list = byPack.get(s.sticker.packId) ?? [];
      list.push(s);
      byPack.set(s.sticker.packId, list);
    }

    return reply.send({
      packs: rows.map((r) =>
        toStickerPack(
          r.pack,
          (byPack.get(r.pack.id) ?? []).map((s) => ({ ...s.sticker, mediaKey: s.mediaKey })),
          r.coverKey,
          true,
        ),
      ),
    });
  });

  app.get('/store', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { limit, cursor } = cursorPagination.parse(req.query);
    const { q } = req.query as { q?: string };

    const rows = await app.db
      .select({ pack: stickerPacks, coverKey: media.objectKey })
      .from(stickerPacks)
      .leftJoin(media, eq(media.id, stickerPacks.coverMediaId))
      .where(
        and(
          eq(stickerPacks.isPublic, true),
          isNull(stickerPacks.deletedAt),
          q ? or(ilike(stickerPacks.name, `%${q}%`), ilike(stickerPacks.slug, `%${q}%`)) : undefined,
          cursor ? raw`${stickerPacks.installCount} < ${Number(cursor)}` : undefined,
        ),
      )
      .orderBy(desc(stickerPacks.installCount))
      .limit(limit);

    return reply.send({
      packs: rows.map((r) => ({
        id: r.pack.id,
        slug: r.pack.slug,
        name: r.pack.name,
        description: r.pack.description,
        coverUrl: r.coverKey ? `${process.env.S3_PUBLIC_BASE_URL}/${r.coverKey}` : null,
        isAnimated: r.pack.isAnimated,
        isOfficial: r.pack.isOfficial,
        stickerCount: r.pack.stickerCount,
        installCount: r.pack.installCount,
      })),
      nextCursor: rows.length === limit ? String(rows.at(-1)?.pack.installCount ?? 0) : null,
    });
  });

  app.get('/packs/:idOrSlug', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { idOrSlug } = req.params as { idOrSlug: string };
    const isUuid = /^[0-9a-f-]{36}$/i.test(idOrSlug);

    const [found] = await app.db
      .select({ id: stickerPacks.id })
      .from(stickerPacks)
      .where(
        and(
          isUuid ? eq(stickerPacks.id, idOrSlug) : eq(stickerPacks.slug, idOrSlug),
          isNull(stickerPacks.deletedAt),
        ),
      )
      .limit(1);
    if (!found) throw notFound('Sticker pack');

    return reply.send({ pack: await loadPack(found.id, req.user.id) });
  });

  app.post('/packs/:id/install', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };

    const countRows = (await app.db.execute(
      raw`select count(*)::int as count from user_sticker_packs where user_id = ${req.user.id}::uuid`,
    )) as unknown as Array<{ count: number }>;
    const count = countRows[0]?.count ?? 0;
    if (count >= LIMITS.installedPacksMax) throw conflict('You have installed too many packs');

    await app.db
      .insert(userStickerPacks)
      .values({ userId: req.user.id, packId: id, position: count })
      .onConflictDoNothing();

    await app.events.toUser(req.user.id, 'sticker_pack.update', { packId: id, installed: true });
    return reply.send({ installed: true });
  });

  app.delete('/packs/:id/install', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await app.db
      .delete(userStickerPacks)
      .where(and(eq(userStickerPacks.userId, req.user.id), eq(userStickerPacks.packId, id)));
    await app.events.toUser(req.user.id, 'sticker_pack.update', { packId: id, installed: false });
    return reply.send({ installed: false });
  });

  app.put('/packs/order', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { packIds } = req.body as { packIds: string[] };
    await app.db.transaction(async (tx) => {
      for (const [index, packId] of packIds.entries()) {
        await tx
          .update(userStickerPacks)
          .set({ position: index })
          .where(and(eq(userStickerPacks.userId, req.user.id), eq(userStickerPacks.packId, packId)));
      }
    });
    return reply.send({ ok: true });
  });

  /** Emoji → sticker suggestions, the main discovery path in the composer. */
  app.get('/suggest', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { emoji } = req.query as { emoji?: string };
    if (!emoji) return reply.send({ stickers: [] });

    const rows = await app.db
      .select({ sticker: stickers, mediaKey: media.objectKey, packName: stickerPacks.name })
      .from(stickers)
      .innerJoin(media, eq(media.id, stickers.mediaId))
      .innerJoin(stickerPacks, eq(stickerPacks.id, stickers.packId))
      .innerJoin(
        userStickerPacks,
        and(
          eq(userStickerPacks.packId, stickers.packId),
          eq(userStickerPacks.userId, req.user.id),
        ),
      )
      .where(and(eq(stickers.emoji, emoji), isNull(stickers.deletedAt)))
      .limit(24);

    return reply.send({
      stickers: rows.map((r) => ({
        id: r.sticker.id,
        emoji: r.sticker.emoji,
        packName: r.packName,
        url: `${process.env.S3_PUBLIC_BASE_URL}/${r.mediaKey}`,
      })),
    });
  });

  app.get('/recent', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const rows = await app.db
      .select({ sticker: stickers, mediaKey: media.objectKey, lastUsedAt: recentItems.lastUsedAt })
      .from(recentItems)
      .innerJoin(stickers, raw`${stickers.id}::text = ${recentItems.itemKey}`)
      .innerJoin(media, eq(media.id, stickers.mediaId))
      .where(and(eq(recentItems.userId, req.user.id), eq(recentItems.kind, 'sticker')))
      .orderBy(desc(recentItems.lastUsedAt))
      .limit(32);

    return reply.send({
      stickers: rows.map((r) => ({
        id: r.sticker.id,
        emoji: r.sticker.emoji,
        url: `${process.env.S3_PUBLIC_BASE_URL}/${r.mediaKey}`,
      })),
    });
  });

  // ── Authoring ─────────────────────────────────────────────────────────────

  app.post('/packs', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const body = createStickerPackBody.parse(req.body);
    try {
      const [pack] = await app.db
        .insert(stickerPacks)
        .values({
          id: newId(),
          slug: body.slug,
          name: body.name,
          authorId: req.user.id,
          coverMediaId: body.coverMediaId ?? null,
          isAnimated: body.isAnimated,
        })
        .returning();

      // The author gets it installed automatically — nobody makes a pack they
      // do not intend to use.
      await app.db
        .insert(userStickerPacks)
        .values({ userId: req.user.id, packId: pack!.id })
        .onConflictDoNothing();

      return reply.status(201).send({ pack: await loadPack(pack!.id, req.user.id) });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw conflict('That slug is taken');
      throw err;
    }
  });

  app.post('/packs/:id/stickers', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = addStickerBody.parse(req.body);

    const [pack] = await app.db
      .select()
      .from(stickerPacks)
      .where(and(eq(stickerPacks.id, id), isNull(stickerPacks.deletedAt)))
      .limit(1);
    if (!pack) throw notFound('Sticker pack');
    if (pack.authorId !== req.user.id) throw forbidden('You do not own this pack');
    if (pack.stickerCount >= LIMITS.stickersPerPack) throw conflict('This pack is full');

    const [sticker] = await app.db
      .insert(stickers)
      .values({
        id: newId(),
        packId: id,
        mediaId: body.mediaId,
        emoji: body.emoji,
        name: body.name ?? null,
        position: pack.stickerCount,
      })
      .returning();

    return reply.status(201).send({ stickerId: sticker!.id });
  });

  app.delete('/packs/:id/stickers/:stickerId', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { id, stickerId } = req.params as { id: string; stickerId: string };
    const [pack] = await app.db.select().from(stickerPacks).where(eq(stickerPacks.id, id)).limit(1);
    if (!pack) throw notFound('Sticker pack');
    if (pack.authorId !== req.user.id) throw forbidden('You do not own this pack');

    await app.db
      .update(stickers)
      .set({ deletedAt: new Date() })
      .where(and(eq(stickers.id, stickerId), eq(stickers.packId, id)));

    return reply.send({ deleted: true });
  });
}
