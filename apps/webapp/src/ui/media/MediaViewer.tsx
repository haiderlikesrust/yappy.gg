import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { auth } from '../../lib/api';
import { useAuthedMedia } from '../../lib/authedMedia';
import type { Attachment } from '../../lib/types';
import { Icon } from '../icons';
import './media.css';

/**
 * Full-screen lightbox for a message's images and videos.
 *
 * Esc or a click on the scrim closes; arrow keys / chevrons move between the
 * attachments of the same message. The download anchor keeps a real href for
 * middle-click, but intercepts a plain click to fetch with the bearer token —
 * private media is served by GET /media/:id/content, which authorises per
 * viewer, and a bare cross-origin anchor can't carry the Authorization header.
 */
export function MediaViewer(props: { items: Attachment[]; startIndex?: number; onClose: () => void }) {
  const { items, onClose } = props;
  const [index, setIndex] = useState(() =>
    Math.min(Math.max(props.startIndex ?? 0, 0), Math.max(items.length - 1, 0)),
  );

  const prev = useCallback(() => setIndex((i) => Math.max(0, i - 1)), []);
  const next = useCallback(
    () => setIndex((i) => Math.min(items.length - 1, i + 1)),
    [items.length],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') prev();
      else if (e.key === 'ArrowRight') next();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, prev, next]);

  const current = items[index];
  // Private media resolves through the authed blob cache; hooks must run
  // unconditionally, so this sits above the null guard.
  const resolvedUrl = useAuthedMedia(current?.url ?? null);
  if (!current) return null;

  const download = async () => {
    try {
      const token = auth.accessToken;
      const res = await fetch(current.url, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`fetch failed (${res.status})`);
      const blob = await res.blob();
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href;
      a.download = current.filename ?? 'attachment';
      a.click();
      setTimeout(() => URL.revokeObjectURL(href), 30_000);
    } catch {
      // Last resort: let the browser try the URL directly (works when the
      // object is public or the proxy route accepts the session cookie).
      window.open(current.url, '_blank', 'noopener');
    }
  };

  const overlay = (
    <div
      className="mviewer-scrim"
      role="dialog"
      aria-modal="true"
      aria-label={current.filename ?? 'Media viewer'}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="mviewer-top">
        <span className="mviewer-name">{current.filename ?? ''}</span>
        {items.length > 1 && (
          <span className="mviewer-counter">
            {index + 1} / {items.length}
          </span>
        )}
        <a
          className="mviewer-btn"
          href={current.url}
          download={current.filename ?? 'attachment'}
          aria-label="Download"
          onClick={(e) => {
            e.preventDefault();
            void download();
          }}
        >
          <Icon name="download" size={18} />
        </a>
        <button className="mviewer-btn" onClick={onClose} aria-label="Close viewer">
          <Icon name="close" size={18} />
        </button>
      </div>

      {index > 0 && (
        <button className="mviewer-nav left" onClick={prev} aria-label="Previous attachment">
          <Icon name="chevron-left" size={22} />
        </button>
      )}
      {index < items.length - 1 && (
        <button className="mviewer-nav right" onClick={next} aria-label="Next attachment">
          <Icon name="chevron-right" size={22} />
        </button>
      )}

      <div
        className="mviewer-stage"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        {current.mimeType.startsWith('video/') ? (
          <video key={current.id} className="mviewer-media" src={resolvedUrl ?? undefined} controls autoPlay playsInline />
        ) : (
          <img key={current.id} className="mviewer-media" src={resolvedUrl ?? undefined} alt={current.filename ?? ''} />
        )}
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
}
