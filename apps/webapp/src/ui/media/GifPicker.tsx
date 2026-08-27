import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { Icon } from '../icons';
import { MediaIcon } from './mediaIcons';
import './media.css';

/**
 * Exactly the shape `sendMessageBody.gif` accepts (packages/shared/src/schemas.ts)
 * and what GET /gifs/search returns per result — pass a pick through untouched.
 */
export interface GifPayload {
  provider: 'tenor' | 'giphy';
  id: string;
  url: string;
  previewUrl: string;
  width: number;
  height: number;
  title?: string;
}

interface GifSearchResponse {
  results: GifPayload[];
  next: string | null;
  unavailable?: boolean;
}

type GifTab = 'search' | 'recent' | 'favorites';

const isMp4 = (url: string) => /\.mp4(\?|$)/.test(url);

function GifCell(props: { gif: GifPayload; onPick: (gif: GifPayload) => void }) {
  const { gif } = props;
  return (
    <button
      className="gifp-cell"
      onClick={() => props.onPick(gif)}
      aria-label={gif.title || 'GIF'}
      style={{ aspectRatio: gif.width && gif.height ? `${gif.width} / ${gif.height}` : '4 / 3' }}
    >
      {isMp4(gif.previewUrl) ? (
        <video src={gif.previewUrl} muted loop autoPlay playsInline />
      ) : (
        <img src={gif.previewUrl} alt={gif.title ?? ''} loading="lazy" />
      )}
    </button>
  );
}

/**
 * Popover GIF panel. Positioning is the caller's job — render it inside a
 * `position: relative` wrapper next to the composer button. Esc and a click
 * outside both call `onClose`; a pick calls `onPick` with the payload the
 * send endpoint's `gif` field wants (and records it to /gifs/recent).
 */
export function GifPicker(props: { onPick: (gif: GifPayload) => void; onClose: () => void }) {
  const [tab, setTab] = useState<GifTab>('search');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GifPayload[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [recent, setRecent] = useState<GifPayload[] | null>(null);
  const [favorites, setFavorites] = useState<GifPayload[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestSeq = useRef(0);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Close on any pointer press outside the panel.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) props.onClose();
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [props.onClose]);

  // Debounced search. An empty query is valid — the server returns trending.
  useEffect(() => {
    if (tab !== 'search') return;
    const seq = ++requestSeq.current;
    setLoading(true);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const res = await api<GifSearchResponse>(
            `/gifs/search?q=${encodeURIComponent(query.trim())}&limit=30`,
          );
          if (requestSeq.current !== seq) return;
          setResults(res.results);
          setNext(res.next);
          setUnavailable(Boolean(res.unavailable));
        } catch {
          if (requestSeq.current === seq) setUnavailable(true);
        } finally {
          if (requestSeq.current === seq) setLoading(false);
        }
      })();
    }, 350);
    return () => clearTimeout(timer);
  }, [query, tab]);

  useEffect(() => {
    if (tab === 'recent' && recent === null) {
      void api<{ results: GifPayload[] }>('/gifs/recent')
        .then((res) => setRecent(res.results))
        .catch(() => setRecent([]));
    }
    if (tab === 'favorites' && favorites === null) {
      void api<{ results: GifPayload[] }>('/gifs/favorites')
        .then((res) => setFavorites(res.results))
        .catch(() => setFavorites([]));
    }
  }, [tab, recent, favorites]);

  const loadMore = async () => {
    if (!next || loading) return;
    setLoading(true);
    const seq = ++requestSeq.current;
    try {
      const res = await api<GifSearchResponse>(
        `/gifs/search?q=${encodeURIComponent(query.trim())}&limit=30&pos=${encodeURIComponent(next)}`,
      );
      if (requestSeq.current !== seq) return;
      setResults((prev) => [...prev, ...res.results]);
      setNext(res.next);
    } catch {
      /* the button stays; a retry is a second click */
    } finally {
      if (requestSeq.current === seq) setLoading(false);
    }
  };

  const pick = (gif: GifPayload) => {
    // Record for the recent tab; fire-and-forget on purpose.
    void api('/gifs/recent', { method: 'POST', body: gif }).catch(() => {});
    props.onPick({ ...gif, title: gif.title ? gif.title.slice(0, 256) : undefined });
  };

  const list = tab === 'search' ? results : tab === 'recent' ? (recent ?? []) : (favorites ?? []);
  const pending = tab === 'search' ? loading : (tab === 'recent' ? recent : favorites) === null;

  return (
    <div
      ref={panelRef}
      className="media-popover gifp"
      role="dialog"
      aria-label="GIF picker"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          props.onClose();
        }
      }}
    >
      <div className="media-popover-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === 'search'}
          className={tab === 'search' ? 'active' : ''}
          onClick={() => setTab('search')}
        >
          <Icon name="search" size={15} /> Search
        </button>
        <button
          role="tab"
          aria-selected={tab === 'recent'}
          className={tab === 'recent' ? 'active' : ''}
          onClick={() => setTab('recent')}
        >
          <MediaIcon name="clock" size={15} /> Recent
        </button>
        <button
          role="tab"
          aria-selected={tab === 'favorites'}
          className={tab === 'favorites' ? 'active' : ''}
          onClick={() => setTab('favorites')}
        >
          <MediaIcon name="heart" size={15} /> Faves
        </button>
      </div>

      {tab === 'search' && (
        <div className="media-popover-search">
          <input
            ref={inputRef}
            type="search"
            placeholder="Search GIFs"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search GIFs"
          />
        </div>
      )}

      <div className="gifp-grid" role="listbox" aria-label="GIF results">
        {list.map((gif) => (
          <GifCell key={`${gif.provider}:${gif.id}`} gif={gif} onPick={pick} />
        ))}
      </div>

      {pending && <div className="media-popover-note">Loading…</div>}
      {!pending && list.length === 0 && (
        <div className="media-popover-note">
          {tab === 'search'
            ? unavailable
              ? 'GIFs are unavailable right now — try again in a moment'
              : 'Nothing found'
            : tab === 'recent'
              ? 'GIFs you send will show up here'
              : 'No favorites yet'}
        </div>
      )}
      {tab === 'search' && next && list.length > 0 && (
        <button className="gifp-more" onClick={() => void loadMore()} disabled={loading}>
          {loading ? 'Loading…' : 'More'}
        </button>
      )}
    </div>
  );
}
