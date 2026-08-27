import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { Icon } from '../icons';
import {
  Snippet,
  formatWhen,
  senderName,
  type MessageHit,
  type MessageSearchResponse,
} from './shared';
import './search.css';

/**
 * In-conversation search: a compact panel the shell docks over the chat
 * (typically top-right). Same endpoint as the palette's Messages section but
 * scoped with conversationId; a click hands `seq` to the chat surface via
 * `onJump`, which is expected to loadAround and highlight.
 */
export function SearchInChat(props: {
  conversationId: string;
  onJump: (seq: number) => void;
  onClose: () => void;
}) {
  const { conversationId, onJump, onClose } = props;
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<MessageHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const term = query.trim();

  useEffect(() => {
    if (term.length < 2) {
      setHits([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const res = await api<MessageSearchResponse>(
          `/search/messages?q=${encodeURIComponent(term)}&conversationId=${conversationId}&limit=20`,
        );
        if (!cancelled) setHits(res.results ?? []);
      } catch {
        if (!cancelled) setHits([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [term, conversationId]);

  useEffect(() => setActive(0), [term]);
  useEffect(() => {
    if (active >= hits.length) setActive(Math.max(0, hits.length - 1));
  }, [hits.length, active]);
  useEffect(() => {
    listRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [active, hits.length]);

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (hits.length > 0) setActive((i) => (i + 1) % hits.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (hits.length > 0) setActive((i) => (i - 1 + hits.length) % hits.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const hit = hits[active];
      if (hit) onJump(hit.seq);
    }
  };

  return (
    <div className="sic-panel" role="search" onKeyDown={onKeyDown}>
      <div className="sic-inputrow">
        <Icon name="search" size={17} className="sic-inputicon" />
        <input
          autoFocus
          className="sic-input"
          value={query}
          placeholder="Search in this chat"
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search in conversation"
        />
        <button type="button" className="sic-close" onClick={onClose} aria-label="Close search">
          <Icon name="close" size={15} />
        </button>
      </div>

      {(hits.length > 0 || (term.length >= 2 && !searching)) && (
        <div className="sic-list" ref={listRef}>
          {hits.map((hit, i) => (
            <button
              key={hit.messageId}
              type="button"
              className={`sic-row ${i === active ? 'active' : ''}`}
              data-active={i === active || undefined}
              onMouseEnter={() => setActive(i)}
              onClick={() => onJump(hit.seq)}
            >
              <div className="sic-row-head">
                <span className="sic-row-sender">{senderName(hit)}</span>
                <span className="sic-row-time">{formatWhen(hit.createdAt)}</span>
              </div>
              <div className="sic-row-snippet">
                <Snippet text={hit.snippet} />
              </div>
            </button>
          ))}
          {hits.length === 0 && <div className="sic-empty">No matches here</div>}
        </div>
      )}
    </div>
  );
}
