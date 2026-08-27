import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { gateway, loadOlder, useStore } from '../state/store';
import type { Conversation, Message, PublicUser, Self } from '../lib/types';
import { Avatar } from './Avatar';
import { Icon } from './icons';
import {
  editMessage,
  fetchCommands,
  fetchMentionCandidates,
  sendChatMessage,
  toggleReaction,
  type MentionCandidate,
  type SlashCommand,
} from './chat/actions';
import { ChartSvg } from './chat/ChartSvg';
import { CommandPicker } from './chat/CommandPicker';
import { MessageActions } from './chat/MessageActions';
import { MessageButtons } from './chat/MessageButtons';
import { PaperclipIcon } from './chat/icons-local';
import { PinnedBar } from './chat/PinnedBar';
import { PollCard } from './chat/PollCard';
import {
  AttachmentTray,
  DropOverlay,
  GifPicker,
  MediaViewer,
  StickerPicker,
  filesFromClipboard,
  useAttachmentUpload,
  useFileDrop,
} from './media';
import { GroupPanel, InviteCard } from './group';
import { ProfilePopover } from './profile/ProfilePopover';
import type { Attachment } from '../lib/types';
import './chat/chat.css';

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

/**
 * Unread divider bookkeeping, held at module scope so it survives remounts.
 *
 * `selectConversation` zeroes `self.lastReadSeq` (sets it to latest) before
 * React re-renders, so the value cannot be read at open time. Instead, every
 * render sweeps all conversations that currently show unread and remembers
 * their read cursor; the moment one of them becomes the open conversation the
 * pending value is frozen for the divider, then cleared.
 */
const pendingDividerSeq = new Map<string, number>();
const frozenDividerSeq = new Map<string, number | null>();

export function ChatView(props: {
  me: Self;
  conversation: Conversation;
  messages: Message[];
  typingUserIds: string[];
  hasMore: boolean;
}) {
  const { conversation, messages, me } = props;
  const { state } = useStore();
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [showJump, setShowJump] = useState(false);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [viewer, setViewer] = useState<{ items: Attachment[]; startIndex: number } | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [profileUserId, setProfileUserId] = useState<string | null>(null);
  const upload = useAttachmentUpload();
  const { isDragging, bind: dropBind } = useFileDrop(upload.addFiles);

  // Sweep unread cursors before they are zeroed out from under us.
  for (const conv of state.conversations.values()) {
    if (conv.self && conv.self.unreadCount > 0) {
      pendingDividerSeq.set(conv.id, conv.self.lastReadSeq);
    }
  }
  const prevConvId = useRef<string | null>(null);
  if (prevConvId.current !== conversation.id) {
    prevConvId.current = conversation.id;
    const captured =
      pendingDividerSeq.get(conversation.id) ??
      (conversation.self && conversation.self.unreadCount > 0
        ? conversation.self.lastReadSeq
        : null);
    frozenDividerSeq.set(conversation.id, captured);
    pendingDividerSeq.delete(conversation.id);
  }
  const dividerSeq = frozenDividerSeq.get(conversation.id) ?? null;
  const firstUnreadId =
    dividerSeq !== null
      ? messages.find((m) => !m.pending && m.seq > dividerSeq && m.senderId !== me.id)?.id ?? null
      : null;

  // Stay pinned to the bottom unless the reader has scrolled up.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, conversation.id]);

  useEffect(() => {
    stickToBottom.current = true;
    setShowJump(false);
    setReplyTo(null);
    setEditingId(null);
    setViewer(null);
    setPanelOpen(false);
    setProfileUserId(null);
    upload.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation.id]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottom.current = fromBottom < 60;
    setShowJump(fromBottom > 300);
  };

  const jumpToLatest = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
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

  const pinnedCount = messages.filter((m) => m.isPinned && !m.deletedAt).length;

  return (
    <section className="chat" {...dropBind}>
      <header className="chat-head">
        <button
          className="chat-head-id"
          onClick={() => {
            if (conversation.type === 'dm' && conversation.otherUser) {
              setProfileUserId(conversation.otherUser.id);
            } else {
              setPanelOpen((v) => !v);
            }
          }}
        >
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
        </button>
        <div className="chat-head-actions">
          <button
            className="chat-head-btn"
            title="Details"
            aria-label="Conversation details"
            onClick={() => setPanelOpen((v) => !v)}
          >
            <Icon name="dots" size={18} />
          </button>
        </div>
      </header>

      {pinnedCount > 0 && <PinnedBar conversationId={conversation.id} pinnedCount={pinnedCount} />}

      <div className="msg-scroll-wrap">
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
                {msg.id === firstUnreadId && <div className="new-divider">NEW</div>}
                {newDay && <div className="day-divider">{dayOf(msg.createdAt)}</div>}
                <MessageRow
                  message={msg}
                  firstOfGroup={firstOfGroup}
                  me={me}
                  conversationId={conversation.id}
                  editing={editingId === msg.id}
                  onEditStart={() => setEditingId(msg.id)}
                  onEditEnd={() => setEditingId(null)}
                  onReply={() => setReplyTo(msg)}
                  onOpenViewer={(items, startIndex) => setViewer({ items, startIndex })}
                  onOpenProfile={(userId) => setProfileUserId(userId)}
                />
              </div>
            );
          })}
        </div>

        {showJump && (
          <button className="jump-pill" onClick={jumpToLatest}>
            <Icon name="arrow-down" size={14} /> latest
          </button>
        )}
      </div>

      <div className="typing-line">
        {typingNames.length > 0 &&
          `${typingNames.join(', ')} ${typingNames.length === 1 ? 'is' : 'are'} typing…`}
      </div>

      <Composer
        conversationId={conversation.id}
        replyTo={replyTo}
        onCancelReply={() => setReplyTo(null)}
        upload={upload}
      />

      {isDragging && <DropOverlay />}
      {viewer && (
        <MediaViewer items={viewer.items} startIndex={viewer.startIndex} onClose={() => setViewer(null)} />
      )}
      {panelOpen && <GroupPanel conversation={conversation} onClose={() => setPanelOpen(false)} />}
      {profileUserId && (
        <ProfilePopover userId={profileUserId} onClose={() => setProfileUserId(null)} />
      )}
    </section>
  );
}

