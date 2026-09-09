import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { media, sql as raw, type Database } from '@yappy/db';
import type { Logger } from 'pino';
import sharp from 'sharp';
import { env } from '../env.js';
import { putObject, storageConfigured } from '../lib/storage.js';

/**
 * Link previews.
 *
 * Fetched here rather than inline on send, for two reasons: it involves an
 * arbitrary third-party HTTP request (unbounded latency), and it is a
 * server-side request driven by user-supplied input — i.e. a textbook SSRF
 * vector. Everything below is about containing that.
 */

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const urlHash = (url: string) => createHash('sha256').update(url).digest('hex');

/**
 * Reject anything that resolves to a private range.
 *
 * Checking the hostname string is not enough: `http://internal.example.com`
 * can resolve to 169.254.169.254 and hand an attacker cloud instance
 * credentials. The DNS answer is what must be validated.
 */
async function isSafeUrl(raw_: string): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(raw_);
  } catch {
    return false;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;

  const host = url.hostname;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) return false;

  const addresses: string[] = [];
  if (isIP(host)) {
    addresses.push(host);
  } else {
    try {
      const resolved = await lookup(host, { all: true });
      addresses.push(...resolved.map((r) => r.address));
    } catch {
      return false;
    }
  }

  return addresses.every((addr) => !isPrivateAddress(addr));
}

function isPrivateAddress(addr: string): boolean {
  if (isIP(addr) === 6) {
    const lower = addr.toLowerCase();
    // An IPv4-mapped address (::ffff:169.254.169.254) is an IPv4 address
    // wearing a hat — unwrap and re-check, or the metadata endpoint walks
    // straight through this.
    if (lower.startsWith('::ffff:')) return isPrivateAddress(lower.slice(7));
    return (
      lower === '::1' ||
      lower === '::' ||
      lower.startsWith('fc') ||
      lower.startsWith('fd') ||
      lower.startsWith('fe80')
    );
  }

  const parts = addr.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true;
  const [a, b] = parts as [number, number, number, number];

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) || // link-local, incl. cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    a >= 224 // multicast and reserved
  );
}

function extractMeta(html: string) {
  const pick = (patterns: RegExp[]): string | null => {
    for (const re of patterns) {
      const match = re.exec(html);
      if (match?.[1]) return decodeEntities(match[1].trim()).slice(0, 500);
    }
    return null;
  };

  return {
    title:
      pick([
        /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
        /<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)["']/i,
        /<title[^>]*>([^<]+)<\/title>/i,
      ]) ?? null,
    description: pick([
      /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i,
    ]),
    siteName: pick([/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i]),
    image: pick([
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
    ]),
  };
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

const decodeEntities = (s: string) => s.replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITIES[m] ?? m);

/**
 * Providers whose pages scrape badly and whose oEmbed endpoints answer
 * plainly. X is the sharpest case: x.com serves an empty shell without
 * JavaScript, so tweet links never unfurled at all — the oEmbed endpoint is
 * the only honest way in. YouTube and Spotify scrape passably but oEmbed
 * gives cleaner titles and the author, keyless, in one small JSON fetch.
 * Anything that goes wrong here returns null and the generic scrape runs.
 */
