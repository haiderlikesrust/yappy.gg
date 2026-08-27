import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { Icon } from '../icons';
import { Glyph, errText } from './groupKit';
import './group.css';

/**
 * The sticker store — browse public packs, peek inside, install.
 *
 * Wire shapes (apps/api/src/routes/stickers.ts, mounted at /v1/stickers):
 *   GET    /v1/stickers/store?q&limit&cursor  → { packs: [summary…], nextCursor }
 *          (popularity-ordered; cursor is the last pack's installCount)
 *   GET    /v1/stickers/packs/:idOrSlug       → { pack: full pack + stickers + isInstalled }
 *   POST   /v1/stickers/packs/:id/install     → { installed: true }
 *   DELETE /v1/stickers/packs/:id/install     → { installed: false }
 * Install caps at LIMITS.installedPacksMax server-side (409 past it).
 */

interface StorePack {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  coverUrl: string | null;
  isAnimated: boolean;
  isOfficial: boolean;
  stickerCount: number;
  installCount: number;
}

interface FullPack extends StorePack {
  isInstalled: boolean;
  stickers: Array<{ id: string; emoji: string; name: string | null; url: string }>;
}

export function StickerStore(props: { onClose: () => void }) {
  const { onClose } = props;
  const [packs, setPacks] = useState<StorePack[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<FullPack | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        if (open) setOpen(null);
        else onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, open]);

  // Debounced browse — the empty query is the popularity chart.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const q = query.trim();
        const res = await api<{ packs: StorePack[]; nextCursor: string | null }>(
          `/stickers/store?limit=30${q ? `&q=${encodeURIComponent(q)}` : ''}`,
        );
        if (cancelled) return;
        setPacks(res.packs);
        setNextCursor(res.nextCursor);
        setError(null);
      } catch (err) {
        if (!cancelled) setError(errText(err, 'Could not load the store'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, query ? 350 : 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const loadMore = async (): Promise<void> => {
    if (!nextCursor) return;
    try {
      const q = query.trim();
      const res = await api<{ packs: StorePack[]; nextCursor: string | null }>(
        `/stickers/store?limit=30&cursor=${encodeURIComponent(nextCursor)}${
          q ? `&q=${encodeURIComponent(q)}` : ''
        }`,
      );
      setPacks((list) => [...list, ...res.packs]);
      setNextCursor(res.nextCursor);
    } catch (err) {
      setError(errText(err, 'Could not load more packs'));
    }
  };

  const openPack = async (pack: StorePack): Promise<void> => {
    setError(null);
    try {
      const res = await api<{ pack: FullPack }>(`/stickers/packs/${pack.id}`);
      setOpen(res.pack);
    } catch (err) {
      setError(errText(err, 'Could not open that pack'));
    }
  };

  const setInstalled = async (pack: FullPack, install: boolean): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api<{ installed: boolean }>(`/stickers/packs/${pack.id}/install`, {
        method: install ? 'POST' : 'DELETE',
      });
      setOpen((p) => (p && p.id === pack.id ? { ...p, isInstalled: install } : p));
      setPacks((list) =>
        list.map((p) =>
          p.id === pack.id
            ? { ...p, installCount: Math.max(0, p.installCount + (install ? 1 : -1)) }
            : p,
        ),
      );
    } catch (err) {
      setError(errText(err, install ? 'Could not install that pack' : 'Could not remove that pack'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grp-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="grp-modal gs-modal" role="dialog" aria-label="Sticker store">
        <div className="grp-modal-head">
          {open ? (
            <button className="grp-close" onClick={() => setOpen(null)} aria-label="Back">
              <Icon name="chevron-left" size={18} />
            </button>
          ) : (
            <Glyph name="bag" size={18} style={{ color: 'var(--accent-soft)' }} />
          )}
          <div className="grp-modal-title">{open ? open.name : 'Sticker store'}</div>
          <button className="grp-close" onClick={onClose} aria-label="Close">
            <Icon name="close" size={18} />
          </button>
        </div>

        {error && <div className="grp-error">{error}</div>}

        {!open ? (
          <div className="gs-body">
            <input
              value={query}
              placeholder="Search packs"
              onChange={(e) => setQuery(e.target.value)}
            />
            {loading && <div className="grp-hint">Loading packs…</div>}
            {!loading && packs.length === 0 && (
              <div className="grp-hint">Nothing here{query.trim() ? ` for “${query.trim()}”` : ''}.</div>
            )}
            <div className="store-grid">
              {packs.map((pack) => (
                <button key={pack.id} className="store-card" onClick={() => void openPack(pack)}>
                  <div className="store-cover">
                    {pack.coverUrl ? (
                      <img src={pack.coverUrl} alt="" loading="lazy" />
                    ) : (
                      <Icon name="sticker" size={22} />
                    )}
                  </div>
                  <div className="store-card-name">
                    {pack.name}
                    {pack.isOfficial && (
                      <Icon name="check" size={11} style={{ color: 'var(--accent-soft)' }} />
                    )}
                  </div>
                  <div className="store-card-meta">
                    {pack.stickerCount} stickers — {pack.installCount} installs
                  </div>
                </button>
              ))}
            </div>
            {nextCursor && !loading && (
              <button className="gs-choice mw-more" onClick={() => void loadMore()}>
                More packs
              </button>
            )}
          </div>
        ) : (
          <div className="gs-body">
            {open.description && <div className="gs-sub">{open.description}</div>}
            <button
              className={open.isInstalled ? 'gs-choice' : 'btn-accent'}
              disabled={busy}
              onClick={() => void setInstalled(open, !open.isInstalled)}
            >
              {busy ? '…' : open.isInstalled ? 'Remove from my packs' : 'Install pack'}
            </button>
            <div className="store-stickers">
              {open.stickers.map((s) => (
                <div key={s.id} className="store-sticker" title={s.name ?? s.emoji}>
                  <img src={s.url} alt={s.name ?? s.emoji} loading="lazy" />
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
