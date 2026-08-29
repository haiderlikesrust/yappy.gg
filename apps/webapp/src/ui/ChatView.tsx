import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import {
  gateway,
  getState,
  loadOlder,
  mutate,
  patchMessage,
  resetToLatest,
  useStore,
} from '../state/store';
import type { Conversation, EmbedView, Message, PublicUser, Self } from '../lib/types';
import { AuthedVideo } from './AuthedMedia';
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
import { BlurImage, type AttachmentWire } from './chat/Blurhash';
import { ChartSvg } from './chat/ChartSvg';
import { CommandPicker } from './chat/CommandPicker';
import { customEmojiByKey, ensureCustomEmojis } from './chat/customEmojis';
import { ForwardPicker } from './chat/ForwardPicker';
import { clearJump, jumpToMessage, peekJump } from './chat/jump';
import { SearchInChat } from './search';
import { LocationCard } from './chat/LocationCard';
import { MessageActions } from './chat/MessageActions';
import { MessageButtons } from './chat/MessageButtons';
import { MicIcon, PaperclipIcon } from './chat/icons-local';
import { VideoNoteCircle, isVideoNoteAttachment } from './chat/VideoNoteCircle';
import { BadgeMark, IdentityMarks } from './badges';
import { PinnedBar } from './chat/PinnedBar';
import { PollCard } from './chat/PollCard';
import { PollComposer } from './chat/PollComposer';
import { ensureReceipts } from './chat/receipts';
import { ThreadPanel } from './chat/ThreadPanel';
import { Ticks } from './chat/Ticks';
import {
  AudioAttachment,
  VoiceRecorderBar,
  uploadVoiceRecording,
  useVoiceRecorder,
} from './chat/VoiceNote';
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
import { reactionChips, type Attachment } from '../lib/types';
import { open } from '../lib/e2e';
import './chat/chat.css';

function nameOf(user: PublicUser | null | undefined, fallback = 'someone'): string {
  return user?.displayName ?? user?.username ?? fallback;
}

/**
 * The reply header, resolved from what the wire actually carries: a stub of
 * {id, seq, senderId, preview}. The original message, when loaded, gives the
 * best answer; otherwise the author's name comes from any of their loaded
 * messages, the DM partner, or "You".
 */
