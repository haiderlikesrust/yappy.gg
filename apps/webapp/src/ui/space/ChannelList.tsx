import { useEffect, useState } from 'react';
import { mutate, useStore } from '../../state/store';
import type { Conversation } from '../../lib/types';
import { Icon } from '../icons';
import { CreateChannelModal } from './CreateChannelModal';
import {
  canManageSpace,
  channelsOf,
  loadChannels,
  reorderChannels,
  type SpaceConversation,
} from './lib';
import { SpaceGlyph } from './spaceIcons';
import './space.css';

/**
 * The rooms inside a space, rendered inside its sidebar card.
 *
 * Channels are fetched once per space (GET /conversations/:id/channels) and
 * folded into the store; from then on the list *derives* from
 * `state.conversations`, so a channel created live on another device appears
 * through the same ConversationCreate path as any other room. Broadcasts that
 * only say "the channel set changed" (`channelsChanged: true` merged onto the
 * space) trigger a refetch and are cleared.
 */
export function ChannelList(props: {
  space: Conversation;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { space, selectedId, onSelect } = props;
  const { state } = useStore();
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [reordering, setReordering] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setPhase('loading');
    loadChannels(space.id)
      .then(() => !cancelled && setPhase('ready'))
      .catch(() => !cancelled && setPhase('error'));
    return () => {
      cancelled = true;
    };
  }, [space.id]);

  // Create/reorder/delete/upgrade elsewhere arrive as a bare
  // ConversationUpdate {id, channelsChanged: true}; the store merges it onto
  // the space. Refetch, then clear the flag so the next change fires again.
  const changed = (space as SpaceConversation).channelsChanged === true;
  useEffect(() => {
    if (!changed) return;
    mutate((s) => {
      delete (s.conversations.get(space.id) as SpaceConversation | undefined)?.channelsChanged;
    });
    void loadChannels(space.id);
  }, [changed, space.id]);

  const channels = channelsOf(state.conversations, space.id);
  const canManage = canManageSpace(space);

  const move = (index: number, delta: number): void => {
    const next = channels.map((c) => c.id);
    const to = index + delta;
    if (to < 0 || to >= next.length) return;
    next.splice(to, 0, next.splice(index, 1)[0]!);
    void reorderChannels(space.id, next);
  };

  return (
    <div className="sp-channels">
      {phase === 'loading' && channels.length === 0 && <div className="sp-state">Loading rooms…</div>}
      {phase === 'error' && channels.length === 0 && (
        <div className="sp-state error">Could not load the rooms</div>
      )}

      {channels.map((ch, index) => {
        const silenced =
          ch.self?.notificationLevel === 'none' ||
          Boolean(ch.self?.mutedUntil && Date.parse(ch.self.mutedUntil) > Date.now());
        const unread = silenced ? 0 : (ch.self?.unreadCount ?? 0);
        const mentions = ch.self?.mentionCount ?? 0;
        return (
          <button
            key={ch.id}
            className={`sp-chan${ch.id === selectedId ? ' selected' : ''}${unread > 0 ? ' unread' : ''}`}
            onClick={() => !reordering && onSelect(ch.id)}
          >
            <span className="sp-chan-glyph">
              {ch.isAnnouncement ? (
                <Icon name="megaphone" size={15} />
              ) : (
                <SpaceGlyph name="hash" size={15} />
              )}
            </span>
            <span className="sp-chan-title">{ch.title ?? 'channel'}</span>
            {reordering ? (
              <>
                <span
                  className="sp-move"
                  role="button"
                  aria-label="Move up"
                  aria-disabled={index === 0}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (index > 0) move(index, -1);
                  }}
                >
                  <Icon name="chevron-right" size={14} style={{ transform: 'rotate(-90deg)' }} />
                </span>
                <span
                  className="sp-move"
                  role="button"
                  aria-label="Move down"
                  aria-disabled={index === channels.length - 1}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (index < channels.length - 1) move(index, 1);
                  }}
                >
                  <Icon name="chevron-right" size={14} style={{ transform: 'rotate(90deg)' }} />
                </span>
              </>
            ) : mentions > 0 ? (
              <span className="sp-mention-badge">@{mentions > 99 ? '99+' : mentions}</span>
            ) : unread > 0 ? (
              <span className="unread-badge">{unread > 99 ? '99+' : unread}</span>
            ) : null}
          </button>
        );
      })}

      {canManage && (
        <div className="sp-tools">
          <button className="sp-tool" onClick={() => setCreateOpen(true)}>
            <Icon name="plus" size={14} />
            New channel
          </button>
          {channels.length > 1 && (
            <button className="sp-tool quiet" onClick={() => setReordering((v) => !v)}>
              {reordering ? 'Done' : 'Reorder'}
            </button>
          )}
        </div>
      )}

      {createOpen && (
        <CreateChannelModal
          space={space}
          onClose={() => setCreateOpen(false)}
          onCreated={(id) => {
            setCreateOpen(false);
            onSelect(id);
          }}
        />
      )}
    </div>
  );
}
