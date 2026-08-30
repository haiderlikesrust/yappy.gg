import { memo, useMemo, useState } from 'react';

/**
 * Circles are people, squircles are places — the one rule of yappy iconography.
 *
 * Two speed tricks:
 *
 *  1. The worker writes a 640px WebP thumbnail beside every public image at a
 *     *derivable* key (`<objectKey>.thumb.webp` — see worker jobs/media.ts),
 *     but the serializer hands out the original. For a 42px circle the
 *     original is dead weight, so the component tries the thumb first and
 *     falls back on error — one failed probe per URL per session, remembered
 *     in `noThumb`. Private media (`/v1/media/...`) is never probed: its
 *     thumbs are not at a guessable URL.
 *  2. Images decode async and fade in over the initial-letter placeholder, so
 *     a cold cache shows identity instantly and the picture arrives as an
 *     upgrade rather than a pop-in.
 */

const noThumb = new Set<string>();

function thumbCandidate(url: string): string | null {
  if (!url.includes('/yappy-public/')) return null;
  if (url.endsWith('.thumb.webp')) return null;
  const candidate = `${url}.thumb.webp`;
  return noThumb.has(candidate) ? null : candidate;
}

export const Avatar = memo(function Avatar(props: {
  kind: 'person' | 'place';
  name: string | null | undefined;
  url?: string | null;
  size?: number;
}) {
  const size = props.size ?? 36;
  const initial = (props.name?.trim()?.[0] ?? '?').toUpperCase();
  const [loaded, setLoaded] = useState(false);
  const [fallback, setFallback] = useState(false);

  const src = useMemo(() => {
    if (!props.url) return null;
    if (!fallback) {
      const thumb = thumbCandidate(props.url);
      if (thumb) return thumb;
    }
    return props.url;
  }, [props.url, fallback]);

  return (
    <div
      className={`avatar ${props.kind}`}
      style={{ width: size, height: size, fontSize: size * 0.42 }}
      aria-hidden
    >
      {initial}
      {src && (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          onLoad={() => setLoaded(true)}
          onError={() => {
            if (src !== props.url) {
              noThumb.add(src);
              setFallback(true);
            }
          }}
          style={{
            position: 'absolute',
            inset: 0,
            opacity: loaded ? 1 : 0,
            transition: 'opacity 0.18s ease',
          }}
        />
      )}
    </div>
  );
});
