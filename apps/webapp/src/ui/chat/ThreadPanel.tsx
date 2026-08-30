/**
 * The thread drawer: one root message and its replies, docked over the chat's
 * right edge like the details drawer.
 *
 * History comes from GET /conversations/:id/messages/:rootId/thread
 * (`{ messages, hasMore }`, oldest first). Live replies ride the main store —
 * MessageCreate events land in the conversation's list (thread replies show in
 * the main timeline too, matching Android), so this panel merges the fetch
 * with whatever the store holds filtered by `threadRootId`.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { useStore } from '../../state/store';
import type { Message, PublicUser } from '../../lib/types';
import { Avatar } from '../Avatar';
import { Icon } from '../icons';
import { sendChatMessage } from './actions';

function nameOf(user: PublicUser | null | undefined): string {
  return user?.displayName ?? user?.username ?? 'someone';
}

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function preview(msg: Message): string {
  if (msg.deletedAt) return 'message deleted';
  if (msg.content) return msg.content;
  if (msg.attachments.length > 0) return 'attachment';
  if (msg.poll) return `poll: ${msg.poll.question}`;
  if (msg.gif) return 'GIF';
  if (msg.sticker) return 'sticker';
  return 'message';
}

export function ThreadPanel(props: {
  conversationId: string;
  /** The thread root — clicking "reply in thread" on a reply resolves to its root first. */
  root: Message;
  onClose: () => void;
  /**
   * Render as the whole channel rather than a drawer beside one.
   *
   * A forum post *is* its thread — there is no timeline next to it to keep
   * visible — so the panel takes the pane instead of a 320px column.
   */
  fullWidth?: boolean;
}) {
  const { conversationId, root } = props;
  const { state, version } = useStore('messages');
  const [fetched, setFetched] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setFetched([]);
    api<{ messages: Message[]; hasMore: boolean }>(
      `/conversations/${conversationId}/messages/${root.id}/thread?limit=100`,
    )
      .then((res) => {
        if (alive) setFetched(res.messages);
      })
      .catch((err) => console.error('thread fetch failed', err))
      .finally(() => alive && setLoading(false));
    areaRef.current?.focus();
    return () => {
      alive = false;
    };
  }, [conversationId, root.id]);

  // Fetch + live store copies, deduped by id, seq order with pendings last.
  // Keyed on the store `version`, not the array reference — the store mutates
  // its lists in place, so the reference alone would go stale.
  const replies = useMemo(() => {
    const live = state.messages.get(conversationId) ?? [];
    const seen = new Map<string, Message>();
    for (const m of fetched) seen.set(m.id, m);
    for (const m of live) {
      if (m.threadRootId === root.id) seen.set(m.id, m);
    }
    return [...seen.values()]
      .filter((m) => !m.deletedAt)
      .sort((a, b) => (a.pending ? 1 : b.pending ? -1 : a.seq - b.seq));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetched, version, conversationId, root.id]);

  // Keep the panel pinned to the newest reply.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [replies.length]);

  const submit = async () => {
    const content = text.trim();
    if (!content || sending) return;
    setText('');
    setSending(true);
    try {
      await sendChatMessage(conversationId, content, { threadRootId: root.id });
    } finally {
      setSending(false);
    }
    areaRef.current?.focus();
  };

  return (
    <aside className={`gp-drawer thread-panel${props.fullWidth ? ' thread-full' : ''}`}>
      <header className="thread-head">
        <Icon name="chat" size={16} style={{ color: 'var(--accent-soft)' }} />
        {/* A forum post is known by its title; a chat thread has none. */}
        <div className="thread-head-title">{root.title ?? 'Thread'}</div>
        <button className="chat-head-btn" title="Close thread" aria-label="Close thread" onClick={props.onClose}>
          <Icon name="close" size={16} />
        </button>
      </header>

      <div className="thread-root">
        <div className="thread-msg-author">
          <Avatar kind="person" name={nameOf(root.sender)} url={root.sender?.avatarUrl} size={24} />
          <b>{nameOf(root.sender)}</b>
          <time>{timeOf(root.createdAt)}</time>
        </div>
        <div className="thread-msg-content">{preview(root)}</div>
      </div>

      <div className="thread-count">
        {loading
          ? 'loading…'
          : `${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}`}
      </div>

      <div className="thread-list" ref={listRef}>
        {replies.map((msg) => (
          <div className={`thread-msg${msg.pending ? ' pending' : ''}`} key={msg.id}>
            <div className="thread-msg-author">
              <Avatar kind="person" name={nameOf(msg.sender)} url={msg.sender?.avatarUrl} size={24} />
              <b>{nameOf(msg.sender)}</b>
              <time>{timeOf(msg.createdAt)}</time>
            </div>
            <div className="thread-msg-content">{preview(msg)}</div>
          </div>
        ))}
        {!loading && replies.length === 0 && (
          <div className="thread-empty">No replies yet — start the thread.</div>
        )}
      </div>

      <div className="thread-composer">
        <textarea
          ref={areaRef}
          rows={1}
          placeholder="Reply in thread…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
            if (e.key === 'Escape') props.onClose();
          }}
        />
        <button
          className="send"
          onClick={() => void submit()}
          disabled={!text.trim() || sending}
          aria-label="Send reply"
        >
          <Icon name="send" size={18} />
        </button>
      </div>
    </aside>
  );
}