function MessageRow(props: {
  message: Message;
  firstOfGroup: boolean;
  me: Self;
  conversationId: string;
  editing: boolean;
  onEditStart: () => void;
  onEditEnd: () => void;
  onReply: () => void;
  onOpenViewer: (items: Attachment[], startIndex: number) => void;
  onOpenProfile: (userId: string) => void;
}) {
  const { message: msg, firstOfGroup, me, conversationId } = props;
  const deleted = Boolean(msg.deletedAt);
  const isOwn = msg.senderId === me.id;
  const viewable = msg.attachments.filter((a) => /^(image|video)\//.test(a.mimeType));

  const body = (
    <>
      {msg.replyTo && (
        <div className="msg-replyto">
          <Icon name="reply" size={12} />
          <span>
            <b style={{ color: 'var(--accent-soft)', fontWeight: 600 }}>{nameOf(msg.replyTo.sender)}</b>
            {': '}
            {msg.replyTo.content?.slice(0, 80) ?? '…'}
          </span>
        </div>
      )}
      {deleted ? (
        <div className="msg-content deleted">message deleted</div>
      ) : props.editing ? (
        <EditBox
          conversationId={conversationId}
          message={msg}
          onDone={props.onEditEnd}
        />
      ) : (
        msg.content && (
          <div className={`msg-content${msg.pending ? ' pending' : ''}${msg.failed ? ' failed' : ''}`}>
            {renderContent(msg, props.onOpenProfile)}
            {msg.editedAt && <span style={{ color: 'var(--text-3)', fontSize: 11 }}> (edited)</span>}
            {msg.failed && ' — failed to send'}
          </div>
        )
      )}
      {!deleted &&
        msg.attachments.map((a) =>
          a.mimeType.startsWith('image/') ? (
            <button
              className="msg-attachment"
              key={a.id}
              onClick={() => props.onOpenViewer(viewable, viewable.findIndex((v) => v.id === a.id))}
            >
              <img src={a.thumbnailUrl ?? a.url} alt={a.filename ?? ''} loading="lazy" />
            </button>
          ) : a.mimeType.startsWith('video/') ? (
            <button
              className="msg-attachment"
              key={a.id}
              onClick={() => props.onOpenViewer(viewable, viewable.findIndex((v) => v.id === a.id))}
            >
              <video src={a.url} preload="metadata" muted />
            </button>
          ) : (
            <div className="msg-embed" key={a.id}>
              <div className="msg-embed-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <PaperclipIcon size={14} /> {a.filename ?? 'attachment'}
              </div>
            </div>
          ),
        )}
      {!deleted && msg.gif && (
        <div className="msg-attachment">
          <img src={msg.gif.url} alt="gif" loading="lazy" />
        </div>
      )}
      {!deleted && msg.sticker && (
        <div className="msg-sticker">
          <img
            src={msg.sticker.url}
            alt={msg.sticker.name ?? msg.sticker.emoji ?? 'sticker'}
            loading="lazy"
          />
        </div>
      )}
      {!deleted &&
        msg.embeds?.map((embed, i) =>
          embed.invite ? (
            <InviteCard invite={embed.invite} key={i} />
          ) : (
          <div className="msg-embed" key={i}>
            {embed.title && <div className="msg-embed-title">{embed.title}</div>}
            {embed.description && <div className="msg-embed-desc">{embed.description}</div>}
            {embed.chart && <ChartSvg chart={embed.chart} />}
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
      {!deleted && msg.poll && (
        <PollCard conversationId={conversationId} message={msg} isOwn={isOwn} />
      )}
      {!deleted && msg.components && (
        <MessageButtons conversationId={conversationId} message={msg} meId={me.id} />
      )}
      {(msg.reactions?.length ?? 0) > 0 && (
        <div className="msg-reactions">
          {msg.reactions!.map((r) => (
            <button
              key={r.emoji}
              className={`reaction-chip${r.me ? ' mine' : ''}`}
              title={r.me ? 'Remove your reaction' : 'React too'}
              onClick={() => void toggleReaction(conversationId, msg, r.emoji)}
            >
              {r.emoji} {r.count}
            </button>
          ))}
        </div>
      )}
    </>
  );

  return (
    <div className={`msg-row${firstOfGroup ? ' first-of-group' : ''}`}>
      <div className="msg-gutter">
        {firstOfGroup && (
          <button className="msg-avatar-btn" onClick={() => props.onOpenProfile(msg.senderId)}>
            <Avatar kind="person" name={nameOf(msg.sender)} url={msg.sender?.avatarUrl} size={36} />
          </button>
        )}
      </div>
      <div className="msg-body">
        {firstOfGroup && (
          <div className="msg-author-line">
            <button
              className="msg-author"
              style={msg.senderRoleColor ? { color: msg.senderRoleColor } : undefined}
              onClick={() => props.onOpenProfile(msg.senderId)}
            >
              {nameOf(msg.sender)}
            </button>
            <span className="msg-time">{timeOf(msg.createdAt)}</span>
          </div>
        )}
        {body}
      </div>
      {!deleted && !msg.pending && (
        <MessageActions
          conversationId={conversationId}
          message={msg}
          isOwn={isOwn}
          onReply={props.onReply}
          onEdit={props.onEditStart}
        />
      )}
    </div>
  );
}

/**
 * Message text with mention entities lit up. Anything not covered by a
 * mention renders verbatim; mentions become clickable @chips that open the
 * person. Entities are trusted for offsets — the server validated them.
 */
function renderContent(
  msg: Message,
  onOpenProfile: (userId: string) => void,
): ReactNode {
  const content = msg.content ?? '';
  const mentions = (msg.entities ?? [])
    .filter((e) => e.type === 'mention' && typeof e.offset === 'number' && typeof e.length === 'number')
    .sort((a, b) => (a.offset ?? 0) - (b.offset ?? 0));
  if (mentions.length === 0) return content;

  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const ent of mentions) {
    const start = ent.offset ?? 0;
    const end = start + (ent.length ?? 0);
    if (start < cursor || end > content.length) continue; // malformed — skip
    if (start > cursor) parts.push(content.slice(cursor, start));
    const label = content.slice(start, end);
    parts.push(
      ent.userId ? (
        <button key={start} className="msg-mention" onClick={() => onOpenProfile(ent.userId!)}>
          {label}
        </button>
      ) : (
        <span key={start} className="msg-mention">{label}</span>
      ),
    );
    cursor = end;
  }
  if (cursor < content.length) parts.push(content.slice(cursor));
  return parts;
}

function EditBox(props: { conversationId: string; message: Message; onDone: () => void }) {
  const [text, setText] = useState(props.message.content ?? '');
  const [saving, setSaving] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = areaRef.current;
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, []);

  const save = async () => {
    const content = text.trim();
    if (!content || content === props.message.content) {
      props.onDone();
      return;
    }
    setSaving(true);
    try {
      await editMessage(props.conversationId, props.message.id, content);
      props.onDone();
    } catch (err) {
      console.error('edit failed', err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="edit-box">
      <textarea
        ref={areaRef}
        rows={2}
        value={text}
        disabled={saving}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void save();
          }
          if (e.key === 'Escape') props.onDone();
        }}
      />
      <div className="edit-hint">
        enter to save · escape to <button onClick={props.onDone}>cancel</button>
      </div>
    </div>
  );
}

function Composer(props: {
  conversationId: string;
  replyTo: Message | null;
  onCancelReply: () => void;
  upload: ReturnType<typeof useAttachmentUpload>;
}) {
  const { upload } = props;
  const [text, setText] = useState('');
  const typingUntil = useRef(0);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const commandCache = useRef(new Map<string, SlashCommand[]>());
  const [commands, setCommands] = useState<SlashCommand[] | null>(null);
  const [picker, setPicker] = useState<'gif' | 'sticker' | null>(null);

  // @mention autocomplete: the room's people, fetched once per conversation,
  // plus a username → id map built from everyone we have ever seen here so
  // entities can be computed at send time by scanning the final text.
  const memberCache = useRef(new Map<string, MentionCandidate[]>());
  const [members, setMembers] = useState<MentionCandidate[]>([]);
  const knownUsers = useRef(new Map<string, string>()); // username(lower) → userId

  useEffect(() => {
    setText('');
    setPicker(null);
    setCommands(commandCache.current.get(props.conversationId) ?? null);
    setMembers(memberCache.current.get(props.conversationId) ?? []);
    areaRef.current?.focus();
  }, [props.conversationId]);

  // Focus the box when a reply target is chosen.
  useEffect(() => {
    if (props.replyTo) areaRef.current?.focus();
  }, [props.replyTo]);

  // A leading "/" summons the command list — fetched once per conversation.
  const slashMatch = /^\/([a-zA-Z0-9_-]*)$/.exec(text);
  useEffect(() => {
    if (!slashMatch) return;
    const convId = props.conversationId;
    if (commandCache.current.has(convId)) return;
    commandCache.current.set(convId, []); // fetch once, even if it fails
    fetchCommands(convId)
      .then((list) => {
        commandCache.current.set(convId, list);
        setCommands(list);
      })
      .catch((err) => console.error('commands fetch failed', err));
  }, [Boolean(slashMatch), props.conversationId]); // eslint-disable-line react-hooks/exhaustive-deps

  // An "@" with a word behind the caret summons people. Fetch once per room.
  const caretWord = /(?:^|\s)@([a-zA-Z0-9_.]*)$/.exec(text);
  useEffect(() => {
    if (!caretWord) return;
    const convId = props.conversationId;
    if (memberCache.current.has(convId)) return;
    memberCache.current.set(convId, []);
    fetchMentionCandidates(convId)
      .then((list) => {
        memberCache.current.set(convId, list);
        for (const m of list) {
          if (m.username) knownUsers.current.set(m.username.toLowerCase(), m.userId);
        }
        setMembers(list);
      })
      .catch((err) => console.error('members fetch failed', err));
  }, [Boolean(caretWord), props.conversationId]); // eslint-disable-line react-hooks/exhaustive-deps

  const activeMembers = members.length > 0 ? members : (memberCache.current.get(props.conversationId) ?? []);
  const mentionMatches = caretWord
    ? activeMembers
        .filter((m) => m.username && m.username.toLowerCase().startsWith((caretWord[1] ?? '').toLowerCase()))
        .slice(0, 8)
    : [];

  const pickMention = (m: MentionCandidate) => {
    if (!m.username) return;
    knownUsers.current.set(m.username.toLowerCase(), m.userId);
    setText((t) => t.replace(/@([a-zA-Z0-9_.]*)$/, `@${m.username} `));
    areaRef.current?.focus();
  };

  /** Entities computed from the final text: every @username we can resolve. */
  const mentionEntities = (content: string) => {
    const entities: Array<{ type: 'mention'; offset: number; length: number; userId: string }> = [];
    const re = /@([a-zA-Z0-9_.]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const userId = knownUsers.current.get(m[1]!.toLowerCase());
      if (userId) entities.push({ type: 'mention', offset: m.index, length: m[0].length, userId });
    }
    return entities;
  };

  const submit = () => {
    const content = text.trim();
    const attachmentIds = upload.readyMediaIds;
    if (!content && attachmentIds.length === 0) return;
    if (upload.isUploading) return;
    setText('');
    typingUntil.current = 0;
    gateway.typingStop(props.conversationId);
    void sendChatMessage(props.conversationId, content || null, {
      replyTo: props.replyTo,
      ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
      entities: mentionEntities(content),
    });
    upload.clear();
    if (props.replyTo) props.onCancelReply();
  };

  const sendGif = (gif: unknown) => {
    setPicker(null);
    void sendChatMessage(props.conversationId, null, { replyTo: props.replyTo, gif });
    if (props.replyTo) props.onCancelReply();
  };

  const sendSticker = (stickerId: string) => {
    setPicker(null);
    void sendChatMessage(props.conversationId, null, { replyTo: props.replyTo, stickerId });
    if (props.replyTo) props.onCancelReply();
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

  const activeCommands = commands ?? commandCache.current.get(props.conversationId) ?? [];
  const canSend = (text.trim().length > 0 || upload.readyMediaIds.length > 0) && !upload.isUploading;

  return (
    <div className="composer-zone">
      {slashMatch && activeCommands.length > 0 && (
        <CommandPicker
          commands={activeCommands}
          prefix={slashMatch[1] ?? ''}
          onPick={(cmd) => {
            setText(`/${cmd.name} `);
            areaRef.current?.focus();
          }}
        />
      )}

      {mentionMatches.length > 0 && (
        <div className="mention-picker">
          {mentionMatches.map((m) => (
            <button key={m.userId} className="mention-row" onClick={() => pickMention(m)}>
              <Avatar kind="person" name={m.displayName ?? m.username} url={m.avatarUrl} size={24} />
              <span className="mention-name">{m.displayName ?? m.username}</span>
              <span className="mention-handle">@{m.username}</span>
              {m.isBot && <span className="mention-bot">bot</span>}
            </button>
          ))}
        </div>
      )}

      {picker === 'gif' && <GifPicker onPick={sendGif} onClose={() => setPicker(null)} />}
      {picker === 'sticker' && (
        <StickerPicker onPick={(s) => sendSticker(s.id)} onClose={() => setPicker(null)} />
      )}

      {props.replyTo && (
        <div className="reply-banner">
          <Icon name="reply" size={14} />
          <span className="reply-banner-text">
            Replying to <b>{nameOf(props.replyTo.sender)}</b>
            {props.replyTo.content ? ` — ${props.replyTo.content.slice(0, 60)}` : ''}
          </span>
          <button className="reply-cancel" title="Cancel reply" onClick={props.onCancelReply}>
            <Icon name="close" size={14} />
          </button>
        </div>
      )}

      {upload.items.length > 0 && (
        <AttachmentTray items={upload.items} onRemove={upload.remove} onRetry={upload.retry} />
      )}

      <div className="composer">
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) upload.addFiles([...e.target.files]);
            e.target.value = '';
          }}
        />
        <button
          className="composer-btn"
          title="Attach files"
          aria-label="Attach files"
          onClick={() => fileRef.current?.click()}
        >
          <Icon name="plus" size={19} />
        </button>
        <button
          className={`composer-btn${picker === 'gif' ? ' active' : ''}`}
          title="GIFs"
          aria-label="GIFs"
          onClick={() => setPicker(picker === 'gif' ? null : 'gif')}
        >
          <Icon name="gif" size={19} />
        </button>
        <button
          className={`composer-btn${picker === 'sticker' ? ' active' : ''}`}
          title="Stickers"
          aria-label="Stickers"
          onClick={() => setPicker(picker === 'sticker' ? null : 'sticker')}
        >
          <Icon name="sticker" size={19} />
        </button>
        <textarea
          ref={areaRef}
          rows={1}
          placeholder="Say something…"
          value={text}
          onChange={(e) => onChange(e.target.value)}
          onPaste={(e) => {
            const files = filesFromClipboard(e.nativeEvent);
            if (files.length > 0) {
              e.preventDefault();
              upload.addFiles(files);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
            if (e.key === 'Escape') {
              if (picker) setPicker(null);
              else if (props.replyTo) props.onCancelReply();
            }
          }}
        />
        <button className="send" onClick={submit} disabled={!canSend} aria-label="Send">
          <Icon name="send" size={20} />
        </button>
      </div>
    </div>
  );
}
