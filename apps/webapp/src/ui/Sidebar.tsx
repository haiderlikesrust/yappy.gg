import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import type { Conversation, Self } from '../lib/types';
import type { GatewayStatus } from '../lib/gateway';
import { loadConversations, mutate, prefetchConversation, syncUrl } from '../state/store';
import { Avatar } from './Avatar';
import { BadgeMark, IdentityMarks } from './badges';
import { PixelPet } from './group';
import { Icon } from './icons';
import { ChannelList, SpaceGlyph, isSpace, loadChannelsForSpaces } from './space';
import { VoiceDock } from './voice/VoiceDock';
import './space/space.css';

/*
 * Three panels that open on a click and never before it. The sidebar is on
 * the critical path — it is the first thing anybody sees — and none of these
 * has any business being downloaded with it.
 */
const NewChatModal = lazy(() =>
  import('./group/NewChatModal').then((m) => ({ default: m.NewChatModal })),
);
const MentionsInbox = lazy(() =>
  import('./chat/MentionsInbox').then((m) => ({ default: m.MentionsInbox })),
);
const SpaceOverview = lazy(() =>
  import('./space/SpaceOverview').then((m) => ({ default: m.SpaceOverview })),
);

/** Stable empty array — a fresh [] per render defeats every memo below it. */
const EMPTY_CHANNELS: Conversation[] = [];

function displayTitle(conv: Conversation, meId: string | undefined): string {
  if (conv.type === 'dm') {
    return conv.otherUser?.displayName ?? conv.otherUser?.username ?? conv.title ?? 'Direct message';
  }
  return conv.title ?? 'Unnamed place';
}

function preview(conv: Conversation, meId: string | undefined): string {
  const last = conv.lastMessage;
  const text = last?.content ?? last?.preview ?? conv.lastMessagePreview ?? '';
  if (!text) return '';
  const who =
    last?.sender?.displayName ??
    last?.sender?.username ??
    (last?.senderId && last.senderId === meId ? 'You' : null);
  return who ? `${who}: ${text}` : text;
}

