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

export async function fetchLinkPreview(
  db: Database,
  log: Logger,
  job: { messageId: string; conversationId: string; urls: string[] },
): Promise<void> {
  for (const url of job.urls.slice(0, 3)) {
    const hash = urlHash(url);

    const cached = (await db.execute(
      raw`select url_hash, failed from link_previews
           where url_hash = ${hash} and expires_at > now()`,
    )) as unknown as Array<{ url_hash: string; failed: boolean }>;

    if (cached.length > 0) {
      if (!cached[0]!.failed) await attach(db, job.messageId, hash);
      continue;
    }

    if (!(await isSafeUrl(url))) {
      log.debug({ url }, 'link preview blocked');
      continue;
    }

    try {
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

      await attach(db, job.messageId, hash);

      // Tell connected clients so the card appears without a refresh.
      await db.execute(
        raw`select pg_notify(
              ${'c_' + job.conversationId.replace(/-/g, '')},
              ${JSON.stringify({
                v: 1,
                t: 'message.update',
                d: {
                  id: job.messageId,
                  conversationId: job.conversationId,
                  preview: { url, title: meta.title, description: meta.description, siteName: meta.siteName },
                },
              })}
            )`,
      );
    } catch (err) {
      log.debug({ err, url }, 'link preview failed');
      await markFailed(db, hash, url);
    }
  }
}

async function attach(db: Database, messageId: string, hash: string) {
  await db.execute(
    raw`insert into message_previews (message_id, url_hash)
        values (${messageId}::uuid, ${hash})
        on conflict do nothing`,
  );
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
