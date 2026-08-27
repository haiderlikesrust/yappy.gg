import { useState } from 'react';

/**
 * Circles are people, squircles are places — the one rule of yappy iconography.
 *
 * Images decode off the main thread and fade in over the initial-letter
 * placeholder, so a cold cache shows identity instantly (color + letter) and
 * the picture arrives as an upgrade rather than a pop-in.
 */
export function Avatar(props: {
  kind: 'person' | 'place';
  name: string | null | undefined;
  url?: string | null;
  size?: number;
}) {
  const size = props.size ?? 36;
  const initial = (props.name?.trim()?.[0] ?? '?').toUpperCase();
  const [loaded, setLoaded] = useState(false);
  return (
    <div
      className={`avatar ${props.kind}`}
      style={{ width: size, height: size, fontSize: size * 0.42 }}
      aria-hidden
    >
      {initial}
      {props.url && (
        <img
          src={props.url}
          alt=""
          loading="lazy"
          decoding="async"
          onLoad={() => setLoaded(true)}
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
}
