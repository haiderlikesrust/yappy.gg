import { useEffect, useState } from 'react';
import { auth } from './api';

/**
 * Private media through tags that cannot carry a header.
 *
 * Attachments and voice notes live in the private bucket and are served by
 * `/v1/media/:id/content` behind Bearer auth — which `<img>`, `<audio>` and
 * `<video>` have no way to send. Public-bucket URLs (avatars, stickers,
 * emoji) and external URLs (GIF providers) pass through untouched; API media
 * URLs are fetched with the token once and handed to the element as a blob
 * URL.
 *
 * The cache is session-lived and capped: a blob URL holds its bytes alive,
 * so evicted entries are revoked. Voice notes and chat images are small; the
 * cost of losing range-requests (a full download before playback) is the
 * accepted trade until signed CDN URLs exist server-side.
 */

const cache = new Map<string, string>(); // url → blob url (insertion-ordered)
const inflight = new Map<string, Promise<string | null>>();
const CACHE_MAX = 120;

function isPrivateMediaUrl(url: string): boolean {
  return url.includes('/v1/media/') && url.includes('/content');
}

async function fetchBlobUrl(url: string): Promise<string | null> {
  const token = auth.accessToken;
  if (!token) return null;
  try {
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    cache.set(url, blobUrl);
    if (cache.size > CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest) {
        URL.revokeObjectURL(cache.get(oldest)!);
        cache.delete(oldest);
      }
    }
    return blobUrl;
  } catch {
    return null;
  }
}

/** Resolve a media URL to something an element can load. Non-private URLs
 *  return as-is immediately; private ones resolve through the blob cache. */
export function resolveMediaUrl(url: string): string | Promise<string | null> {
  if (!isPrivateMediaUrl(url)) return url;
  const hit = cache.get(url);
  if (hit) return hit;
  let pending = inflight.get(url);
  if (!pending) {
    pending = fetchBlobUrl(url).finally(() => inflight.delete(url));
    inflight.set(url, pending);
  }
  return pending;
}

/**
 * Hook form: null while a private fetch is in flight (render a placeholder),
 * the loadable URL after. Non-private URLs are returned synchronously.
 */
export function useAuthedMedia(url: string | null | undefined): string | null {
  const [resolved, setResolved] = useState<string | null>(() => {
    if (!url) return null;
    const r = resolveMediaUrl(url);
    return typeof r === 'string' ? r : null;
  });

  useEffect(() => {
    if (!url) {
      setResolved(null);
      return;
    }
    const r = resolveMediaUrl(url);
    if (typeof r === 'string') {
      setResolved(r);
      return;
    }
    let alive = true;
    void r.then((blobUrl) => {
      if (alive) setResolved(blobUrl);
    });
    return () => {
      alive = false;
    };
  }, [url]);

  return resolved;
}
