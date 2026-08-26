import { Event, type EventName, type ReadyData } from '@yappy/shared';
import { useSyncExternalStore } from 'react';
import { api, auth } from '../lib/api';
import { GatewayClient, type GatewayStatus } from '../lib/gateway';
import type { Conversation, Message, Self } from '../lib/types';

/**
 * One store for the whole app.
 *
 * A chat client's state is a graph the socket mutates from one side and the
 * UI reads from the other; a single external store with one change counter is
 * the simplest thing that keeps both honest. Components subscribe through
 * `useStore`, which re-renders them on any change — at this app's size that
 * is cheaper to run than fine-grained subscriptions are to maintain.
 */

interface State {
  me: Self | null;
  status: GatewayStatus;
  conversations: Map<string, Conversation>;
  /** seq-ascending per conversation; pending sends ride at the tail. */
  messages: Map<string, Message[]>;
  historyLoaded: Set<string>;
  hasMoreHistory: Map<string, boolean>;
  typing: Map<string, Map<string, number>>; // convId → userId → expiry epoch ms
  online: Map<string, string>; // userId → status
  selectedId: string | null;
}

const state: State = {
  me: auth.user,
  status: 'offline',
  conversations: new Map(),
  messages: new Map(),
  historyLoaded: new Set(),
  hasMoreHistory: new Map(),
  typing: new Map(),
  online: new Map(),
  selectedId: null,
};

let version = 0;
const listeners = new Set<() => void>();

function notify(): void {
  version += 1;
  for (const fn of listeners) fn();
}

export function useStore(): { version: number; state: State } {
  const v = useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => version,
  );
  return { version: v, state };
}

export const getState = (): State => state;

// ─── Gateway wiring ──────────────────────────────────────────────────────────

export const gateway = new GatewayClient({
  getToken: async () => {
    // A cheap authenticated call first: it transparently refreshes an expired
    // access token, so the socket always identifies with a live one.
    if (!auth.isSignedIn) return null;
    try {
      await api('/users/me');
    } catch {
      /* the token itself may still be fine; let identify decide */
    }
    return auth.accessToken;
  },
  onReady: (ready) => void onReady(ready),
  onEvent: (event, data) => onEvent(event, data),
  onStatusChange: (status) => {
    state.status = status;
    notify();
  },
});

async function onReady(ready: ReadyData): Promise<void> {
  // READY is a delta against our cursors; the REST list is the full picture.
  // On first connect the cursors are empty so READY ≈ everything, but the
  // REST shapes are richer (avatars, otherUser, previews) — fetch and merge.
  await loadConversations();
  for (const removed of ready.removedConversations) {
    state.conversations.delete(removed);
    state.messages.delete(removed);
  }
  notify();
}

function conversationOf(data: unknown): Conversation {
  return data as Conversation;
}

