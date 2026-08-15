import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { sql as raw, type Database } from '@yappy/db';
import type { Logger } from 'pino';
import { env } from '../env.js';

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
): Promise<{ title: string | null; description: string | null; siteName: string | null } | null> {
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
      };
    }

    if (!oe.title) return null;
    return {
      title: oe.title,
      description: oe.author_name ? `by ${oe.author_name}` : null,
      siteName: oe.provider_name ?? (host === 'open.spotify.com' ? 'Spotify' : 'YouTube'),
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
        await db.execute(
          raw`insert into link_previews (url_hash, url, title, description, site_name, fetched_at, expires_at, failed)
              values (${hash}, ${url}, ${oembed.title}, ${oembed.description}, ${oembed.siteName}, now(),
                      now() + make_interval(secs => ${CACHE_TTL_MS / 1000}), false)
              on conflict (url_hash) do update
                set title = excluded.title,
                    description = excluded.description,
                    site_name = excluded.site_name,
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

      await db.execute(
        raw`insert into link_previews (url_hash, url, title, description, site_name, fetched_at, expires_at, failed)
            values (${hash}, ${url}, ${meta.title}, ${meta.description}, ${meta.siteName}, now(),
                    now() + make_interval(secs => ${CACHE_TTL_MS / 1000}), false)
            on conflict (url_hash) do update
              set title = excluded.title,
                  description = excluded.description,
                  site_name = excluded.site_name,
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
