import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { Icon } from '../icons';
import { MediaIcon } from './mediaIcons';
import './media.css';

/** One sticker as GET /stickers/installed serialises it. */
export interface InstalledSticker {
  id: string;
  emoji: string | null;
  name: string | null;
  position: number;
  url: string;
}

/** One installed pack (subset of the server's toStickerPack output). */
export interface InstalledStickerPack {
  id: string;
  slug: string;
  name: string;
  coverUrl: string | null;
  isAnimated: boolean;
  stickerCount: number;
  stickers: InstalledSticker[];
}

/** What a pick hands back; `id` is the `stickerId` for sendMessageBody. */
export interface StickerPick {
  id: string;
  url: string;
  emoji?: string | null;
  name?: string | null;
}

interface RecentSticker {
  id: string;
  emoji: string | null;
  url: string;
}

/**
 * Popover sticker panel: recent strip plus one tab per installed pack.
 * Positioning is the caller's job (render inside a `position: relative`
 * wrapper). Esc / click-outside close; a pick calls `onPick` — send it as
 * `{ type: 'sticker', stickerId: pick.id }`.
 */
export function StickerPicker(props: { onPick: (sticker: StickerPick) => void; onClose: () => void }) {
  const [packs, setPacks] = useState<InstalledStickerPack[] | null>(null);
  const [recent, setRecent] = useState<RecentSticker[]>([]);
  const [tab, setTab] = useState<string>('recent'); // 'recent' | pack id
  const panelRef = useRef<HTMLDivElement>(null);
  const userChose = useRef(false);

  useEffect(() => {
    panelRef.current?.focus();
    void api<{ packs: InstalledStickerPack[] }>('/stickers/installed')
      .then((res) => setPacks(res.packs))
      .catch(() => setPacks([]));
    void api<{ stickers: RecentSticker[] }>('/stickers/recent')
      .then((res) => setRecent(res.stickers))
      .catch(() => {});
  }, []);

  // Recent is only a good landing tab when there is something in it; land on
  // the first pack otherwise. Never overrides a tab the user clicked.
  useEffect(() => {
    if (userChose.current || tab !== 'recent') return;
    if (packs && packs.length > 0 && recent.length === 0) setTab(packs[0]!.id);
  }, [packs, recent, tab]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) props.onClose();
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [props.onClose]);

  const activePack = packs?.find((p) => p.id === tab) ?? null;
  const showRecent = tab === 'recent';

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      className="media-popover stkp"
      role="dialog"
      aria-label="Sticker picker"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          props.onClose();
        }
      }}
    >
      <div className="media-popover-tabs stkp-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={showRecent}
          aria-label="Recently used"
          title="Recently used"
          className={showRecent ? 'active' : ''}
          onClick={() => {
            userChose.current = true;
            setTab('recent');
          }}
        >
          <MediaIcon name="clock" size={17} />
        </button>
        {(packs ?? []).map((pack) => (
          <button
            key={pack.id}
            role="tab"
            aria-selected={tab === pack.id}
            aria-label={pack.name}
            title={pack.name}
            className={`stkp-tab${tab === pack.id ? ' active' : ''}`}
            onClick={() => {
              userChose.current = true;
              setTab(pack.id);
            }}
          >
            {pack.coverUrl ? (
              <img src={pack.coverUrl} alt="" />
            ) : pack.stickers[0] ? (
              <img src={pack.stickers[0].url} alt="" />
            ) : (
              <Icon name="sticker" size={17} />
            )}
          </button>
        ))}
      </div>

      {packs === null ? (
        <div className="media-popover-note">Loading…</div>
      ) : packs.length === 0 && recent.length === 0 ? (
        <div className="media-popover-note">
          No sticker packs installed yet — find some in Explore
        </div>
      ) : showRecent ? (
        recent.length === 0 ? (
          <div className="media-popover-note">Stickers you send will show up here</div>
        ) : (
          <div className="stkp-grid" role="listbox" aria-label="Recent stickers">
            {recent.map((s) => (
              <button
                key={s.id}
                className="stkp-cell"
                onClick={() => props.onPick({ id: s.id, url: s.url, emoji: s.emoji })}
                aria-label={s.emoji ?? 'Sticker'}
              >
                <img src={s.url} alt={s.emoji ?? ''} loading="lazy" />
              </button>
            ))}
          </div>
        )
      ) : activePack ? (
        <>
          <div className="stkp-pack-name">{activePack.name}</div>
          <div className="stkp-grid" role="listbox" aria-label={`${activePack.name} stickers`}>
            {activePack.stickers.map((s) => (
              <button
                key={s.id}
                className="stkp-cell"
                onClick={() => props.onPick({ id: s.id, url: s.url, emoji: s.emoji, name: s.name })}
                aria-label={s.name ?? s.emoji ?? 'Sticker'}
                title={s.name ?? undefined}
              >
                <img src={s.url} alt={s.name ?? s.emoji ?? ''} loading="lazy" />
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