function onEvent(event: EventName, data: unknown): void {
  switch (event) {
    case Event.MessageCreate: {
      const msg = data as Message;
      upsertMessage(msg);
      const conv = state.conversations.get(msg.conversationId);
      if (conv) {
        conv.latestSeq = Math.max(conv.latestSeq, msg.seq);
        conv.lastMessageAt = msg.createdAt;
        conv.lastMessage = { content: msg.content, sender: msg.sender };
        if (conv.self && msg.senderId !== state.me?.id) {
          if (state.selectedId === msg.conversationId && document.hasFocus()) {
            conv.self.lastReadSeq = msg.seq;
            conv.self.unreadCount = 0;
            gateway.readAck(msg.conversationId, msg.seq);
          } else {
            conv.self.unreadCount += 1;
          }
        }
      }
      gateway.cursors.set(msg.conversationId, msg.seq);
      if (msg.senderId !== state.me?.id) gateway.deliveryAck(msg.conversationId, msg.seq);
      // A message is also the end of that person's typing.
      state.typing.get(msg.conversationId)?.delete(msg.senderId);
      notify();
      return;
    }

    case Event.MessageUpdate: {
      const msg = data as Message;
      upsertMessage(msg);
      notify();
      return;
    }

    case Event.MessageDelete: {
      const d = data as { conversationId: string; messageId?: string; id?: string };
      const id = d.messageId ?? d.id;
      const list = state.messages.get(d.conversationId);
      if (list && id) {
        const idx = list.findIndex((m) => m.id === id);
        if (idx !== -1) {
          const target = list[idx]!;
          list[idx] = { ...target, content: null, attachments: [], deletedAt: new Date().toISOString() };
        }
      }
      notify();
      return;
    }

    case Event.TypingStart: {
      const d = data as { conversationId: string; userId: string; expiresAt: string };
      if (d.userId === state.me?.id) return;
      const map = state.typing.get(d.conversationId) ?? new Map<string, number>();
      map.set(d.userId, Date.parse(d.expiresAt));
      state.typing.set(d.conversationId, map);
      notify();
      return;
    }

    case Event.TypingStop: {
      const d = data as { conversationId: string; userId: string };
      state.typing.get(d.conversationId)?.delete(d.userId);
      notify();
      return;
    }

    case Event.ConversationCreate: {
      const conv = conversationOf(data);
      state.conversations.set(conv.id, { ...state.conversations.get(conv.id), ...conv });
      // The session is only auto-subscribed to conversations that existed at
      // IDENTIFY; a new one's topic must be joined by hand or its messages
      // never stream (see GatewayClient.subscribe).
      gateway.subscribe(conv.id);
      notify();
      return;
    }

    case Event.ConversationUpdate: {
      const conv = conversationOf(data);
      const existing = state.conversations.get(conv.id);
      state.conversations.set(conv.id, existing ? { ...existing, ...conv } : conv);
      notify();
      return;
    }

    case Event.ConversationDelete: {
      const d = data as { conversationId?: string; id?: string };
      const id = d.conversationId ?? d.id;
      if (id) {
        state.conversations.delete(id);
        state.messages.delete(id);
        if (state.selectedId === id) state.selectedId = null;
      }
      notify();
      return;
    }

    case Event.ConversationStateUpdate: {
      const d = data as {
        conversationId: string;
        lastReadSeq?: number;
        unreadCount?: number;
        mentionCount?: number;
      };
      const conv = state.conversations.get(d.conversationId);
      if (conv?.self) {
        if (d.lastReadSeq !== undefined) conv.self.lastReadSeq = d.lastReadSeq;
        if (d.unreadCount !== undefined) conv.self.unreadCount = d.unreadCount;
        if (d.mentionCount !== undefined) conv.self.mentionCount = d.mentionCount;
      }
      notify();
      return;
    }

    case Event.PresenceUpdate: {
      const d = data as { userId: string; status: string };
      if (d.status === 'offline') state.online.delete(d.userId);
      else state.online.set(d.userId, d.status);
      notify();
      return;
    }

    case Event.ReactionAdd:
    case Event.ReactionRemove: {
      const d = data as { conversationId: string; messageId: string; emoji: string; userId: string };
      const list = state.messages.get(d.conversationId);
      const msg = list?.find((m) => m.id === d.messageId);
      if (msg) {
        const reactions = msg.reactions ? [...msg.reactions] : [];
        const idx = reactions.findIndex((r) => r.emoji === d.emoji);
        const mine = d.userId === state.me?.id;
        if (event === Event.ReactionAdd) {
          if (idx === -1) reactions.push({ emoji: d.emoji, count: 1, me: mine });
          else reactions[idx] = { ...reactions[idx]!, count: reactions[idx]!.count + 1, me: reactions[idx]!.me || mine };
        } else if (idx !== -1) {
          const next = { ...reactions[idx]!, count: reactions[idx]!.count - 1, me: reactions[idx]!.me && !mine };
          if (next.count <= 0) reactions.splice(idx, 1);
          else reactions[idx] = next;
        }
        msg.reactions = reactions;
      }
      notify();
      return;
    }

    default:
      return;
  }
}

function upsertMessage(msg: Message): void {
  const list = state.messages.get(msg.conversationId);
  if (!list) return; // History not loaded — it will arrive with the fetch.
  const byId = list.findIndex((m) => m.id === msg.id);
  if (byId !== -1) {
    list[byId] = { ...list[byId], ...msg, pending: false };
    return;
  }
  // Insert in seq order (events can outrun a history fetch).
  let at = list.length;
  while (at > 0 && !list[at - 1]!.pending && list[at - 1]!.seq > msg.seq) at -= 1;
  list.splice(at, 0, msg);
}

// ─── Actions ─────────────────────────────────────────────────────────────────

export async function bootstrap(): Promise<void> {
  try {
    const res = await api<{ user: Self }>('/users/me');
    state.me = res.user;
    auth.setUser(res.user);
  } catch {
    /* the 401 path signs out via auth.handleSignedOut */
  }
  notify();
  gateway.connect();
}

export async function loadConversations(): Promise<void> {
  const res = await api<{ conversations?: Conversation[] } | Conversation[]>('/conversations?limit=100');
  const list = Array.isArray(res) ? res : (res.conversations ?? []);
  for (const conv of list) {
    const existing = state.conversations.get(conv.id);
    state.conversations.set(conv.id, existing ? { ...existing, ...conv } : conv);
    gateway.cursors.set(conv.id, conv.latestSeq ?? 0);
  }
  notify();
}

