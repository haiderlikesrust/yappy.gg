import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { Conversation } from '../../lib/types';
import { gateway, getState, mutate } from '../../state/store';
import { Icon } from '../icons';
import { categoriesOf } from './lib';
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
  const [isVoice, setIsVoice] = useState(false);
  const [isBoard, setIsBoard] = useState(false);
  const [isForum, setIsForum] = useState(false);
  const [categoryId, setCategoryId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const categories = categoriesOf(space.id);

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
        body: {
          title: name,
          position: count,
          isAnnouncement: isVoice ? false : isAnnouncement,
          isVoice,
          isBoard: isVoice ? false : isBoard,
          isForum: isVoice ? false : isForum,
          // Filed as it is made, so it never appears loose for one paint and
          // then jumps into a category on the next fetch.
          categoryId: categoryId || null,
        },
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
          {categories.length > 0 && (
            <select
              className="sp-select"
              aria-label="Category"
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
            >
              <option value="">No category</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
          <button
            className={`sp-toggle${isAnnouncement && !isVoice ? ' on' : ''}`}
            aria-pressed={isAnnouncement && !isVoice}
            onClick={() => {
              setIsAnnouncement((v) => !v);
              setIsVoice(false);
              setIsBoard(false);
            }}
          >
            <Icon name="megaphone" size={14} />
            Announcements only
          </button>
          <button
            className={`sp-toggle${isBoard && !isVoice ? ' on' : ''}`}
            aria-pressed={isBoard && !isVoice}
            onClick={() => {
              setIsBoard((v) => !v);
              setIsVoice(false);
              setIsForum(false);
              // A board is announcements with a different shape, so it brings the
              // floor with it rather than making somebody set two switches.
              setIsAnnouncement(false);
            }}
          >
            <Icon name="pin" size={14} />
            Board
          </button>
          <button
            className={`sp-toggle${isForum && !isVoice ? ' on' : ''}`}
            aria-pressed={isForum && !isVoice}
            onClick={() => {
              setIsForum((v) => !v);
              setIsVoice(false);
              setIsBoard(false);
              // Unlike a board, a forum wants everyone posting — that is what
              // it is for — so it does not bring the announcement floor.
              setIsAnnouncement(false);
            }}
          >
            <Icon name="forum" size={14} />
            Forum
          </button>
          <button
            className={`sp-toggle${isVoice ? ' on' : ''}`}
            aria-pressed={isVoice}
            onClick={() => {
              setIsVoice((v) => !v);
              setIsAnnouncement(false);
              setIsBoard(false);
            }}
          >
            <Icon name="volume" size={14} />
            Voice channel
          </button>
          <button className="btn-accent" disabled={!title.trim() || busy} onClick={() => void create()}>
            {busy ? 'Creating…' : 'Create channel'}
          </button>
          <div className="grp-hint">
            {isVoice
              ? 'A drop-in room. No messages — people click to talk and leave when they leave.'
              : isForum
                ? [
                    'A list of posts instead of a timeline. Each post has a title and its own',
                    'replies, and the ones people are still answering stay at the top.',
                  ].join(' ')
                : isBoard
                ? [
                    'A page rather than a chat. Cards stay where they are put, so a bot can',
                    'keep one updated — a price, a score, a countdown — without posting again.',
                  ].join(' ')
                : isAnnouncement
                  ? 'Only people who can manage the space may post; everyone can read and react.'
                  : 'Everyone in the space can talk here.'}
          </div>
        </div>
      </div>
    </div>
  );
}
