import { signOut } from '../lib/api';
import type { Conversation, Self } from '../lib/types';
import type { GatewayStatus } from '../lib/gateway';
import { Avatar } from './Avatar';

function displayTitle(conv: Conversation, meId: string | undefined): string {
  if (conv.type === 'dm') {
    return conv.otherUser?.displayName ?? conv.otherUser?.username ?? conv.title ?? 'Direct message';
  }
  return conv.title ?? 'Unnamed place';
}

function preview(conv: Conversation): string {
  const last = conv.lastMessage;
  if (last?.content) {
    const who = last.sender?.displayName ?? last.sender?.username;
    return who ? `${who}: ${last.content}` : last.content;
  }
  return conv.lastMessagePreview ?? '';
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

export function Sidebar(props: {
  me: Self | null;
  status: GatewayStatus;
  conversations: Conversation[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
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
          <button className="signout" onClick={() => void signOut()}>
            sign out
          </button>
        </div>
      </div>

      <div className="conv-list">
        {props.conversations.map((conv) => {
          const title = displayTitle(conv, props.me?.id);
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
                <div className="conv-title">{title}</div>
                <div className="conv-preview">{preview(conv)}</div>
              </div>
              <div className="conv-meta">
                <span>{ago(conv.lastMessageAt)}</span>
                {unread > 0 && <span className="unread-badge">{unread > 99 ? '99+' : unread}</span>}
              </div>
            </button>
          );
        })}
        {props.conversations.length === 0 && (
          <div style={{ color: 'var(--text-3)', padding: '30px 10px', textAlign: 'center', fontSize: 13 }}>
            No conversations yet. Start one on your phone — it shows up here live.
          </div>
        )}
      </div>
    </aside>
  );
}