export async function selectConversation(id: string | null): Promise<void> {
  state.selectedId = id;
  gateway.viewing(id);
  notify();
  if (!id) return;

  // Belt and braces alongside the ConversationCreate handler: opening a room
  // makes sure its topic is subscribed. Redundant when IDENTIFY already did
  // it; the command is cheap and membership-checked server-side.
  gateway.subscribe(id);

  if (!state.historyLoaded.has(id)) {
    const res = await api<{ messages: Message[]; hasMore?: boolean }>(
      `/conversations/${id}/messages?limit=60`,
    );
    const existing = state.messages.get(id) ?? [];
    // Anything realtime delivered while history was in flight wins by id.
    const seen = new Set(res.messages.map((m) => m.id));
    const merged = [...res.messages, ...existing.filter((m) => !seen.has(m.id))];
    merged.sort((a, b) => (a.pending ? 1 : b.pending ? -1 : a.seq - b.seq));
    state.messages.set(id, merged);
    state.historyLoaded.add(id);
    state.hasMoreHistory.set(id, res.hasMore ?? false);
  }

  const conv = state.conversations.get(id);
  if (conv) {
    const latest = Math.max(conv.latestSeq, state.messages.get(id)?.at(-1)?.seq ?? 0);
    if (conv.self) {
      conv.self.lastReadSeq = latest;
      conv.self.unreadCount = 0;
      conv.self.mentionCount = 0;
    }
    if (latest > 0) gateway.readAck(id, latest);
  }
  notify();
}

export async function loadOlder(conversationId: string): Promise<void> {
  const list = state.messages.get(conversationId);
  const oldest = list?.find((m) => !m.pending);
  if (!oldest) return;
  const res = await api<{ messages: Message[]; hasMore?: boolean }>(
    `/conversations/${conversationId}/messages?limit=60&before=${oldest.seq}`,
  );
  const seen = new Set(list!.map((m) => m.id));
  state.messages.set(conversationId, [
    ...res.messages.filter((m) => !seen.has(m.id)),
    ...list!,
  ]);
  state.hasMoreHistory.set(conversationId, res.hasMore ?? false);
  notify();
}

export async function sendMessage(conversationId: string, content: string): Promise<void> {
  const me = state.me;
  if (!me) return;
  const nonce = crypto.randomUUID();

  const pending: Message = {
    id: `pending:${nonce}`,
    conversationId,
    seq: Number.MAX_SAFE_INTEGER,
    type: 'text',
    content,
    sender: me,
    senderId: me.id,
    attachments: [],
    createdAt: new Date().toISOString(),
    pending: true,
  };
  const list = state.messages.get(conversationId) ?? [];
  list.push(pending);
  state.messages.set(conversationId, list);
  notify();

  try {
    const res = await api<{ message: Message }>(`/conversations/${conversationId}/messages`, {
      method: 'POST',
      body: { nonce, type: 'text', content },
    });
    const current = state.messages.get(conversationId) ?? [];
    const withoutPending = current.filter((m) => m.id !== pending.id);
    state.messages.set(conversationId, withoutPending);
    upsertMessage(res.message);
    gateway.cursors.set(conversationId, res.message.seq);
    const conv = state.conversations.get(conversationId);
    if (conv) {
      conv.latestSeq = Math.max(conv.latestSeq, res.message.seq);
      conv.lastMessageAt = res.message.createdAt;
      conv.lastMessage = { content: res.message.content, sender: res.message.sender };
      if (conv.self) {
        conv.self.lastReadSeq = res.message.seq;
        conv.self.unreadCount = 0;
      }
    }
  } catch (err) {
    const current = state.messages.get(conversationId) ?? [];
    const idx = current.findIndex((m) => m.id === pending.id);
    if (idx !== -1) current[idx] = { ...current[idx]!, pending: false, failed: true };
    console.error('send failed', err);
  }
  notify();
}

/** Prune expired typing entries; called on an interval from the app shell. */
export function pruneTyping(): void {
  const now = Date.now();
  let changed = false;
  for (const map of state.typing.values()) {
    for (const [userId, expiry] of map) {
      if (expiry < now) {
        map.delete(userId);
        changed = true;
      }
    }
  }
  if (changed) notify();
}

export function signedOutReset(): void {
  gateway.disconnect();
  state.me = null;
  state.conversations.clear();
  state.messages.clear();
  state.historyLoaded.clear();
  state.typing.clear();
  state.online.clear();
  state.selectedId = null;
  state.status = 'offline';
  notify();
}
