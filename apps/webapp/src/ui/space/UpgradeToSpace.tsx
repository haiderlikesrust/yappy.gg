import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { Conversation } from '../../lib/types';
import { gateway, mutate, selectConversation } from '../../state/store';
import { Icon } from '../icons';
import { SpaceGlyph } from './spaceIcons';
import type { SpaceConversation } from './lib';
import '../group/group.css';
import './space.css';

/**
 * Turn a group into a space — the self-contained confirm-and-do modal, meant
 * to be mounted from the group panel (or anywhere that holds the group).
 *
 * What the server does (POST /conversations/:id/upgrade-to-space): the group
 * row *becomes* the space — same id, members, roles, invites — and the entire
 * history moves into a new first channel. Owner-only; the response carries
 * both views, which land in the store before the first channel is selected.
 */
export function UpgradeToSpace(props: { conversation: Conversation; onClose: () => void }) {
  const { conversation, onClose } = props;
  const [channelTitle, setChannelTitle] = useState('general');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isOwner = (conversation as SpaceConversation).self?.role === 'owner';

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const upgrade = async (): Promise<void> => {
    const firstChannelTitle = channelTitle.trim() || 'general';
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ space: Conversation; channel: Conversation }>(
        `/conversations/${conversation.id}/upgrade-to-space`,
        { method: 'POST', body: { firstChannelTitle } },
      );
      mutate((s) => {
        const oldGroup = s.conversations.get(res.space.id);
        // The response wins field-for-field: the group's timeline fields
        // (latestSeq, lastMessage) now describe the channel, not the space.
        s.conversations.set(res.space.id, oldGroup ? { ...oldGroup, ...res.space } : res.space);
        s.conversations.set(res.channel.id, res.channel);
        // The history moved rooms; anything cached under the group id shows
        // an empty space, so drop it and let the channel fetch fresh.
        s.messages.delete(res.space.id);
        s.historyLoaded.delete(res.space.id);
      });
      gateway.subscribe(res.channel.id);
      await selectConversation(res.channel.id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not upgrade the group');
      setBusy(false);
    }
  };

  return (
    <div className="grp-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="grp-modal" role="dialog" aria-label="Turn into a space">
        <div className="grp-modal-head">
          <div className="grp-modal-title">Turn into a space</div>
          <button className="grp-close" onClick={onClose} aria-label="Close">
            <Icon name="close" size={18} />
          </button>
        </div>

        {error && <div className="grp-error">{error}</div>}

        <div className="sp-modal-body">
          <div className="sp-blurb">
            A space is <strong>{conversation.title ?? 'this group'}</strong> with rooms: separate
            channels for separate conversations, one shared set of members and roles.
          </div>
          <div className="sp-points">
            <div className="sp-point">
              <SpaceGlyph name="hash" size={15} />
              <span>Everything said so far moves into the first channel — nothing is lost.</span>
            </div>
            <div className="sp-point">
              <Icon name="users" size={15} />
              <span>Members, roles and invite links carry over exactly as they are.</span>
            </div>
            <div className="sp-point">
              <Icon name="shield" size={15} />
              <span>This restructures the group for everyone, and there is no way back.</span>
            </div>
          </div>

          <div className="sp-field-label">First channel</div>
          <input
            value={channelTitle}
            placeholder="general"
            maxLength={100}
            onChange={(e) => setChannelTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void upgrade()}
          />

          {!isOwner && <div className="grp-error">Only the owner can turn a group into a space.</div>}

          <button className="btn-accent" disabled={busy || !isOwner} onClick={() => void upgrade()}>
            {busy ? 'Upgrading…' : 'Make it a space'}
          </button>
        </div>
      </div>
    </div>
  );
}
