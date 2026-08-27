import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { Conversation } from '../../lib/types';
import { gateway, getState, mutate } from '../../state/store';
import { Icon } from '../icons';
import '../group/group.css';
import './space.css';

/**
 * Name a room, get a room. POST /conversations/:id/channels — the server
 * gates it on MANAGE_CONVERSATION, so this modal is only reachable through
 * affordances that already checked `canManageSpace`. The response is a full
 * conversation view; it goes straight into the store and gets selected.
 */
export function CreateChannelModal(props: {
  space: Conversation;
  onClose: () => void;
  /** Called with the new channel's id after it is in the store. */
  onCreated?: (id: string) => void;
}) {
  const { space, onClose, onCreated } = props;
  const [title, setTitle] = useState('');
  const [isAnnouncement, setIsAnnouncement] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const create = async (): Promise<void> => {
    const name = title.trim();
    if (!name || busy) return;
    setBusy(true);
    setError(null);
    try {
      // Append at the end: position is the current channel count.
      const count = [...getState().conversations.values()].filter(
        (c) => c.parentId === space.id,
      ).length;
      const res = await api<{ channel: Conversation }>(`/conversations/${space.id}/channels`, {
        method: 'POST',
        body: { title: name, position: count, isAnnouncement },
      });
      mutate((s) => {
        const existing = s.conversations.get(res.channel.id);
        s.conversations.set(
          res.channel.id,
          existing ? { ...existing, ...res.channel } : res.channel,
        );
      });
      // Same rule as every conversation born after IDENTIFY: subscribe by
      // hand or its messages never stream.
      gateway.subscribe(res.channel.id);
      onCreated?.(res.channel.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the channel');
      setBusy(false);
    }
  };

  return (
    <div className="grp-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="grp-modal" role="dialog" aria-label="New channel">
        <div className="grp-modal-head">
          <div className="grp-modal-title">New channel</div>
          <button className="grp-close" onClick={onClose} aria-label="Close">
            <Icon name="close" size={18} />
          </button>
        </div>

        {error && <div className="grp-error">{error}</div>}

        <div className="sp-modal-body">
          <input
            autoFocus
            value={title}
            placeholder="channel-name"
            maxLength={100}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void create()}
          />
          <button
            className={`sp-toggle${isAnnouncement ? ' on' : ''}`}
            aria-pressed={isAnnouncement}
            onClick={() => setIsAnnouncement((v) => !v)}
          >
            <Icon name="megaphone" size={14} />
            Announcements only
          </button>
          <button className="btn-accent" disabled={!title.trim() || busy} onClick={() => void create()}>
            {busy ? 'Creating…' : 'Create channel'}
          </button>
          <div className="grp-hint">
            {isAnnouncement
              ? 'Only people who can manage the space may post; everyone can read and react.'
              : 'Everyone in the space can talk here.'}
          </div>
        </div>
      </div>
    </div>
  );
}
