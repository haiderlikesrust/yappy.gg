/**
 * Forward a message: pick target conversations, ship one POST.
 *
 * POST /conversations/messages/forward with forwardMessagesBody:
 * `{ messageIds (1-30), toConversationIds (1-20), hideSender, comment }`.
 * The server re-sends copies into each target, so the forwards arrive back
 * over the gateway like any other message — nothing to patch locally.
 */

import { useMemo, useState } from 'react';
import { api } from '../../lib/api';
import { useStore } from '../../state/store';
import type { Conversation, Message } from '../../lib/types';
import { Avatar } from '../Avatar';
import { Icon } from '../icons';

function titleOf(conv: Conversation): string {
  return conv.type === 'dm'
    ? (conv.otherUser?.displayName ?? conv.otherUser?.username ?? 'Direct message')
    : (conv.title ?? 'Unnamed place');
}

export function ForwardPicker(props: { message: Message; onClose: () => void }) {
  const { state } = useStore();
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);

  const conversations = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...state.conversations.values()]
      .filter((c) => !q || titleOf(c).toLowerCase().includes(q))
      .sort((a, b) => Date.parse(b.lastMessageAt ?? '0') - Date.parse(a.lastMessageAt ?? '0'))
      .slice(0, 40);
  }, [state.conversations, query]);

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < 20) next.add(id);
      return next;
    });

  const submit = async () => {
    if (picked.size === 0 || sending) return;
    setSending(true);
    try {
      await api('/conversations/messages/forward', {
        method: 'POST',
        body: { messageIds: [props.message.id], toConversationIds: [...picked] },
      });
      props.onClose();
    } catch (err) {
      console.error('forward failed', err);
      setSending(false);
    }
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="modal-card" role="dialog" aria-label="Forward message">
        <header className="modal-head">
          <Icon name="arrow-right" size={17} style={{ color: 'var(--accent-soft)' }} />
          <div className="modal-title">Forward to…</div>
          <button className="chat-head-btn" title="Close" aria-label="Close" onClick={props.onClose}>
            <Icon name="close" size={16} />
          </button>
        </header>

        <input
          className="modal-input"
          placeholder="Search conversations"
          value={query}
          autoFocus
          onChange={(e) => setQuery(e.target.value)}
        />

        <div className="fwd-list">
          {conversations.map((conv) => (
            <button
              key={conv.id}
              className={`fwd-row${picked.has(conv.id) ? ' picked' : ''}`}
              onClick={() => toggle(conv.id)}
              aria-pressed={picked.has(conv.id)}
            >
              <Avatar
                kind={conv.type === 'dm' ? 'person' : 'place'}
                name={titleOf(conv)}
                url={conv.type === 'dm' ? conv.otherUser?.avatarUrl : conv.avatarUrl}
                size={28}
              />
              <span className="fwd-name">{titleOf(conv)}</span>
              {picked.has(conv.id) && <Icon name="check" size={15} style={{ color: 'var(--accent-soft)' }} />}
            </button>
          ))}
          {conversations.length === 0 && <div className="fwd-empty">Nothing matches</div>}
        </div>

        <div className="modal-actions">
          <button className="modal-cancel" onClick={props.onClose}>cancel</button>
          <button className="modal-primary" onClick={() => void submit()} disabled={picked.size === 0 || sending}>
            <Icon name="arrow-right" size={14} />
            {sending ? 'forwarding…' : `Forward${picked.size > 0 ? ` (${picked.size})` : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}