function ago(iso: string | null): string {
  if (!iso) return '';
  const diff = Date.now() - Date.parse(iso);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'now';
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const STATUS_LABEL: Record<GatewayStatus, string> = {
  online: 'online',
  connecting: 'connecting…',
  reconnecting: 'reconnecting…',
  offline: 'offline',
};

/** Which space cards are open. Survives reloads — a layout choice, not state. */
const EXPANDED_KEY = 'yappy.sidebar.spacesOpen';

function readExpanded(): Set<string> {
  try {
    const raw = localStorage.getItem(EXPANDED_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function writeExpanded(ids: Set<string>): void {
  try {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify([...ids]));
  } catch {
    /* private mode — expansion just does not survive a reload */
  }
}

export function Sidebar(props: {
  me: Self | null;
  status: GatewayStatus;
  conversations: Conversation[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(readExpanded);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [archivedLoading, setArchivedLoading] = useState(false);
  const [overviewSpaceId, setOverviewSpaceId] = useState<string | null>(null);

  // Channels feed the card's counts, the voice rosters, and — via the home
  // sort — a space's place in the list. Fetch each space's once, up front,
  // rather than waiting for its card to be expanded.
  const channelsFetched = useRef(new Set<string>());
  const spaceIds = props.conversations
    .filter((c) => isSpace(c))
    .map((c) => c.id)
    .join(',');
  useEffect(() => {
    const ids = spaceIds.split(',').filter((id) => id && !channelsFetched.current.has(id));
    for (const id of ids) channelsFetched.current.add(id);
    if (ids.length === 0) return;
    void loadChannelsForSpaces(ids).catch(() => {
      for (const id of ids) channelsFetched.current.delete(id);
    });
  }, [spaceIds]);

  // Channels live inside their space's card, never as top-level cards — the
  // server's home list already excludes them, but realtime events can leak
  // them into the store, so the filter is enforced here too. Archived rooms
  // get the shelf at the bottom instead of a card.
  const visible = props.conversations.filter((c) => !c.parentId && !c.self?.isHidden);
  const top = visible.filter((c) => !c.self?.isArchived);
  const archived = visible.filter((c) => c.self?.isArchived);

  // Channels, grouped once. Every space card used to scan the whole list for
  // its own children, which is quadratic in a sidebar full of spaces and runs
  // again on every keystroke somebody types into a room.
  const childrenBySpace = useMemo(() => {
    const byParent = new Map<string, Conversation[]>();
    for (const c of props.conversations) {
      if (!c.parentId) continue;
      const bucket = byParent.get(c.parentId);
      if (bucket) bucket.push(c);
      else byParent.set(c.parentId, [c]);
    }
    return byParent;
  }, [props.conversations]);

  const toggleSpace = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      writeExpanded(next);
      return next;
    });
  };

  const toggleArchived = (): void => {
    const opening = !archivedOpen;
    setArchivedOpen(opening);
    if (opening) {
      setArchivedLoading(true);
      void loadConversations({ archived: true }).finally(() => setArchivedLoading(false));
    }
  };

  const unarchive = async (id: string): Promise<void> => {
    try {
      await api(`/conversations/${id}/state`, { method: 'PATCH', body: { isArchived: false } });
      mutate((s) => {
        const conv = s.conversations.get(id);
        if (conv?.self) conv.self.isArchived = false;
      }, 'conversations');
      // Refresh the home list so the row comes back with its live summary.
      void loadConversations();
    } catch {
      /* it stays on the shelf; the next toggle refetches the truth */
    }
  };

  const dotClass =
    props.status === 'online'
      ? 'status-online'
      : props.status === 'offline'
        ? 'status-offline'
        : 'status-connecting';

  /**
   * How many times you have been named, across every room.
   *
   * Muted rooms count by default — muting says "do not interrupt me", not
   * "I was not called" — and the `mutedBadge` setting below is the way out
   * for anyone whose muted room is exactly the one spamming them.
   *
   * Top-level rooms only, and that `parentId` check is load-bearing: this
   * prop is the whole store, channels included, and a space already
   * *reports* its channels' mentions because a channel never appears in the
   * home list. Summing both counted every channel mention twice — three
   * mentions in #design read as six.
   */
  /*
   * `mutedBadge` off excludes rooms this account has muted. It can only
   * judge the top-level row — a muted channel inside an unmuted space is
   * folded into the space's roll-up before any client sees it — which is
   * the right precision anyway: the person reaching for this switch is
   * muting whole rooms, not single channels.
   *
   * Read off the login payload rather than the Self type, which is the
   * profile subset; the settings ride along at runtime.
   */
  const countMuted =
    (props.me as { notifications?: { mutedBadge?: boolean } } | null)?.notifications
      ?.mutedBadge !== false;
  const mentionTotal = props.conversations.reduce((sum, c) => {
    if (c.parentId) return sum;
    const muted =
      c.self?.notificationLevel === 'none' ||
      Boolean(c.self?.mutedUntil && Date.parse(c.self.mutedUntil) > Date.now());
    if (muted && !countMuted) return sum;
    return sum + (c.self?.mentionCount ?? 0);
  }, 0);

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span className="brand">yappy</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
            <span className={`status-dot ${dotClass}`} />
            {STATUS_LABEL[props.status]}
          </span>
          {/*
            Everywhere you were called, in one list.

            The count is summed from the same per-room mention counts the
            cards below already carry, rather than a second number fetched
            for the purpose: the two would then have to agree, and the one
            that went stale would be this one.

            A number rather than a dot, because "you were called" and "you
            were called eleven times" are different situations and only one
            of them is worth stopping for. The dot could not tell them
            apart.
          */}
          <button
            className="sidebar-new sidebar-inbox"
            title="Mentions"
            aria-label="Mentions"
            // Toggles. It only ever set true, so clicking it again while the
            // panel was open did nothing at all — the only way out was the
            // backdrop or Escape.
            onClick={() => setInboxOpen((v) => !v)}
          >
            <Icon name="at" size={18} />
            {mentionTotal > 0 && (
              <span className="sidebar-inbox-count">
                {mentionTotal > 99 ? '99+' : mentionTotal}
              </span>
            )}
          </button>
          <button
            className="sidebar-new"
            title="New chat"
            aria-label="New chat"
            onClick={() => setNewChatOpen(true)}
          >
            <Icon name="plus" size={18} />
          </button>
        </div>
      </div>
      <Suspense fallback={null}>
        {newChatOpen && <NewChatModal onClose={() => setNewChatOpen(false)} />}
        {inboxOpen && (
          <MentionsInbox onOpen={props.onSelect} onClose={() => setInboxOpen(false)} />
        )}
      </Suspense>

      <div className="conv-list">
        {top.map((conv) => {
          const title = displayTitle(conv, props.me?.id);

          if (isSpace(conv)) {
            const open = expanded.has(conv.id);
            const channels = childrenBySpace.get(conv.id) ?? EMPTY_CHANNELS;
            const unread = channels.reduce((n, c) => n + (c.self?.unreadCount ?? 0), 0);
            const holdsSelection =
              conv.id === props.selectedId ||
              channels.some((c) => c.id === props.selectedId);
            return (
              <div key={conv.id} className={`sp-card${holdsSelection ? ' has-selection' : ''}`}>
                <button
                  className="sp-head"
                  aria-expanded={open}
                  onClick={() => toggleSpace(conv.id)}
                >
                  <Avatar kind="place" name={title} url={conv.avatarUrl} size={42} />
                  <div className="sp-head-main">
                    <div className="conv-title">
                      {title}
                      {conv.badge && <BadgeMark badge={conv.badge} size={14} />}
                    </div>
                    <div className="sp-head-sub">
                      {conv.memberCount} {conv.memberCount === 1 ? 'member' : 'members'}
                      {channels.length > 0 &&
                        ` · ${channels.length} ${channels.length === 1 ? 'channel' : 'channels'}`}
                    </div>
                  </div>
                  {!open && unread > 0 && (
                    <span className="unread-badge">{unread > 99 ? '99+' : unread}</span>
                  )}
                  <span
                    className="sp-head-settings"
                    role="button"
                    aria-label={`Open ${title} overview`}
                    title="Space overview"
                    onClick={(e) => {
                      e.stopPropagation();
                      setOverviewSpaceId(conv.id);
                    }}
                  >
                    <Icon name="settings" size={15} />
                  </span>
                  <span className={`sp-chevron${open ? ' open' : ''}`}>
                    <SpaceGlyph name="chevron-down" size={16} />
                  </span>
                </button>
                {open && (
                  <ChannelList
                    space={conv}
                    selectedId={props.selectedId}
                    onSelect={props.onSelect}
                  />
                )}
              </div>
            );
          }

          const unread = conv.self?.unreadCount ?? 0;
          return (
            <button
              key={conv.id}
              className={`conv-card${conv.id === props.selectedId ? ' selected' : ''}`}
              onClick={() => props.onSelect(conv.id)}
              /* The gap between the cursor arriving and the click landing is
                 most of a round trip. Spend it on the room's first page and
                 the switch is a render rather than a wait. Costs one GET for
                 a room somebody was about to open; nothing if it is cached. */
              onPointerEnter={() => prefetchConversation(conv.id)}
              onFocus={() => prefetchConversation(conv.id)}
            >
              <Avatar
                kind={conv.type === 'dm' ? 'person' : 'place'}
                name={title}
                url={conv.type === 'dm' ? conv.otherUser?.avatarUrl : conv.avatarUrl}
                size={42}
              />
              <div className="conv-main">
                <div className="conv-title">
                  {title}
                  {conv.type === 'dm' && <IdentityMarks user={conv.otherUser} size={13} />}
                  {conv.type !== 'dm' && conv.badge && <BadgeMark badge={conv.badge} size={13} />}
                  {conv.type === 'group' && conv.pet && (
                    <span className="conv-pet" aria-hidden>
                      <PixelPet conversationId={conv.id} pet={conv.pet} size={20} animated={false} />
                    </span>
                  )}
                </div>
                <div className="conv-preview">{preview(conv, props.me?.id)}</div>
              </div>
              <div className="conv-meta">
                <span>{ago(conv.lastMessageAt)}</span>
                {unread > 0 && <span className="unread-badge">{unread > 99 ? '99+' : unread}</span>}
              </div>
            </button>
          );
        })}
        {top.length === 0 && (
          <div style={{ color: 'var(--text-3)', padding: '30px 10px', textAlign: 'center', fontSize: 13 }}>
            No conversations yet. Start one on your phone — it shows up here live.
          </div>
        )}

        {/* ── Voice session ──────────────────────────────────────────────── */}
        <VoiceDock />

        {/* ── Saved messages ─────────────────────────────────────────────── */}
        <button
          className="arc-toggle"
          onClick={() => {
            mutate((s) => (s.view = 'saved'), 'ui');
            syncUrl();
          }}
        >
          <span className="sp-chevron" style={{ display: 'inline-flex' }}>
            <Icon name="bookmark" size={14} />
          </span>
          Saved
        </button>

        {/* ── Archived shelf ─────────────────────────────────────────────── */}
        <button className="arc-toggle" aria-expanded={archivedOpen} onClick={toggleArchived}>
          <span className={`sp-chevron${archivedOpen ? ' open' : ''}`}>
            <SpaceGlyph name="chevron-down" size={14} />
          </span>
          Archived
          {archived.length > 0 && <span className="arc-count">{archived.length}</span>}
        </button>
        {archivedOpen && (
          <>
            {archived.map((conv) => {
              const title = displayTitle(conv, props.me?.id);
              return (
                <div
                  key={conv.id}
                  className={`conv-card archived${conv.id === props.selectedId ? ' selected' : ''}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => props.onSelect(conv.id)}
                  onKeyDown={(e) => e.key === 'Enter' && props.onSelect(conv.id)}
                >
                  <Avatar
                    kind={conv.type === 'dm' ? 'person' : 'place'}
                    name={title}
                    url={conv.type === 'dm' ? conv.otherUser?.avatarUrl : conv.avatarUrl}
                    size={36}
                  />
                  <div className="conv-main">
                    <div className="conv-title">{title}</div>
                    <div className="conv-preview">{preview(conv, props.me?.id)}</div>
                  </div>
                  <button
                    className="arc-restore"
                    title="Unarchive"
                    aria-label={`Unarchive ${title}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      void unarchive(conv.id);
                    }}
                  >
                    <SpaceGlyph name="unarchive" size={16} />
                  </button>
                </div>
              );
            })}
            {archived.length === 0 && (
              <div className="arc-empty">
                {archivedLoading ? 'Looking for archived chats…' : 'Nothing archived'}
              </div>
            )}
          </>
        )}
      </div>

      <Suspense fallback={null}>
      {overviewSpaceId &&
        (() => {
          const space = props.conversations.find((c) => c.id === overviewSpaceId);
          return space ? (
            <SpaceOverview
              space={space}
              onClose={() => setOverviewSpaceId(null)}
              onSelectChannel={(id) => {
                setOverviewSpaceId(null);
                props.onSelect(id);
              }}
            />
          ) : null;
        })()}
      </Suspense>
    </aside>
  );
}
