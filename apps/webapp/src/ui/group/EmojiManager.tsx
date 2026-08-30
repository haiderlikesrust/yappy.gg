import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import type { Conversation } from '../../lib/types';
import { Icon } from '../icons';
import { Glyph, errText, uploadMedia } from './groupKit';
import './group.css';

/**
 * The group's own emoji — anyone can browse, MANAGE_STICKERS curates.
 *
 * Wire shapes (apps/api/src/routes/emojis.ts):
 *   GET    /v1/conversations/:id/emojis           → { emojis: [{ id, name, animated, url }] }
 *   POST   /v1/conversations/:id/emojis           { name, mediaId } → 201 { emoji }
 *          name: /^[a-z0-9_]{2,32}$/; mediaId: your own confirmed image
 *          upload ≤512 KB (purpose 'emoji' — public bucket, see uploadMedia)
 *   DELETE /v1/conversations/:id/emojis/:emojiId  → { deleted }
 * Cap: 50 per group.
 */

interface EmojiInfo {
  id: string;
  name: string;
  animated: boolean;
  url: string;
}

const NAME_RE = /^[a-z0-9_]{2,32}$/;

export function EmojiManager(props: {
  conversation: Conversation;
  canManage: boolean;
  onClose: () => void;
}) {
  const { conversation, canManage, onClose } = props;
  const [emojis, setEmojis] = useState<EmojiInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await api<{ emojis: EmojiInfo[] }>(`/conversations/${conversation.id}/emojis`);
        if (!cancelled) setEmojis(res.emojis);
      } catch (err) {
        if (!cancelled) setError(errText(err, 'Could not load emoji'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversation.id]);

  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);

  const pick = (f: File): void => {
    setError(null);
    if (!f.type.startsWith('image/')) {
      setError('An emoji is an image');
      return;
    }
    if (f.size > 512 * 1024) {
      setError('Emoji images are capped at 512 KB');
      return;
    }
    if (preview) URL.revokeObjectURL(preview);
    setFile(f);
    setPreview(URL.createObjectURL(f));
    if (!name) {
      // Suggest a name from the filename, coerced into the allowed alphabet.
      const stem = (f.name.split('.')[0] ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 32);
      if (stem.length >= 2) setName(stem);
    }
  };

  const nameOk = NAME_RE.test(name);

  const create = async (): Promise<void> => {
    if (!file || !nameOk || busy) return;
    setBusy(true);
    setError(null);
    try {
      const media = await uploadMedia(file, 'emoji');
      const res = await api<{ emoji: EmojiInfo }>(`/conversations/${conversation.id}/emojis`, {
        method: 'POST',
        body: { name, mediaId: media.id },
      });
      setEmojis((list) =>
        [...list, res.emoji].sort((a, b) => a.name.localeCompare(b.name)),
      );
      setName('');
      setFile(null);
      if (preview) URL.revokeObjectURL(preview);
      setPreview(null);
    } catch (err) {
      setError(errText(err, 'Could not add that emoji'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (emoji: EmojiInfo): Promise<void> => {
    if (!window.confirm(`Delete :${emoji.name}:?`)) return;
    setError(null);
    try {
      await api<{ deleted: boolean }>(
        `/conversations/${conversation.id}/emojis/${emoji.id}`,
        { method: 'DELETE' },
      );
      setEmojis((list) => list.filter((e) => e.id !== emoji.id));
    } catch (err) {
      setError(errText(err, 'Could not delete that emoji'));
    }
  };

  return (
    <div className="grp-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="grp-modal gs-modal" role="dialog" aria-label="Group emoji">
        <div className="grp-modal-head">
          <div className="grp-modal-title">Group emoji</div>
          <button className="grp-close" onClick={onClose} aria-label="Close">
            <Icon name="close" size={18} />
          </button>
        </div>

        {error && <div className="grp-error">{error}</div>}

        <div className="gs-body">
          {canManage && (
            <div className="gs-row gs-col">
              <div className="gs-label">Add one</div>
              <div className="emoji-form">
                <button
                  className="emoji-drop"
                  onClick={() => fileRef.current?.click()}
                  aria-label="Choose an image"
                >
                  {preview ? (
                    <img src={preview} alt="" />
                  ) : (
                    <Glyph name="upload" size={18} />
                  )}
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = '';
                    if (f) pick(f);
                  }}
                />
                <div className="emoji-name-wrap">
                  <input
                    value={name}
                    maxLength={32}
                    placeholder="name_like_this"
                    onChange={(e) => setName(e.target.value.toLowerCase())}
                  />
                  <div className="inv-meta">
                    {name && !nameOk
                      ? 'Lowercase letters, digits and underscores (2–32)'
                      : 'Typed as :name: in chat'}
                  </div>
                </div>
                <button
                  className="gp-inline-save"
                  disabled={!file || !nameOk || busy}
                  onClick={() => void create()}
                >
                  {busy ? 'Adding…' : 'Add'}
                </button>
              </div>
            </div>
          )}

          {loading && <div className="grp-hint">Loading…</div>}
          {!loading && emojis.length === 0 && (
            <div className="grp-hint">
              No custom emoji yet{canManage ? ' — add the first one above.' : '.'}
            </div>
          )}
          <div className="emoji-grid">
            {emojis.map((emoji) => (
              <div key={emoji.id} className="emoji-cell" title={`:${emoji.name}:`}>
                <img src={emoji.url} alt={`:${emoji.name}:`} loading="lazy" />
                <span className="emoji-cell-name">:{emoji.name}:</span>
                {canManage && (
                  <button
                    className="emoji-delete"
                    onClick={() => void remove(emoji)}
                    aria-label={`Delete :${emoji.name}:`}
                  >
                    <Icon name="close" size={11} />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
