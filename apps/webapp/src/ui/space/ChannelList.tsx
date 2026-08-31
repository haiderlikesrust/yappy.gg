import { useEffect, useState, useSyncExternalStore } from 'react';
import { getState, mutate, prefetchConversation, useStore } from '../../state/store';
import type { Conversation } from '../../lib/types';
import { Avatar } from '../Avatar';
import { Icon } from '../icons';
import { joinVoice, voiceSession } from '../voice/voice';
import { CreateChannelModal } from './CreateChannelModal';
import { isCollapsed, onCollapseChange, toggleCollapsed } from './collapsed';
import {
  canManageSpace,
  categoriesOf,
  channelsOf,
  createCategory,
  deleteCategory,
  loadChannels,
  moveChannelToCategory,
  renameCategory,
  reorderChannels,
  type ChannelCategory,
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
 *
 * Categories group the list without being part of it. They arrive on the same
 * fetch as the channels, and a channel with no category is drawn *above* the
 * first divider rather than under a nameless one — #general belongs at the
 * top, not in "Uncategorised".
 */
export function ChannelList(props: {
  space: Conversation;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { space, selectedId, onSelect } = props;
  const { state } = useStore('conversations', 'voice');
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [reordering, setReordering] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);

  // Collapse state lives in localStorage, outside the store — it is a view
  // preference, not a fact about the space. See ./collapsed.
  useSyncExternalStore(onCollapseChange, () => localStorage.getItem('yappy.collapsedCategories'));

  useEffect(() => {
    let cancelled = false;
    if (channelsOf(getState().conversations, space.id).length > 0) {
      setPhase('ready');
      return;
    }
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
    }, 'conversations');
    void loadChannels(space.id);
  }, [changed, space.id]);

  const channels = channelsOf(state.conversations, space.id);
  const categories = categoriesOf(space.id);
  const canManage = canManageSpace(space);

  /**
   * Moving inside the flat list, which is still what the arrows mean: the
   * server takes one order for the whole space and the groups are drawn from
   * it, so a channel moved past a divider changes group by moving.
   */
  const move = (channelId: string, delta: number): void => {
    const next = channels.map((c) => c.id);
    const index = next.indexOf(channelId);
    const to = index + delta;
    if (index < 0 || to < 0 || to >= next.length) return;
    next.splice(to, 0, next.splice(index, 1)[0]!);
    void reorderChannels(space.id, next);
  };

  const renderChannel = (ch: SpaceConversation) => {
    // Voice: a place you drop into, not a timeline you open.
    if (ch.isVoice && !reordering) {
      const roster = state.voice.get(ch.id) ?? [];
      const connectedHere = voiceSession()?.channelId === ch.id;
      return (
        <div key={ch.id} className="sp-voice">
          <button
            className={`sp-chan voice${connectedHere ? ' connected' : ''}`}
            title={connectedHere ? 'Connected' : 'Join voice'}
            onClick={() => void joinVoice(ch.id)}
          >
            <span className="sp-chan-glyph">
              <Icon name="volume" size={15} />
            </span>
            <span className="sp-chan-title">{ch.title ?? 'voice'}</span>
            {roster.length > 0 && <span className="sp-voice-count">{roster.length}</span>}
          </button>
          {roster.length > 0 && (
            <div className="sp-voice-roster">
              {roster.map((p) => (
                <div key={p.id} className="sp-voice-person" title={p.displayName ?? p.username ?? ''}>
                  <Avatar
                    kind="person"
                    name={p.displayName ?? p.username ?? '?'}
                    url={p.avatarUrl}
                    size={20}
                  />
                  <span className="sp-voice-name">{p.displayName ?? p.username ?? 'someone'}</span>
                  {p.isMuted && <Icon name="mic-off" size={11} />}
                </div>
              ))}
            </div>
          )}
        </div>
      );
    }

    const silenced =
      ch.self?.notificationLevel === 'none' ||
      Boolean(ch.self?.mutedUntil && Date.parse(ch.self.mutedUntil) > Date.now());
    const unread = silenced ? 0 : (ch.self?.unreadCount ?? 0);
    const mentions = ch.self?.mentionCount ?? 0;
    const index = channels.findIndex((c) => c.id === ch.id);
    return (
      <button
        key={ch.id}
        className={`sp-chan${ch.id === selectedId ? ' selected' : ''}${unread > 0 ? ' unread' : ''}`}
        onClick={() => !reordering && onSelect(ch.id)}
        onPointerEnter={() => prefetchConversation(ch.id)}
        onFocus={() => prefetchConversation(ch.id)}
      >
        <span className="sp-chan-glyph">
          {ch.isBoard ? (
            <Icon name="pin" size={15} />
          ) : ch.isForum ? (
            <Icon name="forum" size={15} />
          ) : ch.isAnnouncement ? (
            <Icon name="megaphone" size={15} />
          ) : (
            <SpaceGlyph name="hash" size={15} />
          )}
        </span>
        <span className="sp-chan-title">{ch.title ?? 'channel'}</span>
        {/*
          * A lock, because "why can I see this and Sam cannot" is a question
          * the list should answer without being opened. It sits after the
          * name rather than replacing the kind glyph: a board, a forum and a
          * voice room can all be private too, and their own glyph is the more
          * useful of the two to keep.
          */}
        {ch.isPrivate && (
          <span className="sp-chan-lock" title="Only people admitted to this channel can see it">
            <Icon name="lock" size={11} />
          </span>
        )}
        {reordering ? (
          <>
            {categories.length > 0 && (
              /*
               * Filing, in the mode where the list is already being rearranged.
               * A select rather than a drag target: the sidebar is narrow, a
               * drop zone the width of a channel row is a poor one, and this
               * works from a keyboard.
               */
              <select
                className="sp-file"
                aria-label="Move to category"
                value={ch.categoryId ?? ''}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => {
                  e.stopPropagation();
                  void moveChannelToCategory(space.id, ch.id, e.target.value || null);
                }}
              >
                <option value="">No category</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
            <span
              className="sp-move"
              role="button"
              aria-label="Move up"
              aria-disabled={index === 0}
              onClick={(e) => {
                e.stopPropagation();
                if (index > 0) move(ch.id, -1);
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
                if (index < channels.length - 1) move(ch.id, 1);
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
  };

  const renderCategory = (category: ChannelCategory, inside: SpaceConversation[]) => {
    // Reordering is a whole-list operation, so folding away half of it while
    // rearranging would hide the thing being rearranged.
    const folded = isCollapsed(category.id) && !reordering;

    /*
     * Unread rolled up onto the header.
     *
     * Without this, folding a category hides the only signal that something in
     * it needs reading — the badge is *why* people scan a sidebar, and a
     * collapse that silently swallows it trains them not to collapse anything.
     */
    const hiddenUnread = folded
      ? inside.reduce((sum, ch) => {
          const silenced =
            ch.self?.notificationLevel === 'none' ||
            Boolean(ch.self?.mutedUntil && Date.parse(ch.self.mutedUntil) > Date.now());
          return sum + (silenced ? 0 : (ch.self?.unreadCount ?? 0));
        }, 0)
      : 0;
    const hiddenMentions = folded
      ? inside.reduce((sum, ch) => sum + (ch.self?.mentionCount ?? 0), 0)
      : 0;
    // A selected channel inside a folded category would otherwise vanish from
    // the sidebar while you are reading it.
    const holdsSelection = folded && inside.some((ch) => ch.id === selectedId);

    return (
      <div key={category.id} className="sp-cat">
        <div className="sp-cat-head">
          <button
            className="sp-cat-toggle"
            aria-expanded={!folded}
            onClick={() => toggleCollapsed(category.id)}
          >
            <span className={`sp-cat-chevron${folded ? '' : ' open'}`}>
              <Icon name="chevron-right" size={12} />
            </span>
            {renaming === category.id ? (
              <input
                className="sp-cat-input"
                autoFocus
                defaultValue={category.name}
                onClick={(e) => e.stopPropagation()}
                onBlur={(e) => {
                  const name = e.target.value.trim();
                  setRenaming(null);
                  if (name && name !== category.name) {
                    void renameCategory(space.id, category.id, name);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                  if (e.key === 'Escape') {
                    e.currentTarget.value = category.name;
                    e.currentTarget.blur();
                  }
                }}
              />
            ) : (
              <span className="sp-cat-name">{category.name}</span>
            )}
          </button>
          {hiddenMentions > 0 ? (
            <span className="sp-mention-badge">@{hiddenMentions > 99 ? '99+' : hiddenMentions}</span>
          ) : hiddenUnread > 0 ? (
            <span className="unread-badge">{hiddenUnread > 99 ? '99+' : hiddenUnread}</span>
          ) : null}
          {reordering && (
            <>
              <span
                className="sp-move"
                role="button"
                aria-label={`Rename ${category.name}`}
                onClick={() => setRenaming(category.id)}
              >
                <Icon name="edit" size={13} />
              </span>
              <span
                className="sp-move"
                role="button"
                aria-label={`Delete ${category.name}`}
                title="The channels inside stay — they move back to the top"
                onClick={() => void deleteCategory(space.id, category.id)}
              >
                <Icon name="trash" size={13} />
              </span>
            </>
          )}
        </div>
        {folded ? (
          holdsSelection ? (
            // Keep exactly the one you are in, so a fold never loses your place.
            inside.filter((ch) => ch.id === selectedId).map(renderChannel)
          ) : null
        ) : (
          <div className="sp-cat-body">{inside.map(renderChannel)}</div>
        )}
      </div>
    );
  };

  const loose = channels.filter((ch) => !ch.categoryId);
  // Only the categories with something in them, plus — for someone who can
  // manage the space — the empty ones they are about to fill. The server
  // already withholds categories a viewer can see nothing in.
  const grouped = categories
    .map((c) => ({ category: c, inside: channels.filter((ch) => ch.categoryId === c.id) }))
    .filter((g) => g.inside.length > 0 || canManage);

  return (
    <div className="sp-channels">
      {phase === 'loading' && channels.length === 0 && <div className="sp-state">Loading rooms…</div>}
      {phase === 'error' && channels.length === 0 && (
        <div className="sp-state error">Could not load the rooms</div>
      )}

      {loose.map(renderChannel)}
      {grouped.map((g) => renderCategory(g.category, g.inside))}

      {canManage && (
        <div className="sp-tools">
          <button className="sp-tool" onClick={() => setCreateOpen(true)}>
            <Icon name="plus" size={14} />
            Channel
          </button>
          {naming ? (
            <input
              className="sp-cat-input new"
              autoFocus
              placeholder="Category name"
              onBlur={(e) => {
                const name = e.target.value.trim();
                setNaming(false);
                if (name) void createCategory(space.id, name);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
                if (e.key === 'Escape') {
                  e.currentTarget.value = '';
                  e.currentTarget.blur();
                }
              }}
            />
          ) : (
            <button className="sp-tool" onClick={() => setNaming(true)}>
              <Icon name="plus" size={14} />
              Category
            </button>
          )}
          {(channels.length > 1 || categories.length > 0) && (
            <button className="sp-tool quiet" onClick={() => setReordering((v) => !v)}>
              {reordering ? 'Done' : 'Arrange'}
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
