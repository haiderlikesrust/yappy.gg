import { and, desc, eq, favoriteGifs, recentItems, sql as raw } from '@yappy/db';
import { gifSearchQuery, notFound } from '@yappy/shared';
import type { FastifyInstance } from 'fastify';
import { env } from '../env.js';

/**
 * GIF search, proxied.
 *
 * The provider key never reaches the client. Beyond the obvious (a key in an
 * APK is a public key), proxying lets us swap Tenor for Giphy without an app
 * release, apply our own content filter, cache hot queries, and keep the
 * provider from profiling our users directly.
 */

interface GifResult {
  id: string;
  provider: 'tenor' | 'giphy';
  url: string;
  previewUrl: string;
  width: number;
  height: number;
  title: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { at: number; results: GifResult[]; next: string | null }>();

async function searchTenor(q: string, limit: number, pos: string | undefined, locale: string, filter: string) {
  const url = new URL(q ? 'https://tenor.googleapis.com/v2/search' : 'https://tenor.googleapis.com/v2/featured');
  url.searchParams.set('key', env.TENOR_API_KEY);
  url.searchParams.set('client_key', 'yappy');
  if (q) url.searchParams.set('q', q);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('locale', locale);
  url.searchParams.set('contentfilter', filter);
  url.searchParams.set('media_filter', 'tinygif,gif,mp4');
  if (pos) url.searchParams.set('pos', pos);

  const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`tenor ${res.status}`);

  const data = (await res.json()) as {
    results: Array<{
      id: string;
      content_description: string;
      media_formats: Record<string, { url: string; dims: [number, number] }>;
    }>;
    next?: string;
  };

  return {
    results: data.results.flatMap<GifResult>((r) => {
      const full = r.media_formats.gif ?? r.media_formats.mp4;
      const preview = r.media_formats.tinygif ?? full;
      if (!full || !preview) return [];
      return [
        {
          id: r.id,
          provider: 'tenor' as const,
          url: full.url,
          previewUrl: preview.url,
          width: full.dims[0],
          height: full.dims[1],
          title: r.content_description ?? '',
        },
      ];
    }),
    next: data.next ?? null,
  };
}

async function searchGiphy(q: string, limit: number, pos: string | undefined, filter: string) {
  const endpoint = q ? 'search' : 'trending';
  const url = new URL(`https://api.giphy.com/v1/gifs/${endpoint}`);
  url.searchParams.set('api_key', env.GIPHY_API_KEY);
  if (q) url.searchParams.set('q', q);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('offset', pos ?? '0');
  url.searchParams.set('rating', filter === 'off' ? 'r' : filter === 'high' ? 'g' : 'pg-13');

  const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`giphy ${res.status}`);

  const data = (await res.json()) as {
    data: Array<{
      id: string;
      title: string;
      images: Record<string, { url: string; width: string; height: string }>;
    }>;
    pagination: { offset: number; count: number };
  };

  return {
    results: data.data.flatMap<GifResult>((g) => {
      const full = g.images.downsized ?? g.images.original;
      const preview = g.images.fixed_width_small ?? full;
      if (!full || !preview) return [];
      return [
        {
          id: g.id,
          provider: 'giphy' as const,
          url: full.url,
          previewUrl: preview.url,
          width: Number(full.width),
          height: Number(full.height),
          title: g.title,
        },
      ];
    }),
    next: String(data.pagination.offset + data.pagination.count),
  };
}

export async function gifRoutes(app: FastifyInstance) {
  app.get('/search', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const query = gifSearchQuery.parse(req.query);
    await app.limiter.consume(`user:${req.user.id}`, 'gif.search');

    const key = `${env.GIF_PROVIDER}|${query.q}|${query.limit}|${query.pos ?? ''}|${query.locale}|${query.contentFilter}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      return reply.send({ results: hit.results, next: hit.next, cached: true });
    }

    try {
      const result =
        env.GIF_PROVIDER === 'giphy'
          ? await searchGiphy(query.q, query.limit, query.pos, query.contentFilter)
          : await searchTenor(query.q, query.limit, query.pos, query.locale, query.contentFilter);

      if (cache.size > 500) cache.clear();
      cache.set(key, { at: Date.now(), ...result });

      return reply.send({ ...result, cached: false });
    } catch (err) {
      // A GIF provider outage must not look like our outage. Serve a stale
      // cache entry if we have one, otherwise an empty result the picker can
      // render as "try again".
      req.log.warn({ err }, 'gif provider failed');
      if (hit) return reply.send({ results: hit.results, next: hit.next, cached: true, stale: true });
      return reply.send({ results: [], next: null, cached: false, unavailable: true });
    }
  });

  /** Recently sent GIFs, so the picker opens on something useful. */
  app.get('/recent', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const rows = await app.db
      .select()
      .from(recentItems)
      .where(and(eq(recentItems.userId, req.user.id), eq(recentItems.kind, 'gif')))
      .orderBy(desc(recentItems.lastUsedAt))
      .limit(30);

    return reply.send({
      results: rows.flatMap((r) => {
        try {
          return [JSON.parse(r.payload ?? '{}') as GifResult];
        } catch {
          return [];
        }
      }),
    });
  });

  app.post('/recent', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const gif = req.body as GifResult;
    await app.db
      .insert(recentItems)
      .values({
        userId: req.user.id,
        kind: 'gif',
        itemKey: `${gif.provider}:${gif.id}`,
        payload: JSON.stringify(gif),
      })
      .onConflictDoUpdate({
        target: [recentItems.userId, recentItems.kind, recentItems.itemKey],
        set: { useCount: raw`${recentItems.useCount} + 1`, lastUsedAt: new Date() },
      });

    // Keep the list bounded — nobody scrolls past thirty.
    await app.db.execute(
      raw`delete from recent_items
           where user_id = ${req.user.id}::uuid and kind = 'gif'
             and item_key not in (
               select item_key from recent_items
                where user_id = ${req.user.id}::uuid and kind = 'gif'
                order by last_used_at desc limit 50
             )`,
    );

    return reply.send({ ok: true });
  });

  app.get('/favorites', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const rows = await app.db
      .select()
      .from(favoriteGifs)
      .where(eq(favoriteGifs.userId, req.user.id))
      .orderBy(desc(favoriteGifs.createdAt))
      .limit(200);

    return reply.send({
      results: rows.map((r) => ({
        id: r.providerId,
        provider: r.provider,
        url: r.url,
        previewUrl: r.previewUrl,
        width: r.width,
        height: r.height,
        title: '',
      })),
    });
  });

  app.put('/favorites', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const gif = req.body as GifResult;
    await app.db
      .insert(favoriteGifs)
      .values({
        userId: req.user.id,
        provider: gif.provider,
        providerId: gif.id,
        url: gif.url,
        previewUrl: gif.previewUrl,
        width: gif.width,
        height: gif.height,
      })
      .onConflictDoNothing();
    return reply.send({ favorited: true });
  });

  app.delete('/favorites/:provider/:id', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { provider, id } = req.params as { provider: string; id: string };
    const deleted = await app.db
      .delete(favoriteGifs)
      .where(
        and(
          eq(favoriteGifs.userId, req.user.id),
          eq(favoriteGifs.provider, provider),
          eq(favoriteGifs.providerId, id),
        ),
      )
      .returning({ providerId: favoriteGifs.providerId });
    if (deleted.length === 0) throw notFound('Favorite');
    return reply.send({ favorited: false });
  });
}
