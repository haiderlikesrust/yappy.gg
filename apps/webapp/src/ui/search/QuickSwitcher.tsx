import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../lib/api';
import type { Conversation } from '../../lib/types';
import {
  gateway,
  getState,
  loadAround,
  mutate,
  selectConversation,
  useStore,
} from '../../state/store';
import { Avatar } from '../Avatar';
import { Icon } from '../icons';
import {
  Snippet,
  conversationName,
  formatWhen,
  fuzzyScore,
  senderName,
  setJumpTarget,
  type MessageHit,
  type MessageSearchResponse,
  type SearchUser,
  type UnifiedSearchResponse,
} from './shared';
import { BadgeMarks, BotTag, heldBadges } from '../badges';
import './search.css';

/**
 * The Ctrl+K palette. The shell owns the hotkey and mounts this with
 * `open`/`onClose`; everything inside is keyboard-first.
 *
 *  - empty query   → your conversations by recency, instant switching
 *  - 1+ characters → fuzzy-filtered conversations, locally, instantly
 *  - 2+ characters → the server joins in (350ms debounce, stale-guarded):
 *      People   from GET /search (open-or-create DM, same flow as NewChatModal)
 *      Messages from GET /search/messages (jump via loadAround + 'yappy.jump')
 */

type Row =
  | { kind: 'conversation'; conv: Conversation }
  | { kind: 'person'; user: SearchUser }
  | { kind: 'message'; hit: MessageHit };

interface Section {
  label: string;
  rows: Row[];
}

const EMPTY_RECENTS = 14;
const FILTERED_MAX = 8;

function conversationLabel(conv: Conversation): string {
  return (
    conv.title ?? conv.otherUser?.displayName ?? conv.otherUser?.username ?? 'Untitled chat'
  );
}

export function QuickSwitcher(props: { open: boolean; onClose: () => void }) {
  const { open, onClose } = props;
  if (!open) return null;
  return <Palette onClose={onClose} />;
}