function replyMeta(
  conversationId: string,
  reply: NonNullable<Message['replyTo']>,
  me: Self,
): { name: string; text: string; seq: number | null } {
  const list = getState().messages.get(conversationId) ?? [];
  const original = list.find((m) => !m.pending && m.id === reply.id);
  const senderId = reply.sender?.id ?? reply.senderId ?? original?.senderId ?? null;

  let name: string;
  if (senderId && senderId === me.id) {
    name = 'You';
  } else if (reply.sender) {
    name = nameOf(reply.sender);
  } else if (original?.sender) {
    name = nameOf(original.sender);
  } else {
    const fromList = senderId ? list.find((m) => m.senderId === senderId)?.sender : null;
    const conv = getState().conversations.get(conversationId);
    const fromDm =
      conv?.type === 'dm' && senderId && conv.otherUser?.id === senderId ? conv.otherUser : null;
    name = nameOf(fromList ?? fromDm);
  }

  const text = original?.deletedAt
    ? 'message deleted'
    : (reply.content ?? original?.content ?? reply.preview ?? '…');
  return { name, text, seq: reply.seq ?? original?.seq ?? null };
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

// ── System messages ──────────────────────────────────────────────────────────

/** The serializer's system payload + names; the shared type has not caught up. */
interface SystemPayload {
  event: string;
  actorId?: string | null;
  targetIds?: string[];
  value?: string | null;
}
type MessageWire = Message & {
  system?: SystemPayload | null;
  systemNames?: Record<string, string> | null;
};

/**
 * The wording table, mirrored from Android's SystemLine. `systemNames` is the
 * server's resolution of the ids inside the payload — never look at rosters.
 */
function systemText(msg: MessageWire): string {
  const system = msg.system;
  if (!system) return msg.content ?? 'something happened';
  const names = msg.systemNames ?? {};
  const name = (id: string | null | undefined) => (id ? names[id] : undefined);
  const actor = name(system.actorId) ?? 'Someone';
  const resolved = (system.targetIds ?? []).map((id) => name(id) ?? 'someone');
  const targets =
    resolved.length === 0
      ? 'someone'
      : resolved.length === 1
        ? resolved[0]!
        : resolved.length === 2
          ? `${resolved[0]} and ${resolved[1]}`
          : `${resolved[0]} and ${resolved.length - 1} others`;

  switch (system.event) {
    case 'conversation_created':
      return `${actor} created the group`;
    case 'member_added':
      return `${actor} added ${targets}`;
    case 'member_joined':
      return `${actor} joined`;
    case 'member_left':
      return `${actor} left`;
    case 'member_removed':
      return `${actor} removed ${targets}`;
    case 'member_promoted':
      return `${actor} promoted ${targets}`;
    case 'member_demoted':
      return `${actor} demoted ${targets}`;
    case 'title_changed':
      return `${actor} renamed the group${system.value ? ` to "${system.value}"` : ''}`;
    case 'avatar_changed':
      return `${actor} changed the group photo`;
    case 'message_pinned':
      return `${actor} pinned a message`;
    case 'upgraded_to_space':
      return 'This group became a space — its history lives here now';
    case 'channel_created':
      return `Channel created${system.value ? ` · #${system.value}` : ''}`;
    case 'disappearing_changed':
      return system.value === '0' ? 'Disappearing messages off' : 'Disappearing messages on';
    case 'campfire_ending':
      return 'This campfire is ending soon — say your goodbyes';
    case 'screenshot_taken':
      return `${actor} took a screenshot`;
    default:
      // Unknown kinds still get a quiet line, never an empty bubble.
      return system.event.replace(/_/g, ' ');
  }
}

/** Centred, small, no bubble — part of the timeline, not the conversation. */
function SystemLine(props: { message: Message }) {
  return (
    <div className="system-line">
      <span>{systemText(props.message as MessageWire)}</span>
    </div>
  );
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
  const [threadRoot, setThreadRoot] = useState<Message | null>(null);
  const [forwardMsg, setForwardMsg] = useState<Message | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [flashSeq, setFlashSeq] = useState<number | null>(null);
  const upload = useAttachmentUpload();
  const { isDragging, bind: dropBind } = useFileDrop(upload.addFiles);

  const detached = state.detached.has(conversation.id);
  const isDm = conversation.type === 'dm';

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
      ? messages.find(
          (m) => !m.pending && m.seq > dividerSeq && m.senderId !== me.id && m.type !== 'system',
        )?.id ?? null
      : null;

  // Stay pinned to the bottom unless the reader scrolled up or jumped away.
  // Keyed on the LAST MESSAGE'S IDENTITY, not the list length: swapping the
  // optimistic row for the confirmed one is a length-neutral change that
  // still moves the tail (a sent sticker arrives exactly that way).
  const lastMessageId = messages[messages.length - 1]?.id ?? null;
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current && !detached) el.scrollTop = el.scrollHeight;
  }, [lastMessageId, messages.length, conversation.id, detached]);

  // Media inflates after the fact — a sticker or GIF renders 0px tall and
  // grows when its bytes arrive, pushing the tail below a scroll that already
  // happened. While pinned, any growth of the content re-pins the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (stickToBottom.current && !state.detached.has(conversation.id)) {
        el.scrollTop = el.scrollHeight;
      }
    });
    for (const child of el.children) observer.observe(child);
    // New rows mount over time; observing the container's own box misses
    // scrollHeight changes, so a MutationObserver keeps the child set fresh.
    const mutations = new MutationObserver(() => {
      observer.disconnect();
      for (const child of el.children) observer.observe(child);
    });
    mutations.observe(el, { childList: true });
    return () => {
      observer.disconnect();
      mutations.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation.id]);

  useEffect(() => {
    stickToBottom.current = true;
    setShowJump(false);
    setReplyTo(null);
    setEditingId(null);
    setViewer(null);
    setPanelOpen(false);
    setProfileUserId(null);
    setThreadRoot(null);
    setForwardMsg(null);
    setFlashSeq(null);
    upload.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation.id]);

  // Seed the receipt cursors (ticks, seen-by) and the room's custom emoji.
  useEffect(() => {
    void ensureReceipts(conversation.id);
    if (conversation.type !== 'dm') ensureCustomEmojis(conversation.id);
  }, [conversation.id, conversation.type]);

  // Pending jump (pinned bar, search, …): once the target row exists, scroll
  // it into view and flash it. Runs after every render — the check is cheap.
  useEffect(() => {
    const seq = peekJump(conversation.id);
    if (seq === null) return;
    const row = scrollRef.current?.querySelector<HTMLElement>(`[data-seq="${seq}"]`);
    if (!row) return;
    clearJump(conversation.id);
    stickToBottom.current = false;
    row.scrollIntoView({ block: 'center' });
    setFlashSeq(seq);
    window.setTimeout(() => setFlashSeq((v) => (v === seq ? null : v)), 1800);
  });

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottom.current = fromBottom < 60;
    setShowJump(fromBottom > 300);
  };

  const jumpToLatest = () => {
    const el = scrollRef.current;
    if (detached) {
      // The list shows an around-window; the tail must be re-fetched.
      void resetToLatest(conversation.id).then(() => {
        stickToBottom.current = true;
        const node = scrollRef.current;
        if (node) node.scrollTop = node.scrollHeight;
      });
      return;
    }
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

  /** Open the thread panel on a message's root, fetching the root if needed. */
  const openThread = async (msg: Message) => {
    const rootId = msg.threadRootId ?? msg.id;
    let root = messages.find((m) => m.id === rootId) ?? null;
    if (!root) {
      try {
        root = (
          await api<{ message: Message }>(`/conversations/${conversation.id}/messages/${rootId}`)
        ).message;
      } catch (err) {
        console.error('thread root fetch failed', err);
        return;
      }
    }
    setThreadRoot(root);
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
            <div className="chat-head-title">
              {title}
              {conversation.type === 'dm' ? (
                <IdentityMarks user={conversation.otherUser} size={14} />
              ) : (
                conversation.badge && <BadgeMark badge={conversation.badge} size={14} />
              )}
            </div>
            <div className="chat-head-sub">
              {conversation.type === 'dm'
                ? (conversation.otherUser?.username ? `@${conversation.otherUser.username}` : '')
                : (() => {
                    // A channel reports its space's membership — its own
                    // counter only tracks lazily materialized rows.
                    const n =
                      (conversation.type === 'channel'
                        ? getState().conversations.get(conversation.parentId ?? '')?.memberCount
                        : null) ?? conversation.memberCount;
                    return `${n} member${n === 1 ? '' : 's'}`;
                  })()}
              {conversation.pet ? ` · ${conversation.pet.name ?? 'the pet'} is ${conversation.pet.mood}` : ''}
            </div>
          </div>
        </button>
        <div className="chat-head-actions">
          <button
            className="chat-head-btn"
            title="Search in conversation"
            aria-label="Search in conversation"
            onClick={() => setSearchOpen((v) => !v)}
          >
            <Icon name="search" size={17} />
          </button>
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

      {searchOpen && (
        <div className="chat-search-dock">
          <SearchInChat
            conversationId={conversation.id}
            onJump={(seq) => {
              void jumpToMessage(conversation.id, seq);
            }}
            onClose={() => setSearchOpen(false)}
          />
        </div>
      )}

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
              prev.type === 'system' ||
              Date.parse(msg.createdAt) - Date.parse(prev.createdAt) > 5 * 60_000;
            return (
              <div key={msg.id} data-seq={msg.pending ? undefined : msg.seq}>
                {msg.id === firstUnreadId && <div className="new-divider">NEW</div>}
                {newDay && <div className="day-divider">{dayOf(msg.createdAt)}</div>}
                {msg.type === 'system' ? (
                  <SystemLine message={msg} />
                ) : (
                  <MessageRow
                    message={msg}
                    firstOfGroup={firstOfGroup}
                    me={me}
                    conversationId={conversation.id}
                    isDm={isDm}
                    flash={flashSeq !== null && msg.seq === flashSeq}
                    editing={editingId === msg.id}
                    onEditStart={() => setEditingId(msg.id)}
                    onEditEnd={() => setEditingId(null)}
                    onReply={() => setReplyTo(msg)}
                    onThread={() => void openThread(msg)}
                    onForward={() => setForwardMsg(msg)}
                    onOpenViewer={(items, startIndex) => setViewer({ items, startIndex })}
                    onOpenProfile={(userId) => setProfileUserId(userId)}
                  />
                )}
              </div>
            );
          })}
        </div>

        {(showJump || detached) && (
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
      {threadRoot && (
        <ThreadPanel
          conversationId={conversation.id}
          root={threadRoot}
          onClose={() => setThreadRoot(null)}
        />
      )}
      {forwardMsg && <ForwardPicker message={forwardMsg} onClose={() => setForwardMsg(null)} />}
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
  isDm: boolean;
  flash: boolean;
  editing: boolean;
  onEditStart: () => void;
  onEditEnd: () => void;
  onReply: () => void;
  onThread: () => void;
  onForward: () => void;
  onOpenViewer: (items: Attachment[], startIndex: number) => void;
  onOpenProfile: (userId: string) => void;
}) {
  const { message: msg, firstOfGroup, me, conversationId } = props;
  const deleted = Boolean(msg.deletedAt);
  const isOwn = msg.senderId === me.id;
  const viewable = msg.attachments.filter(
    (a) => /^(image|video)\//.test(a.mimeType) && !isVideoNoteAttachment(a),
  );
  const chips = reactionChips(msg);

  // The bubble carries the words; media, embeds, polls and buttons stand on
  // their own below it, the way the phones draw them.
  const hasBubble = deleted || props.editing || Boolean(msg.content);

  // Above the bubble, outside it: provenance is about the message, not part
  // of what was said. Same wording and placement as the phones.
  const forwardedLabel = msg.forwardedFrom
    ? (msg.forwardedFrom.displayName?.trim() ||
        (msg.forwardedFrom.username ? `@${msg.forwardedFrom.username}` : null) ||
        (msg.forwardedFrom.userId === me.id ? 'You' : 'someone'))
    : null;

  const body = (
    <>
      {forwardedLabel && !deleted && (
        <div className="msg-fwd">
          <Icon name="reply" size={11} style={{ transform: 'scaleX(-1)' }} />
          <span>Forwarded from {forwardedLabel}</span>
        </div>
      )}
      {hasBubble && (
        <div className="msg-bubble">
          {msg.replyTo &&
            (() => {
              const meta = replyMeta(conversationId, msg.replyTo, me);
              return (
                <button
                  className="msg-replyto"
                  title="Go to the original message"
                  onClick={() => {
                    if (meta.seq != null) void jumpToMessage(conversationId, meta.seq);
                  }}
                >
                  <Icon name="reply" size={12} />
                  <span>
                    <b style={{ fontWeight: 600 }}>{meta.name}</b>
                    {': '}
                    {meta.text.slice(0, 80)}
                  </span>
                </button>
              );
            })()}
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
                {msg.editedAt && <span style={{ opacity: 0.6, fontSize: 11 }}> (edited)</span>}
                {msg.failed && ' — failed to send'}
              </div>
            )
          )}
          {!deleted && !props.editing && msg.translation && (
            <div className="msg-translation">
              {msg.translation.pending ? (
                <span className="msg-translation-meta">translating…</span>
              ) : (
                <>
                  <div className="msg-translation-text">{msg.translation.text}</div>
                  <div className="msg-translation-meta">
                    translated from {msg.translation.detected} ·{' '}
                    <button
                      onClick={() =>
                        patchMessage(conversationId, msg.id, (m) => (m.translation = null))
                      }
                    >
                      show original
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}
      {!deleted &&
        msg.attachments.map((a) =>
          a.mimeType.startsWith('audio/') ? (
            <AudioAttachment key={a.id} attachment={a as AttachmentWire} />
          ) : a.mimeType.startsWith('image/') ? (
            <BlurImage
              key={a.id}
              attachment={a as AttachmentWire}
              onClick={() => props.onOpenViewer(viewable, viewable.findIndex((v) => v.id === a.id))}
            />
          ) : isVideoNoteAttachment(a) ? (
            <VideoNoteCircle key={a.id} attachment={a} />
          ) : a.mimeType.startsWith('video/') ? (
            <button
              className="msg-attachment"
              key={a.id}
              onClick={() => props.onOpenViewer(viewable, viewable.findIndex((v) => v.id === a.id))}
            >
              <AuthedVideo src={a.url} preload="metadata" muted />
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
      {!deleted && msg.location && <LocationCard location={msg.location} />}
      {!deleted &&
        msg.embeds?.map((embed, i) =>
          embed.invite ? (
            <InviteCard invite={embed.invite} key={i} />
          ) : // The client's own half of the trust check — the server already
          // strips `kind` from anyone who is not a badged bot, and rendering
          // the notice treatment on the field alone would let any bot mint a
          // card that looks like it came from us. Same gate as the phones.
          embed.kind === 'announcement' && msg.sender?.isBot && msg.sender?.badge === 'staff' ? (
            <AnnouncementEmbed embed={embed} key={i} keyPrefix={`e${i}-`} />
          ) : (
          <div className="msg-embed" key={i}>
            {embed.title && (
              <div className="msg-embed-title">
                {embed.url ? (
                  <a href={embed.url} target="_blank" rel="noreferrer noopener">
                    {embed.title}
                  </a>
                ) : (
                  embed.title
                )}
              </div>
            )}
            {embed.description && (
              <div className="msg-embed-desc">{linkify(embed.description, `e${i}-`)}</div>
            )}
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
      {!deleted && (msg.threadReplyCount ?? 0) > 0 && (
        <button className="thread-pill" onClick={props.onThread}>
          <Icon name="chat" size={13} /> {msg.threadReplyCount}{' '}
          {msg.threadReplyCount === 1 ? 'reply' : 'replies'}
        </button>
      )}
      {chips.length > 0 && (
        <div className="msg-reactions">
          {chips.map((r) => {
            const custom = customEmojiByKey(conversationId, r.emoji);
            return (
              <button
                key={r.emoji}
                className={`reaction-chip${r.me ? ' mine' : ''}`}
                title={r.me ? 'Remove your reaction' : 'React too'}
                onClick={() => void toggleReaction(conversationId, msg, r.emoji)}
              >
                {custom ? (
                  <img className="chip-emoji-img" src={custom.url} alt={r.emoji} />
                ) : (
                  r.emoji
                )}{' '}
                {r.count}
              </button>
            );
          })}
        </div>
      )}
    </>
  );

  return (
    <div
      className={`msg-row${firstOfGroup ? ' first-of-group' : ''}${isOwn ? ' own' : ''}${props.flash ? ' flash' : ''}`}
    >
      <div className="msg-gutter">
        {firstOfGroup && (
          <button className="msg-avatar-btn" onClick={() => props.onOpenProfile(msg.senderId)}>
            <Avatar kind="person" name={nameOf(msg.sender)} url={msg.sender?.avatarUrl} size={36} />
          </button>
        )}
      </div>
      <div className="msg-body">
        {firstOfGroup && !isOwn && (
          <div className="msg-author-line">
            <button
              className="msg-author"
              style={msg.senderRoleColor ? { color: msg.senderRoleColor } : undefined}
              onClick={() => props.onOpenProfile(msg.senderId)}
            >
              {nameOf(msg.sender)}
            </button>
            <IdentityMarks user={msg.sender} size={13} />
            <span className="msg-time">{timeOf(msg.createdAt)}</span>
          </div>
        )}
        {body}
        {isOwn && !deleted && (
          <span className="msg-stamp msg-stamp-ticks">
            {firstOfGroup && timeOf(msg.createdAt)}
            <Ticks message={msg} conversationId={conversationId} canOpenSeen={!props.isDm} />
          </span>
        )}
        {!deleted && !msg.pending && (
          <MessageActions
            conversationId={conversationId}
            message={msg}
            isOwn={isOwn}
            isDm={props.isDm}
            onReply={props.onReply}
            onEdit={props.onEditStart}
            onThread={props.onThread}
            onForward={props.onForward}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Message text with mention entities lit up. Anything not covered by a
 * mention renders verbatim; mentions become clickable @chips that open the
 * person. Entities are trusted for offsets — the server validated them.
 */
/** A leading slash command is an instruction addressed to software, not
 *  prose — it gets the command treatment, exactly like the phones. Only at
 *  the start: a slash mid-sentence is a date, a fraction, or a path. */
const LEADING_COMMAND = /^(\/[a-z][a-z0-9_-]{1,31})(?=\s|$)/;

/** Bare URLs become links. Trailing sentence punctuation stays prose. */
const URL_IN_TEXT = /https?:\/\/[^\s<>"'()\[\]]+[^\s<>"'()\[\].,;:!?]/g;

export function linkify(text: string, keyPrefix = ''): ReactNode {
  URL_IN_TEXT.lastIndex = 0;
  if (!URL_IN_TEXT.test(text)) return text;
  URL_IN_TEXT.lastIndex = 0;
  const parts: ReactNode[] = [];
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_IN_TEXT.exec(text)) !== null) {
    if (m.index > cursor) parts.push(text.slice(cursor, m.index));
    parts.push(
      <a key={`${keyPrefix}l${m.index}`} href={m[0]} target="_blank" rel="noreferrer noopener">
        {m[0]}
      </a>,
    );
    cursor = m.index + m[0].length;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

/** Inline `code` spans; the plain stretches around them still get links. */
const INLINE_CODE = /`([^`\n]+)`/g;

function inlineCode(text: string, keyPrefix: string): ReactNode {
  INLINE_CODE.lastIndex = 0;
  if (!INLINE_CODE.test(text)) return linkify(text, keyPrefix);
  INLINE_CODE.lastIndex = 0;
  const parts: ReactNode[] = [];
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_CODE.exec(text)) !== null) {
    if (m.index > cursor) {
      parts.push(linkify(text.slice(cursor, m.index), `${keyPrefix}p${cursor}-`));
    }
    parts.push(
      <code key={`${keyPrefix}c${m.index}`} className="msg-code-inline">
        {m[1]}
      </code>,
    );
    cursor = m.index + m[0].length;
  }
  if (cursor < text.length) parts.push(linkify(text.slice(cursor), `${keyPrefix}e-`));
  return parts;
}

function withCommandChip(text: string, keyBase: number): ReactNode {
  const m = LEADING_COMMAND.exec(text);
  if (!m) return inlineCode(text, `t${keyBase}-`);
  return (
    <>
      <span key={`cmd-${keyBase}`} className="msg-cmd">{m[1]}</span>
      {inlineCode(text.slice(m[1]!.length), `t${keyBase}-`)}
    </>
  );
}

/**
 * Fenced ```code``` blocks split the message at the top level: inside a
 * fence nothing else renders (no links, mentions, or command chips), which
 * is the whole point of a fence. Web-first — the phones show fences verbatim.
 */
const FENCE = /```([A-Za-z0-9+#.-]*)[ \t]*\n?([\s\S]*?)```/g;

interface FenceSeg {
  kind: 'text' | 'code';
  text: string;
  lang?: string;
  /** Where this segment starts in the raw content — keeps entity offsets honest. */
  start: number;
}

function splitFences(content: string): FenceSeg[] {
  FENCE.lastIndex = 0;
  const segs: FenceSeg[] = [];
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = FENCE.exec(content)) !== null) {
    const code = (m[2] ?? '').replace(/\n$/, '');
    if (!code.trim()) continue; // ``` ``` with nothing in it — leave as prose
    if (m.index > cursor) {
      segs.push({ kind: 'text', text: content.slice(cursor, m.index), start: cursor });
    }
    segs.push({ kind: 'code', text: code, lang: m[1] || undefined, start: m.index });
    cursor = m.index + m[0].length;
  }
  if (segs.length === 0) return [{ kind: 'text', text: content, start: 0 }];
  if (cursor < content.length) {
    segs.push({ kind: 'text', text: content.slice(cursor), start: cursor });
  }
  return segs;
}

function CodeBlock(props: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(props.code).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <div className="msg-codeblock">
      <div className="msg-codeblock-head">
        <span className="msg-codeblock-lang">{props.lang ?? 'code'}</span>
        <button
          className="msg-codeblock-copy"
          title={copied ? 'Copied' : 'Copy code'}
          aria-label="Copy code"
          onClick={copy}
        >
          <Icon name={copied ? 'check' : 'copy'} size={13} />
        </button>
      </div>
      <pre>
        <code>{props.code}</code>
      </pre>
    </div>
  );
}

/** One stretch of prose: mentions lit up, command chip only at offset 0. */
function renderProse(
  msg: Message,
  text: string,
  base: number,
  onOpenProfile: (userId: string) => void,
): ReactNode {
  const mentions = (msg.entities ?? [])
    .filter(
      (e) => e.type === 'mention' && typeof e.offset === 'number' && typeof e.length === 'number',
    )
    .map((e) => ({ ...e, offset: (e.offset ?? 0) - base }))
    .filter((e) => e.offset >= 0 && e.offset + (e.length ?? 0) <= text.length)
    .sort((a, b) => a.offset - b.offset);
  const chipOk = base === 0;
  if (mentions.length === 0) {
    return chipOk ? withCommandChip(text, 0) : inlineCode(text, `b${base}-`);
  }

  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const ent of mentions) {
    const start = ent.offset;
    const end = start + (ent.length ?? 0);
    if (start < cursor) continue; // malformed — skip
    if (start > cursor) {
      const slice = text.slice(cursor, start);
      parts.push(
        cursor === 0 && chipOk ? withCommandChip(slice, start) : inlineCode(slice, `s${base}-${cursor}-`),
      );
    }
    const label = text.slice(start, end);
    parts.push(
      ent.userId ? (
        <button key={`m${base}-${start}`} className="msg-mention" onClick={() => onOpenProfile(ent.userId!)}>
          {label}
        </button>
      ) : (
        <span key={`m${base}-${start}`} className="msg-mention">{label}</span>
      ),
    );
    cursor = end;
  }
  if (cursor < text.length) parts.push(inlineCode(text.slice(cursor), `tail${base}-`));
  return parts;
}

/**
 * A staff announcement — reads as a notice, not a bot card. Ported from
 * Android's AnnouncementCard: a header band with the megaphone instead of the
 * left accent bar, no cap on the body, and the post time in the band. Only
 * reachable behind the sender trust check at the call site.
 */
function AnnouncementEmbed(props: { embed: EmbedView; keyPrefix: string }) {
  const { embed } = props;
  const accent = embed.color || 'var(--accent)';
  return (
    <div className="msg-announcement">
      <div
        className="msg-announcement-head"
        style={{ background: `color-mix(in srgb, ${accent} 16%, transparent)`, color: accent }}
      >
        <Icon name="megaphone" size={15} />
        <span className="msg-announcement-who">{embed.author?.name ?? 'Announcement'}</span>
        {embed.timestamp && <span className="msg-announcement-time">{timeOf(embed.timestamp)}</span>}
      </div>
      <div className="msg-announcement-body">
        {embed.title && <div className="msg-announcement-title">{embed.title}</div>}
        {embed.description && (
          <div className="msg-announcement-desc">{linkify(embed.description, props.keyPrefix)}</div>
        )}
        {embed.footer?.text && <div className="msg-announcement-foot">{embed.footer.text}</div>}
      </div>
    </div>
  );
}

/**
 * What an encrypted message looks like on this device.
 *
 * Three outcomes, and all three have to be legible. It decrypts, and reads
 * like any other message. It does not decrypt because this device was never
 * a recipient — it joined the account later, and the honest answer is that
 * nobody can hand it a copy now. Or the build cannot decrypt at all, in
 * which case the notice the server stored is exactly right.
 */
function EncryptedBody(props: { msg: Message }) {
  const plain = open(props.msg.ciphertext);
  if (plain !== null) return <>{plain}</>;
  return (
    <span className="msg-locked">
      <Icon name="lock" size={13} />
      {props.msg.ciphertext
        ? 'Encrypted for another device.'
        : 'This device cannot read this message.'}
    </span>
  );
}

function renderContent(
  msg: Message,
  onOpenProfile: (userId: string) => void,
): ReactNode {
  // The body of an encrypted message never goes near the prose pipeline:
  // mentions, links and code fences are properties of text the server could
  // read, and it read none of this.
  if (msg.isEncrypted) return <EncryptedBody msg={msg} />;
  const content = msg.content ?? '';
  const segs = splitFences(content);
  if (segs.length === 1 && segs[0]!.kind === 'text') {
    return renderProse(msg, content, 0, onOpenProfile);
  }
  return segs.map((seg, i) =>
    seg.kind === 'code' ? (
      <CodeBlock key={`f${i}`} code={seg.text} lang={seg.lang} />
    ) : (
      <span key={`f${i}`}>{renderProse(msg, seg.text, seg.start, onOpenProfile)}</span>
    ),
  );
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
  const [pollOpen, setPollOpen] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);

  // Voice notes: record → upload (purpose 'voice', waveform, duration) →
  // send as type 'audio' with the confirmed attachment id.
  const recorder = useVoiceRecorder((rec) => {
    const convId = props.conversationId;
    setVoiceBusy(true);
    void (async () => {
      try {
        const mediaId = await uploadVoiceRecording(rec);
        await sendChatMessage(convId, null, { type: 'audio', attachmentIds: [mediaId] });
      } catch (err) {
        console.error('voice note send failed', err);
      } finally {
        setVoiceBusy(false);
      }
    })();
  });

  // @mention autocomplete: the room's people, fetched once per conversation,
  // plus a username → id map built from everyone we have ever seen here so
  // entities can be computed at send time by scanning the final text.
  const memberCache = useRef(new Map<string, MentionCandidate[]>());
  const [members, setMembers] = useState<MentionCandidate[]>([]);
  const knownUsers = useRef(new Map<string, string>()); // username(lower) → userId

  // Conversation switch: park the draft we leave behind, restore the one we
  // return to. The ref carries the latest text into the cleanup.
  const textRef = useRef(text);
  textRef.current = text;
  useEffect(() => {
    const convId = props.conversationId;
    setText(getState().drafts.get(convId) ?? '');
    setPicker(null);
    setPollOpen(false);
    setCommands(commandCache.current.get(convId) ?? null);
    setMembers(memberCache.current.get(convId) ?? []);
    areaRef.current?.focus();
    return () => {
      recorder.cancel();
      const leaving = textRef.current;
      mutate((s) => {
        if (leaving.trim()) s.drafts.set(convId, leaving);
        else s.drafts.delete(convId);
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    mutate((s) => {
      s.drafts.delete(props.conversationId);
    });
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
      {pollOpen && (
        <PollComposer conversationId={props.conversationId} onClose={() => setPollOpen(false)} />
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

      {recorder.recording || voiceBusy ? (
        <div className="composer">
          <VoiceRecorderBar
            elapsedMs={recorder.elapsedMs}
            busy={voiceBusy}
            onCancel={recorder.cancel}
            onStop={recorder.stop}
          />
        </div>
      ) : (
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
          <button
            className={`composer-btn${pollOpen ? ' active' : ''}`}
            title="Create a poll"
            aria-label="Create a poll"
            onClick={() => setPollOpen((v) => !v)}
          >
            <Icon name="chart" size={19} />
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
          {recorder.supported && (
            <button
              className="composer-btn"
              title="Record a voice note"
              aria-label="Record a voice note"
              onClick={() => void recorder.start()}
            >
              <MicIcon size={19} />
            </button>
          )}
          <button className="send" onClick={submit} disabled={!canSend} aria-label="Send">
            <Icon name="send" size={20} />
          </button>
        </div>
      )}
    </div>
  );
}