async function providerOEmbed(
  url: string,
  log: Logger,
): Promise<{
  title: string | null;
  description: string | null;
  siteName: string | null;
  image: string | null;
  /** A better picture than `image` that may not exist; tried before it. */
  imageFirst?: string | null;
} | null> {
  let endpoint: string | null = null;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }

  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtu.be') {
    endpoint = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`;
  } else if (host === 'open.spotify.com') {
    endpoint = `https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`;
  } else if (
    (host === 'twitter.com' || host === 'x.com' || host === 'mobile.twitter.com') &&
    /\/status\/\d+/.test(url)
  ) {
    endpoint = `https://publish.twitter.com/oembed?omit_script=1&url=${encodeURIComponent(url)}`;
  }
  if (!endpoint) return null;

  try {
    const res = await fetch(endpoint, {
      headers: { 'user-agent': 'yappy-linkpreview/1.0 (+https://yappy.gg/bot)', accept: 'application/json' },
      signal: AbortSignal.timeout(env.LINK_PREVIEW_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const oe = (await res.json()) as {
      title?: string;
      author_name?: string;
      provider_name?: string;
      html?: string;
      thumbnail_url?: string;
    };

    // A tweet's oEmbed carries the text inside the blockquote's first <p>.
    if (host === 'twitter.com' || host === 'x.com' || host === 'mobile.twitter.com') {
      const text = oe.html
        ?.match(/<p[^>]*>([\s\S]*?)<\/p>/i)?.[1]
        ?.replace(/<br\s*\/?>/gi, '\n')
        ?.replace(/<[^>]+>/g, '')
        ?.replace(/&amp;/g, '&')
        ?.replace(/&lt;/g, '<')
        ?.replace(/&gt;/g, '>')
        ?.replace(/&quot;/g, '"')
        ?.replace(/&#39;/g, "'")
        ?.trim();
      if (!text && !oe.author_name) return null;
      return {
        title: oe.author_name ? `${oe.author_name} on X` : 'Post on X',
        description: text?.slice(0, 500) ?? null,
        siteName: 'X',
        image: null,
      };
    }

    if (!oe.title) return null;
    // YouTube's oEmbed hands back `hqdefault`, a 4:3 frame with the 16:9
    // picture letterboxed inside it — black bars on every card. The widescreen
    // original sits one filename over, so it is tried first; the fallback is
    // there because older uploads never got one.
    const ytId = oe.thumbnail_url?.match(/\/vi\/([\w-]{11})\//)?.[1];
    return {
      title: oe.title,
      description: oe.author_name ? `by ${oe.author_name}` : null,
      siteName: oe.provider_name ?? (host === 'open.spotify.com' ? 'Spotify' : 'YouTube'),
      image: oe.thumbnail_url ?? null,
      imageFirst: ytId ? `https://i.ytimg.com/vi/${ytId}/maxresdefault.jpg` : null,
    };
  } catch (err) {
    log.debug({ err, url }, 'oEmbed lookup failed; falling back to scrape');
    return null;
  }
}

export async function fetchLinkPreview(
  db: Database,
  log: Logger,
  job: { messageId: string; conversationId: string; urls: string[] },
  enqueue: (queue: string, data: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  for (const url of job.urls.slice(0, 3)) {
    const hash = urlHash(url);

    const cached = (await db.execute(
      raw`select url_hash, failed from link_previews
           where url_hash = ${hash} and expires_at > now()`,
    )) as unknown as Array<{ url_hash: string; failed: boolean }>;

    if (cached.length > 0) {
      /**
       * A preview somebody else already fetched still has to be announced.
       *
       * This branch attached it and stopped, so the row existed and nobody was
       * told: the card appeared only on the next fetch of the conversation,
       * which is to say after closing and reopening it. The first person to
       * paste a given link saw it appear live and everybody after them did
       * not, which is a strange enough shape that it reads as flaky rather
       * than broken.
       */
      if (!cached[0]!.failed && (await attach(db, job.messageId, hash))) {
        await enqueue('message.rehydrate', {
          messageId: job.messageId,
          conversationId: job.conversationId,
        });
      }
      continue;
    }

    if (!(await isSafeUrl(url))) {
      log.debug({ url }, 'link preview blocked');
      continue;
    }

    try {
      // Known providers answer better through oEmbed than through their HTML —
      // and X answers no other way at all. Success stores and announces the
      // same way the scrape path does; any failure falls through to it.
      const oembed = await providerOEmbed(url, log);
      if (oembed?.title) {
        const imageId =
          (await storePreviewImage(db, log, url, oembed.imageFirst ?? null)) ??
          (await storePreviewImage(db, log, url, oembed.image));
        await db.execute(
          raw`insert into link_previews (url_hash, url, title, description, site_name, image_media_id, fetched_at, expires_at, failed)
              values (${hash}, ${url}, ${oembed.title}, ${oembed.description}, ${oembed.siteName}, ${imageId}::uuid, now(),
                      now() + make_interval(secs => ${CACHE_TTL_MS / 1000}), false)
              on conflict (url_hash) do update
                set title = excluded.title,
                    description = excluded.description,
                    site_name = excluded.site_name,
                    image_media_id = coalesce(excluded.image_media_id, link_previews.image_media_id),
                    fetched_at = now(),
                    expires_at = excluded.expires_at,
                    failed = false`,
        );
        if (await attach(db, job.messageId, hash)) {
          await enqueue('message.rehydrate', {
            messageId: job.messageId,
            conversationId: job.conversationId,
          });
        }
        continue;
      }

      const res = await fetch(url, {
        redirect: 'follow',
        headers: {
          // Identify honestly and request only what we parse.
          'user-agent': 'yappy-linkpreview/1.0 (+https://yappy.gg/bot)',
          accept: 'text/html,application/xhtml+xml',
        },
        signal: AbortSignal.timeout(env.LINK_PREVIEW_TIMEOUT_MS),
      });

      if (!res.ok || !res.headers.get('content-type')?.includes('text/html')) {
        await markFailed(db, hash, url);
        continue;
      }

      // Read a bounded prefix. The metadata lives in <head>; streaming a 200 MB
      // "HTML" response to find it is exactly the DoS this guards against.
      const reader = res.body?.getReader();
      if (!reader) {
        await markFailed(db, hash, url);
        continue;
      }

      const chunks: Uint8Array[] = [];
      let received = 0;
      while (received < env.LINK_PREVIEW_MAX_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
      }
      await reader.cancel().catch(() => {});

      const html = Buffer.concat(chunks).toString('utf8');
      const meta = extractMeta(html);

      if (!meta.title) {
        await markFailed(db, hash, url);
        continue;
      }

      const imageId = await storePreviewImage(db, log, url, meta.image);
      await db.execute(
        raw`insert into link_previews (url_hash, url, title, description, site_name, image_media_id, fetched_at, expires_at, failed)
            values (${hash}, ${url}, ${meta.title}, ${meta.description}, ${meta.siteName}, ${imageId}::uuid, now(),
                    now() + make_interval(secs => ${CACHE_TTL_MS / 1000}), false)
            on conflict (url_hash) do update
              set title = excluded.title,
                  description = excluded.description,
                  site_name = excluded.site_name,
                  image_media_id = coalesce(excluded.image_media_id, link_previews.image_media_id),
                  fetched_at = now(),
                  expires_at = excluded.expires_at,
                  failed = false`,
      );

      const attached = await attach(db, job.messageId, hash);

      /**
       * Tell connected clients, by asking the API to say it properly.
       *
       * This used to publish `message.update` from here with a hand-built
       * `{ id, conversationId, preview }` body. Both clients decode that event
       * into a full `Message` and *replace* the one they are holding, so every
       * field absent from that payload — the text, the attachments, the seq —
       * came back as its default. Pasting a link blanked your own message until
       * you left the conversation and returned, which is exactly what was
       * being reported.
       *
       * The worker cannot fix that itself: a correct payload is a hydrated
       * message and hydration lives in `MessageService`. So it hands off, and
       * the API re-publishes the real thing. Old clients need no update for
       * this — they already handle a well-formed `message.update` correctly.
       */
      if (attached) {
        await enqueue('message.rehydrate', {
          messageId: job.messageId,
          conversationId: job.conversationId,
        });
      }
    } catch (err) {
      log.debug({ err, url }, 'link preview failed');
      await markFailed(db, hash, url);
    }
  }
}

/** A preview picture is a thumbnail, not an archive: wider than this is downscaled. */
const PREVIEW_IMAGE_MAX_EDGE = 1200;
const PREVIEW_IMAGE_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Fetch the page's picture and keep our own copy, or null.
 *
 * The scrape has always found `og:image`; until now it was read and then
 * dropped on the floor, which is why every pasted link was a grey text card
 * on all three clients. It is stored rather than hot-linked for the reasons
 * every messenger stores it: the client would otherwise fetch from an
 * arbitrary third party on every scroll (leaking each reader's IP to a site
 * one person pasted), the picture would rot when the page changed it, and a
 * 12 MB hero JPEG would be paid for by every phone in the group. One fetch
 * here, resized once, served from our bucket like an avatar.
 *
 * The same SSRF guard as the page fetch applies — an image URL is still a URL
 * somebody typed — plus a hard size cap and a decode through sharp, so a
 * "PNG" that is anything else never reaches a client.
 *
 * Best-effort throughout: a preview without a picture is a preview, and a
 * bad image must not cost the title that was already found.
 */
async function storePreviewImage(
  db: Database,
  log: Logger,
  pageUrl: string,
  imageUrl: string | null,
): Promise<string | null> {
  if (!imageUrl || !storageConfigured || !env.S3_BUCKET_PUBLIC) return null;

  let resolved: string;
  try {
    // `og:image` is allowed to be relative, and some sites do write it that way.
    resolved = new URL(imageUrl, pageUrl).toString();
  } catch {
    return null;
  }
  if (!(await isSafeUrl(resolved))) return null;

  try {
    const res = await fetch(resolved, {
      redirect: 'follow',
      headers: { 'user-agent': 'yappy-linkpreview/1.0 (+https://yappy.gg/bot)', accept: 'image/*' },
      signal: AbortSignal.timeout(env.LINK_PREVIEW_TIMEOUT_MS),
    });
    if (!res.ok || !res.headers.get('content-type')?.startsWith('image/')) return null;

    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > PREVIEW_IMAGE_MAX_BYTES) return null;

    const reader = res.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      // The header can lie; the body cannot.
      if (received > PREVIEW_IMAGE_MAX_BYTES) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }

    // One decode, one encode. webp because every client we ship decodes it
    // and it halves the JPEG most sites serve; the dimensions come from the
    // *output*, which is what the client lays out.
    const out = await sharp(Buffer.concat(chunks), { limitInputPixels: 40_000_000 })
      .rotate()
      .resize({ width: PREVIEW_IMAGE_MAX_EDGE, height: PREVIEW_IMAGE_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer({ resolveWithObject: true });
    // Too small to be a picture of anything — a tracking pixel or a 16px icon
    // dressed up as `og:image`. A card with that as its hero looks broken.
    if (out.info.width < 64 || out.info.height < 64) return null;

    const now = new Date();
    const key = `link_preview/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${String(
      now.getUTCDate(),
    ).padStart(2, '0')}/${randomBytes(16).toString('hex')}.webp`;
    await putObject(env.S3_BUCKET_PUBLIC, key, out.data, 'image/webp');

    const id = randomUUID();
    // Confirmed on insert: the orphan-upload sweep keys on `confirmed_at`, and
    // this was never a presigned upload waiting on a client. Ownerless, since
    // the picture belongs to the page, not to whoever pasted it first.
    await db.insert(media).values({
      id,
      ownerId: null,
      purpose: 'link_preview',
      status: 'ready',
      bucket: env.S3_BUCKET_PUBLIC,
      objectKey: key,
      mimeType: 'image/webp',
      size: out.data.length,
      width: out.info.width,
      height: out.info.height,
      confirmedAt: now,
    });
    return id;
  } catch (err) {
    log.debug({ err, url: resolved }, 'link preview image skipped');
    return null;
  }
}

/**
 * Link this preview to this message.
 *
 * Returns whether it was actually new. The caller republishes the message on
 * the strength of that, so a re-run of the same job — pg-boss retries, or two
 * URLs in one message resolving to the same preview — does not put the same
 * unchanged message on the wire twice.
 */
async function attach(db: Database, messageId: string, hash: string): Promise<boolean> {
  const inserted = (await db.execute(
    raw`insert into message_previews (message_id, url_hash)
        values (${messageId}::uuid, ${hash})
        on conflict do nothing
        returning message_id`,
  )) as unknown as Array<{ message_id: string }>;
  return inserted.length > 0;
}

/** Negative caching: a site that 404s must not be refetched on every mention. */
async function markFailed(db: Database, hash: string, url: string) {
  await db.execute(
    raw`insert into link_previews (url_hash, url, fetched_at, expires_at, failed)
        values (${hash}, ${url}, now(), now() + interval '6 hours', true)
        on conflict (url_hash) do update
          set fetched_at = now(), expires_at = excluded.expires_at, failed = true`,
  );
}