function Palette(props: { onClose: () => void }) {
  const { onClose } = props;
  const { state } = useStore();
  const [query, setQuery] = useState('');
  const [people, setPeople] = useState<SearchUser[]>([]);
  const [hits, setHits] = useState<MessageHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const term = query.trim();

  // Local conversations: recency when idle, fuzzy when typing.
  const conversations = useMemo(() => {
    const all = [...state.conversations.values()].filter((c) => !c.self?.isArchived);
    if (term.length === 0) {
      return all
        .sort(
          (a, b) =>
            (b.lastMessageAt ? Date.parse(b.lastMessageAt) : 0) -
            (a.lastMessageAt ? Date.parse(a.lastMessageAt) : 0),
        )
        .slice(0, EMPTY_RECENTS);
    }
    return all
      .map((conv) => {
        const score = Math.max(
          fuzzyScore(term, conv.title) ?? -1,
          fuzzyScore(term, conv.handle) ?? -1,
          fuzzyScore(term, conv.otherUser?.displayName) ?? -1,
          fuzzyScore(term, conv.otherUser?.username) ?? -1,
        );
        return { conv, score };
      })
      .filter((e) => e.score >= 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          (b.conv.lastMessageAt ? Date.parse(b.conv.lastMessageAt) : 0) -
            (a.conv.lastMessageAt ? Date.parse(a.conv.lastMessageAt) : 0),
      )
      .slice(0, FILTERED_MAX)
      .map((e) => e.conv);
  }, [state.conversations, term]);

  // Server search from two characters — debounced, and stale responses lose.
  useEffect(() => {
    if (term.length < 2) {
      setPeople([]);
      setHits([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const [unified, messages] = await Promise.all([
          api<UnifiedSearchResponse>(`/search?q=${encodeURIComponent(term)}`),
          api<MessageSearchResponse>(
            `/search/messages?q=${encodeURIComponent(term)}&limit=20`,
          ),
        ]);
        if (cancelled) return;
        const myId = getState().me?.id;
        setPeople((unified.users ?? []).filter((u) => u.id !== myId));
        setHits(messages.results ?? []);
      } catch {
        if (!cancelled) {
          setPeople([]);
          setHits([]);
        }
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [term]);

  const sections = useMemo<Section[]>(() => {
    const out: Section[] = [];
    if (conversations.length > 0) {
      out.push({
        label: term.length === 0 ? 'Recent' : 'Chats',
        rows: conversations.map((conv) => ({ kind: 'conversation', conv })),
      });
    }
    if (people.length > 0) {
      out.push({ label: 'People', rows: people.map((user) => ({ kind: 'person', user })) });
    }
    if (hits.length > 0) {
      out.push({ label: 'Messages', rows: hits.map((hit) => ({ kind: 'message', hit })) });
    }
    return out;
  }, [conversations, people, hits, term]);

  const flat = useMemo(() => sections.flatMap((s) => s.rows), [sections]);

  // Selection resets on a new query and clamps when the list shrinks.
  useEffect(() => setActive(0), [term]);
  useEffect(() => {
    if (active >= flat.length) setActive(Math.max(0, flat.length - 1));
  }, [flat.length, active]);
  useEffect(() => {
    listRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [active, flat.length]);

  const pick = async (row: Row): Promise<void> => {
    if (busy) return;
    if (row.kind === 'conversation') {
      onClose();
      await selectConversation(row.conv.id);
      return;
    }
    if (row.kind === 'person') {
      // Same flow as NewChatModal.startDm: the server dedupes, so an existing
      // DM comes back as-is and a fresh one is created.
      setBusy(true);
      try {
        const res = await api<{ conversation: Conversation }>('/conversations', {
          method: 'POST',
          body: { type: 'dm', memberIds: [row.user.id] },
        });
        mutate((s) => {
          const existing = s.conversations.get(res.conversation.id);
          s.conversations.set(
            res.conversation.id,
            existing ? { ...existing, ...res.conversation } : res.conversation,
          );
        });
        gateway.subscribe(res.conversation.id);
        onClose();
        await selectConversation(res.conversation.id);
      } catch {
        setBusy(false);
      }
      return;
    }
    // Message: land in the conversation, window around the hit, and leave the
    // highlight target where the chat surface looks for it.
    setJumpTarget(row.hit.conversationId, row.hit.seq);
    onClose();
    await selectConversation(row.hit.conversationId);
    await loadAround(row.hit.conversationId, row.hit.seq);
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (flat.length > 0) setActive((i) => (i + 1) % flat.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (flat.length > 0) setActive((i) => (i - 1 + flat.length) % flat.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const row = flat[active];
      if (row) void pick(row);
    }
  };

  let index = -1; // running flat index across sections

  return (
    <div
      className="qs-overlay"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="qs-card" role="dialog" aria-label="Quick switcher" onKeyDown={onKeyDown}>
        <div className="qs-inputrow">
          <Icon name="search" size={20} className="qs-inputicon" />
          <input
            autoFocus
            className="qs-input"
            value={query}
            placeholder="Jump to a chat, find people, search messages…"
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search"
          />
          {searching && <span className="qs-spinner" aria-hidden />}
        </div>

        <div className="qs-list" ref={listRef}>
          {sections.map((section) => (
            <div key={section.label} className="qs-section">
              <div className="qs-section-head">{section.label}</div>
              {section.rows.map((row) => {
                index += 1;
                const i = index;
                const isActive = i === active;
                const key =
                  row.kind === 'conversation'
                    ? `c:${row.conv.id}`
                    : row.kind === 'person'
                      ? `p:${row.user.id}`
                      : `m:${row.hit.messageId}`;
                return (
                  <button
                    key={key}
                    type="button"
                    className={`qs-row ${isActive ? 'active' : ''}`}
                    data-active={isActive || undefined}
                    disabled={busy}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => void pick(row)}
                  >
                    {row.kind === 'conversation' && <ConversationRow conv={row.conv} />}
                    {row.kind === 'person' && <PersonRow user={row.user} />}
                    {row.kind === 'message' && <MessageRow hit={row.hit} />}
                  </button>
                );
              })}
            </div>
          ))}
          {flat.length === 0 && (
            <div className="qs-empty">
              {term.length === 0
                ? 'No conversations yet'
                : searching
                  ? 'Searching…'
                  : `Nothing found for “${term}”`}
            </div>
          )}
        </div>

        <div className="qs-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> navigate
          </span>
          <span>
            <kbd>↵</kbd> open
          </span>
          <span>
            <kbd>esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}

function ConversationRow(props: { conv: Conversation }) {
  const { conv } = props;
  const isDm = conv.type === 'dm';
  const name = conversationLabel(conv);
  return (
    <>
      <Avatar
        kind={isDm ? 'person' : 'place'}
        name={name}
        url={isDm ? conv.otherUser?.avatarUrl : conv.avatarUrl}
        size={34}
      />
      <div className="qs-row-main">
        <div className="qs-row-title">{name}</div>
        {!isDm && (
          <div className="qs-row-sub">
            {conv.handle ? `@${conv.handle} · ` : ''}
            {conv.memberCount} member{conv.memberCount === 1 ? '' : 's'}
          </div>
        )}
        {isDm && conv.otherUser?.username && (
          <div className="qs-row-sub">@{conv.otherUser.username}</div>
        )}
      </div>
      {(conv.self?.unreadCount ?? 0) > 0 && (
        <span className="qs-unread">{conv.self!.unreadCount}</span>
      )}
    </>
  );
}

function PersonRow(props: { user: SearchUser }) {
  const { user } = props;
  const name = user.displayName ?? user.username ?? 'Someone';
  // A search payload that predates badge fields still carries isVerified.
  const marks = heldBadges(user);
  if (marks.length === 0 && user.isVerified) marks.push('verified');
  return (
    <>
      <Avatar kind="person" name={name} url={user.avatarUrl} size={34} />
      <div className="qs-row-main">
        <div className="qs-row-title">
          {name}
          <BadgeMarks badges={marks} size={12} max={1} />
          {user.isBot && <BotTag size={12} />}
        </div>
        {user.username && <div className="qs-row-sub">@{user.username}</div>}
      </div>
      <span className="qs-row-hint">
        <Icon name="chat" size={16} />
      </span>
    </>
  );
}

function MessageRow(props: { hit: MessageHit }) {
  const { hit } = props;
  const conv = getState().conversations.get(hit.conversationId);
  const isDm = conv?.type === 'dm';
  const where = conversationName(hit.conversationId);
  return (
    <>
      <Avatar
        kind={isDm ? 'person' : 'place'}
        name={where}
        url={isDm ? conv?.otherUser?.avatarUrl : (conv?.avatarUrl ?? null)}
        size={34}
      />
      <div className="qs-row-main">
        <div className="qs-row-title qs-msg-head">
          <span>{senderName(hit)}</span>
          <span className="qs-msg-where">in {where}</span>
        </div>
        <div className="qs-row-sub qs-msg-snippet">
          <Snippet text={hit.snippet} />
        </div>
      </div>
      <span className="qs-row-time">{formatWhen(hit.createdAt)}</span>
    </>
  );
}
