import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { Attachment, Conversation, Message } from '../../lib/types';
import { MediaViewer } from '../media';
import { Glyph, errText } from './groupKit';
import './group.css';

/**
 * The media wall — every image, video and GIF ever shared here, newest first.
 *
 * GET /v1/conversations/:id/media?limit&before (messages.ts:743) — the
 * first-class wall query the phones use (seq-cursored like history, same
 * visibility floor), not the per-type /gallery scan. Each row is a fully
 * hydrated message; we flatten to its visual attachments and synthesize one
 * for gif messages, which carry `gif.url` instead of attachments.
 */

interface WallItem {
  key: string;
  seq: number;
  attachment: Attachment;
  isVideo: boolean;
}

const PAGE = 42;

function itemsOf(msg: Message): WallItem[] {
  const visual = (msg.attachments ?? []).filter(
    (a) => a.mimeType.startsWith('image/') || a.mimeType.startsWith('video/'),
  );
  const items: WallItem[] = visual.map((a) => ({
    key: `${msg.id}:${a.id}`,
    seq: msg.seq,
    attachment: a,
    isVideo: a.mimeType.startsWith('video/'),
  }));
  if (msg.gif?.url) {
    items.push({
      key: `${msg.id}:gif`,
      seq: msg.seq,
      isVideo: false,
      attachment: {
        id: `${msg.id}-gif`,
        url: msg.gif.url,
        thumbnailUrl: null,
        mimeType: 'image/gif',
        width: msg.gif.width ?? null,
        height: msg.gif.height ?? null,
        filename: null,
      },
    });
  }
  return items;
}

export function MediaWall(props: { conversation: Conversation }) {
  const { conversation } = props;
  const [items, setItems] = useState<WallItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewer, setViewer] = useState<number | null>(null);

  const load = async (before: number | null, replace: boolean): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const qs = before !== null ? `&before=${before}` : '';
      const res = await api<{ messages: Message[]; hasMore: boolean }>(
        `/conversations/${conversation.id}/media?limit=${PAGE}${qs}`,
      );
      const fresh = res.messages.flatMap(itemsOf);
      setItems((prev) => (replace ? fresh : [...prev, ...fresh]));
      setHasMore(res.hasMore);
      const last = res.messages.at(-1);
      setCursor(last ? last.seq : null);
    } catch (err) {
      setError(errText(err, 'Could not load media'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setItems([]);
    setCursor(null);
    setViewer(null);
    void load(null, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation.id]);

  return (
    <div className="mw-wrap">
      {error && <div className="grp-error">{error}</div>}
      {!loading && !error && items.length === 0 && (
        <div className="grp-hint">
          <Glyph name="grid" size={22} style={{ display: 'block', margin: '0 auto 8px' }} />
          Nothing shared here yet. Photos and videos land on this wall.
        </div>
      )}

      <div className="mw-grid">
        {items.map((item, index) => (
          <button
            key={item.key}
            className="mw-tile"
            onClick={() => setViewer(index)}
            aria-label={item.attachment.filename ?? 'Open media'}
          >
            {item.isVideo ? (
              item.attachment.thumbnailUrl ? (
                <img src={item.attachment.thumbnailUrl} alt="" loading="lazy" decoding="async" />
              ) : (
                <video src={item.attachment.url} preload="metadata" muted />
              )
            ) : (
              <img
                src={item.attachment.thumbnailUrl ?? item.attachment.url}
                alt=""
                loading="lazy"
                decoding="async"
              />
            )}
            {item.isVideo && (
              <span className="mw-play">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                  <path d="M9 6.5v11l9-5.5-9-5.5Z" />
                </svg>
              </span>
            )}
          </button>
        ))}
      </div>

      {loading && <div className="grp-hint">Loading…</div>}
      {!loading && hasMore && cursor !== null && (
        <button className="gs-choice mw-more" onClick={() => void load(cursor, false)}>
          Load older
        </button>
      )}

      {viewer !== null && (
        <MediaViewer
          items={items.map((i) => i.attachment)}
          startIndex={viewer}
          onClose={() => setViewer(null)}
        />
      )}
    </div>
  );
}
