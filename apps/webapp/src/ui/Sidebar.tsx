import { useState } from 'react';
import { api } from '../lib/api';
import type { Conversation, Self } from '../lib/types';
import type { GatewayStatus } from '../lib/gateway';
import { loadConversations, mutate, syncUrl } from '../state/store';
import { Avatar } from './Avatar';
import { NewChatModal, PixelPet } from './group';
import { Icon } from './icons';
import { ChannelList, SpaceGlyph, isSpace } from './space';
import './space/space.css';

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
  const [expanded, setExpanded] = useState<Set<string>>(readExpanded);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [archivedLoading, setArchivedLoading] = useState(false);

  // Channels live inside their space's card, never as top-level cards — the
  // server's home list already excludes them, but realtime events can leak
  // them into the store, so the filter is enforced here too. Archived rooms
  // get the shelf at the bottom instead of a card.
  const top = props.conversations.filter((c) => !c.parentId && !c.self?.isArchived);
  const archived = props.conversations.filter((c) => !c.parentId && c.self?.isArchived);

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
      });
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

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span className="brand">yappy</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
            <span className={`status-dot ${dotClass}`} />
            {STATUS_LABEL[props.status]}
          </span>
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
      {newChatOpen && <NewChatModal onClose={() => setNewChatOpen(false)} />}

      <div className="conv-list">
        {top.map((conv) => {
          const title = displayTitle(conv, props.me?.id);

          if (isSpace(conv)) {
            const open = expanded.has(conv.id);
            const channels = props.conversations.filter((c) => c.parentId === conv.id);
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
                    <div className="conv-title">{title}</div>
                    <div className="sp-head-sub">
                      {conv.memberCount} {conv.memberCount === 1 ? 'member' : 'members'}
                      {channels.length > 0 &&
                        ` · ${channels.length} ${channels.length === 1 ? 'channel' : 'channels'}`}
                    </div>
                  </div>
                  {!open && unread > 0 && (
                    <span className="unread-badge">{unread > 99 ? '99+' : unread}</span>
                  )}
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

        {/* ── Saved messages ─────────────────────────────────────────────── */}
        <button
          className="arc-toggle"
          onClick={() => {
            mutate((s) => (s.view = 'saved'));
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
    </aside>
  );
}
