import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { gateway, loadOlder, sendMessage } from '../state/store';
import type { Conversation, Message, PublicUser, Self } from '../lib/types';
import { Avatar } from './Avatar';

function nameOf(user: PublicUser | null | undefined, fallback = 'someone'): string {
  return user?.displayName ?? user?.username ?? fallback;
}

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function dayOf(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

export function ChatView(props: {
  me: Self;
  conversation: Conversation;
  messages: Message[];
  typingUserIds: string[];
  hasMore: boolean;
}) {
  const { conversation, messages } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [loadingOlder, setLoadingOlder] = useState(false);

  // Stay pinned to the bottom unless the reader has scrolled up.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, conversation.id]);

  useEffect(() => {
    stickToBottom.current = true;
  }, [conversation.id]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  const older = async () => {
    const el = scrollRef.current;
    const heightBefore = el?.scrollHeight ?? 0;
    setLoadingOlder(true);
    try {
      await loadOlder(conversation.id);
    } finally {
      setLoadingOlder(false);
    }
    // Keep the viewport anchored on the message the reader was looking at.
    requestAnimationFrame(() => {
      if (el) el.scrollTop = el.scrollHeight - heightBefore;
    });
  };

  const title =
    conversation.type === 'dm'
      ? nameOf(conversation.otherUser, 'Direct message')
      : (conversation.title ?? 'Unnamed place');

  const typingNames = props.typingUserIds
    .map((id) => {
      const fromMessages = messages.find((m) => m.senderId === id)?.sender;
      return nameOf(fromMessages, 'someone');
    })
    .slice(0, 3);

  return (
    <section className="chat">
      <header className="chat-head">
        <Avatar
          kind={conversation.type === 'dm' ? 'person' : 'place'}
          name={title}
          url={conversation.type === 'dm' ? conversation.otherUser?.avatarUrl : conversation.avatarUrl}
          size={38}
        />
        <div>
          <div className="chat-head-title">{title}</div>
          <div className="chat-head-sub">
            {conversation.type === 'dm'
              ? (conversation.otherUser?.username ? `@${conversation.otherUser.username}` : '')
              : `${conversation.memberCount} member${conversation.memberCount === 1 ? '' : 's'}`}
            {conversation.pet ? ` · ${conversation.pet.name ?? 'the pet'} is ${conversation.pet.mood}` : ''}
          </div>
        </div>
      </header>

      <div className="msg-scroll" ref={scrollRef} onScroll={onScroll}>
        {props.hasMore && (
          <button className="load-older" onClick={() => void older()} disabled={loadingOlder}>
            {loadingOlder ? 'loading…' : 'Load earlier messages'}
          </button>
        )}
        {messages.map((msg, i) => {
          const prev = messages[i - 1];
          const newDay =
            !prev || new Date(prev.createdAt).toDateString() !== new Date(msg.createdAt).toDateString();
          const firstOfGroup =
            newDay ||
            !prev ||
            prev.senderId !== msg.senderId ||
            Date.parse(msg.createdAt) - Date.parse(prev.createdAt) > 5 * 60_000;
          return (
            <div key={msg.id}>
              {newDay && <div className="day-divider">{dayOf(msg.createdAt)}</div>}
              <MessageRow message={msg} firstOfGroup={firstOfGroup} />
            </div>
          );
        })}
      </div>

      <div className="typing-line">
        {typingNames.length > 0 &&
          `${typingNames.join(', ')} ${typingNames.length === 1 ? 'is' : 'are'} typing…`}
      </div>

      <Composer conversationId={conversation.id} />
    </section>
  );
}

function MessageRow(props: { message: Message; firstOfGroup: boolean }) {
  const { message: msg, firstOfGroup } = props;
  const deleted = Boolean(msg.deletedAt);

  const body = (
    <>
      {msg.replyTo && (
        <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 2 }}>
          ↩ {nameOf(msg.replyTo.sender)}: {msg.replyTo.content?.slice(0, 80) ?? '…'}
        </div>
      )}
      {deleted ? (
        <div className="msg-content deleted">message deleted</div>
      ) : (
        msg.content && (
          <div className={`msg-content${msg.pending ? ' pending' : ''}${msg.failed ? ' failed' : ''}`}>
            {msg.content}
            {msg.editedAt && <span style={{ color: 'var(--text-3)', fontSize: 11 }}> (edited)</span>}
            {msg.failed && ' — failed to send'}
          </div>
        )
      )}
      {!deleted &&
        msg.attachments.map((a) =>
          a.mimeType.startsWith('image/') ? (
            <div className="msg-attachment" key={a.id}>
              <img src={a.thumbnailUrl ?? a.url} alt={a.filename ?? ''} loading="lazy" />
            </div>
          ) : (
            <div className="msg-embed" key={a.id}>
              <div className="msg-embed-title">📎 {a.filename ?? 'attachment'}</div>
            </div>
          ),
        )}
      {!deleted && msg.gif && (
        <div className="msg-attachment">
          <img src={msg.gif.url} alt="gif" loading="lazy" />
        </div>
      )}
      {!deleted &&
        msg.embeds?.map((embed, i) => (
          <div className="msg-embed" key={i}>
            {embed.title && <div className="msg-embed-title">{embed.title}</div>}
            {embed.description && <div className="msg-embed-desc">{embed.description}</div>}
            {embed.fields?.map((f, j) => (
              <div key={j} style={{ marginTop: 6 }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{f.name}</div>
                <div style={{ color: 'var(--text-2)', fontSize: 13 }}>{f.value}</div>
              </div>
            ))}
            {embed.footer?.text && (
              <div style={{ color: 'var(--text-3)', fontSize: 11, marginTop: 6 }}>{embed.footer.text}</div>
            )}
          </div>
        ))}
      {(msg.reactions?.length ?? 0) > 0 && (
        <div className="msg-reactions">
          {msg.reactions!.map((r) => (
            <span key={r.emoji} className={`reaction-chip${r.me ? ' mine' : ''}`}>
              {r.emoji} {r.count}
            </span>
          ))}
        </div>
      )}
    </>
  );

  return (
    <div className={`msg-row${firstOfGroup ? ' first-of-group' : ''}`}>
      <div className="msg-gutter">
        {firstOfGroup && <Avatar kind="person" name={nameOf(msg.sender)} url={msg.sender?.avatarUrl} size={36} />}
      </div>
      <div className="msg-body">
        {firstOfGroup && (
          <div className="msg-author-line">
            <span className="msg-author" style={msg.senderRoleColor ? { color: msg.senderRoleColor } : undefined}>
              {nameOf(msg.sender)}
            </span>
            <span className="msg-time">{timeOf(msg.createdAt)}</span>
          </div>
        )}
        {body}
      </div>
    </div>
  );
}

function Composer(props: { conversationId: string }) {
  const [text, setText] = useState('');
  const typingUntil = useRef(0);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setText('');
    areaRef.current?.focus();
  }, [props.conversationId]);

  const submit = () => {
    const content = text.trim();
    if (!content) return;
    setText('');
    typingUntil.current = 0;
    gateway.typingStop(props.conversationId);
    void sendMessage(props.conversationId, content);
  };

  const onChange = (value: string) => {
    setText(value);
    // Throttled typing.start: one per 6s while keys are moving.
    const now = Date.now();
    if (value.trim() && now > typingUntil.current) {
      typingUntil.current = now + 6_000;
      gateway.typingStart(props.conversationId);
    }
  };

  return (
    <div className="composer">
      <textarea
        ref={areaRef}
        rows={1}
        placeholder="Say something…"
        value={text}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <button className="send" onClick={submit} disabled={!text.trim()} aria-label="Send">
        ➤
      </button>
    </div>
  );
}
