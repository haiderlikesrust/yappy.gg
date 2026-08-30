import { Event, type EventName, type ReadyData } from '@yappy/shared';
import { useSyncExternalStore } from 'react';
import { api, auth, currentDeviceId } from '../lib/api';
import { decrypt } from '../lib/e2e';
import { forget } from '../lib/plaintext';
import { ensureDeviceKeys } from '../lib/keys';
import { GatewayClient, type GatewayStatus } from '../lib/gateway';
import { desktopBadge } from '../lib/desktop';
import { setTitleBadge, showMessageNotification } from '../lib/notify';
import type { Conversation, Message, PublicUser, Self } from '../lib/types';

/** Who is inside a voice channel — the wire adds a live mute flag. */
export type VoiceParticipant = PublicUser & { isMuted?: boolean };

/**
 * One store for the whole app.
 *
 * A chat client's state is a graph the socket mutates from one side and the
 * UI reads from the other; a single external store with one change counter is
 * the simplest thing that keeps both honest. Components subscribe through
 * `useStore`, which re-renders them on any change — at this app's size that
 * is cheaper to run than fine-grained subscriptions are to maintain.
 */

export type AppView = 'chats' | 'explore' | 'settings' | 'saved';

interface State {
  me: Self | null;
  status: GatewayStatus;
  view: AppView;
  conversations: Map<string, Conversation>;
  /** seq-ascending per conversation; pending sends ride at the tail. */
  messages: Map<string, Message[]>;
  historyLoaded: Set<string>;
  hasMoreHistory: Map<string, boolean>;
  typing: Map<string, Map<string, number>>; // convId → userId → expiry epoch ms
  online: Map<string, string>; // userId → status
  /** Ambient co-presence: who is sitting in each room right now. */
  viewers: Map<string, Set<string>>;
  /** Voice-channel rosters, keyed by channel id — voice.state snapshots. */
  voice: Map<string, VoiceParticipant[]>;
  /**
   * Receipt cursors per conversation: how far each *other* member has read
   * and received. Fed by ReadReceipt/DeliveryReceipt events and seeded from
   * GET /:id/receipts when a surface needs the full picture. Drives the
   * ticks on own messages and the seen-by sheet.
   */
  readBy: Map<string, Map<string, number>>;
  deliveredTo: Map<string, Map<string, number>>;
  /** Unsent composer text per conversation, so switching rooms loses nothing. */
  drafts: Map<string, string>;
  /**
   * True when the message list shows an around-a-message window rather than
   * the live tail — paging and the bottom-pin behave differently there.
   */
  detached: Set<string>;
  selectedId: string | null;
}

const state: State = {
  me: auth.user,
  status: 'offline',
  view: 'chats',
  conversations: new Map(),
  messages: new Map(),
  historyLoaded: new Set(),
  hasMoreHistory: new Map(),
  typing: new Map(),
  online: new Map(),
  viewers: new Map(),
  voice: new Map(),
  readBy: new Map(),
  deliveredTo: new Map(),
  drafts: new Map(),
  detached: new Set(),
  selectedId: null,
};

let version = 0;
const listeners = new Set<() => void>();

function notify(): void {
  version += 1;
  // The tab badge rides every store change — unread math is already here.
  // Archived rooms sit on their shelf without shouting.
  let unread = 0;
  for (const c of state.conversations.values()) {
    if (!c.self?.isArchived) unread += c.self?.unreadCount ?? 0;
  }
  setTitleBadge(unread);
  desktopBadge(unread);
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

/**
 * The one write path for feature modules.
 *
 * Feature code (media, groups, profile, explore) lives in its own files and
 * must not grow this one — it mutates through here instead. The callback runs
 * against the live state and every subscriber re-renders after it. Keep the
 * callbacks synchronous; do the awaiting outside and mutate with the result.
 */
export function mutate(fn: (s: State) => void): void {
  fn(state);
  notify();
}

/** Patch one message in place, if the client holds it. No-op otherwise. */
export function patchMessage(
  conversationId: string,
  messageId: string,
  fn: (m: Message) => void,
): void {
  const list = state.messages.get(conversationId);
  const idx = list?.findIndex((m) => m.id === messageId) ?? -1;
  if (list && idx !== -1) {
    fn(list[idx]!);
    notify();
  }
}

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

      // A live encrypted message arrives without a body: the event is one
      // broadcast and every device needs a different ciphertext. Unawaited —
      // the bubble renders locked and unlocks when this lands, which is a
      // better first frame than a delayed message. Patched by id rather than
      // mutated: `upsertMessage` may have merged this into an existing row.
      if (msg.isEncrypted) {
        void unlock([msg]).then(() =>
          patchMessage(msg.conversationId, msg.id, (m) => {
            m.ciphertext = msg.ciphertext;
            m.plaintext = msg.plaintext;
          }),
        );
      }
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

      // Desktop notification — only for messages the person is not looking
      // at: another room, or this room in a blurred tab. Muted rooms stay
      // silent.
      if (msg.senderId !== state.me?.id && conv && msg.type !== 'system') {
        const looking = state.selectedId === msg.conversationId && document.hasFocus();
        const muted = conv.self?.mutedUntil && Date.parse(conv.self.mutedUntil) > Date.now();
        if (!looking && !muted) {
          const room = conv.type === 'dm' ? null : (conv.title ?? 'a group');
          const who = msg.sender?.displayName ?? msg.sender?.username ?? 'someone';
          showMessageNotification({
            title: room ? `${who} · ${room}` : who,
            body: msg.content ?? (msg.attachments.length > 0 ? 'sent a photo' : 'sent something'),
            conversationId: msg.conversationId,
            icon: msg.sender?.avatarUrl,
            onClick: () => void selectConversation(msg.conversationId),
          });
        }
      }
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
      // The server drops the ciphertext; this drops the only readable copy.
      // A deleted encrypted message that stays legible on one device is a
      // deleted message that was not deleted.
      if (id) void forget(id);
      const list = state.messages.get(d.conversationId);
      if (list && id) {
        const idx = list.findIndex((m) => m.id === id);
        if (idx !== -1) {
          const target = list[idx]!;
          list[idx] = {
            ...target,
            content: null,
            plaintext: null,
            attachments: [],
            deletedAt: new Date().toISOString(),
          };
        }
      }
      notify();
      return;
    }

    case Event.ReadReceipt:
    case Event.DeliveryReceipt: {
      const d = data as { conversationId: string; userId: string; seq: number };
      if (d.userId === state.me?.id) return;
      const store = event === Event.ReadReceipt ? state.readBy : state.deliveredTo;
      const map = store.get(d.conversationId) ?? new Map<string, number>();
      map.set(d.userId, Math.max(map.get(d.userId) ?? 0, d.seq));
      store.set(d.conversationId, map);
      // Reading implies delivery, so the read event advances both cursors.
      if (event === Event.ReadReceipt) {
        const del = state.deliveredTo.get(d.conversationId) ?? new Map<string, number>();
        del.set(d.userId, Math.max(del.get(d.userId) ?? 0, d.seq));
        state.deliveredTo.set(d.conversationId, del);
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

    case Event.MessageBulkDelete: {
      const d = data as { conversationId: string; messageIds?: string[]; ids?: string[] };
      const ids = new Set(d.messageIds ?? d.ids ?? []);
      const list = state.messages.get(d.conversationId);
      if (list) {
        for (let i = 0; i < list.length; i += 1) {
          if (ids.has(list[i]!.id)) {
            list[i] = { ...list[i]!, content: null, attachments: [], deletedAt: new Date().toISOString() };
          }
        }
      }
      notify();
      return;
    }

    case Event.PinAdd:
    case Event.PinRemove: {
      const d = data as { conversationId: string; messageId: string };
      patchMessage(d.conversationId, d.messageId, (m) => {
        m.isPinned = event === Event.PinAdd;
      });
      return;
    }

    case Event.PollVote: {
      // The broadcast carries fresh tallies as {options: [{id, voteCount}]},
      // not a whole poll — fold them into the copy we hold.
      const d = data as {
        conversationId: string;
        messageId: string;
        poll?: Message['poll'];
        options?: Array<{ id: string; voteCount: number }>;
      };
      patchMessage(d.conversationId, d.messageId, (m) => {
        if (d.poll) {
          m.poll = d.poll;
          return;
        }
        if (!m.poll || !d.options) return;
        const tally = new Map(d.options.map((o) => [o.id, o.voteCount]));
        m.poll = {
          ...m.poll,
          options: m.poll.options.map((o) => ({ ...o, votes: tally.get(o.id) ?? o.votes })),
        };
      });
      return;
    }

    case Event.PollClose: {
      const d = data as { conversationId: string; messageId: string; poll?: Message['poll'] };
      patchMessage(d.conversationId, d.messageId, (m) => {
        if (d.poll) m.poll = d.poll;
        else if (m.poll) m.poll.closedAt = new Date().toISOString();
      });
      return;
    }

    case Event.MemberAdd:
    case Event.MemberRemove: {
      const d = data as { conversationId: string };
      const conv = state.conversations.get(d.conversationId);
      if (conv) conv.memberCount = Math.max(0, conv.memberCount + (event === Event.MemberAdd ? 1 : -1));
      notify();
      return;
    }

    case Event.ViewingUpdate: {
      const d = data as { conversationId: string; userId: string; viewing: boolean };
      const set = state.viewers.get(d.conversationId) ?? new Set<string>();
      if (d.viewing) set.add(d.userId);
      else set.delete(d.userId);
      state.viewers.set(d.conversationId, set);
      notify();
      return;
    }

    case Event.VoiceState: {
      // Full roster snapshots on the space topic — replace, never merge.
      const d = data as { channelId: string; participants: VoiceParticipant[] };
      state.voice.set(d.channelId, d.participants ?? []);
      notify();
      return;
    }

    case Event.BlockUpdate: {
      // {userId, blocked} on the actor's own topic. Blocking someone removes
      // their DM from the client's world; unblocking leaves rediscovery to a
      // fresh DM create or the next full load.
      const d = data as { userId: string; blocked: boolean };
      if (d.blocked) {
        for (const [id, conv] of state.conversations) {
          if (conv.type === 'dm' && conv.otherUser?.id === d.userId) {
            state.conversations.delete(id);
            state.messages.delete(id);
            state.historyLoaded.delete(id);
            if (state.selectedId === id) state.selectedId = null;
          }
        }
      }
      notify();
      return;
    }

    case Event.UserUpdate: {
      const d = data as Partial<Self> & { id: string };
      if (state.me && d.id === state.me.id) state.me = { ...state.me, ...d };
      notify();
      return;
    }

    case Event.ReactionAdd:
    case Event.ReactionRemove: {
      const d = data as { conversationId: string; messageId: string; emoji: string; userId: string };
      const list = state.messages.get(d.conversationId);
      const msg = list?.find((m) => m.id === d.messageId);
      if (msg) {
        const mine = d.userId === state.me?.id;
        const counts = { ...(msg.reactions ?? {}) };
        const my = new Set(msg.myReactions ?? []);
        if (event === Event.ReactionAdd) {
          // Idempotence against a local optimistic add: my own echo must not
          // count twice.
          if (!(mine && my.has(d.emoji))) counts[d.emoji] = (counts[d.emoji] ?? 0) + 1;
          if (mine) my.add(d.emoji);
        } else {
          if (!(mine && !my.has(d.emoji))) {
            const next = (counts[d.emoji] ?? 1) - 1;
            if (next <= 0) delete counts[d.emoji];
            else counts[d.emoji] = next;
          }
          if (mine) my.delete(d.emoji);
        }
        msg.reactions = counts;
        msg.myReactions = [...my];
      }
      notify();
      return;
    }

    default:
      return;
  }
}

/** This device's copy of an encrypted body, when it did not come with one. */
async function envelopeOf(msg: Message): Promise<string | null> {
  try {
    const res = await api<{ ciphertext: string | null }>(
      `/conversations/${msg.conversationId}/messages/${msg.id}/envelope`,
    );
    return res.ciphertext;
  } catch {
    return null;
  }
}

/**
 * Decrypt whatever in this batch is encrypted, before it is drawn.
 *
 * Every message enters the store through one of a handful of doors — a history
 * page, a jump, a live event, the response to a send — and this is called at
 * each of them. It could instead have been called from the bubble that draws
 * the text, which is where it lived when the cipher was a placeholder and
 * decryption was synchronous. It is not synchronous any more: it reads private
 * keys out of IndexedDB and sometimes fetches the sender's identity key. A
 * React component cannot await either, and a component that pretends to will
 * flash the locked state on every re-render.
 *
 * History arrives with the ciphertext already attached; a live event cannot
 * carry one, because it is a single broadcast and every device needs a
 * different copy, so that copy is fetched here.
 *
 * Most of the time nothing is decrypted at all: a ratchet message key is
 * destroyed as it is used, so a ciphertext opens exactly once on this device
 * and every reading after that comes from what was written down then.
 *
 * Failures are left as `null` rather than retried. The reasons a message does
 * not open — a copy for another device, a sender whose key cannot be checked —
 * do not improve by being asked again.
 */
export async function unlock(messages: Message[]): Promise<void> {
  const locked = messages.filter((m) => m.isEncrypted && m.plaintext === undefined);
  if (locked.length === 0) return;
  await Promise.all(
    locked.map(async (m) => {
      if (!m.ciphertext) m.ciphertext = await envelopeOf(m);
      m.plaintext = await decrypt(m.id, m.ciphertext, m.senderId);
    }),
  );
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

// ─── URL sync ────────────────────────────────────────────────────────────────
//
// Not a router, just honesty: the address bar names what is on screen
// (`/c/<id>`, `/explore`, `/you`), back/forward walk the history, and a
// pasted link lands where it says. Vite's dev server and any SPA fallback
// serve index.html for all of these.

function currentPath(): string {
  if (state.view === 'explore') return '/explore';
  if (state.view === 'settings') return '/you';
  if (state.view === 'saved') return '/saved';
  return state.selectedId ? `/c/${state.selectedId}` : '/';
}

export function syncUrl(): void {
  const path = currentPath();
  if (window.location.pathname !== path) window.history.pushState(null, '', path);
}

/** Make the screen match the address bar — on load and on back/forward. */
export async function applyUrl(): Promise<void> {
  const path = window.location.pathname;
  const conv = /^\/c\/([0-9a-fA-F-]{32,36})$/.exec(path);
  if (path === '/explore') {
    mutate((s) => {
      s.view = 'explore';
    });
  } else if (path === '/you') {
    mutate((s) => {
      s.view = 'settings';
    });
  } else if (path === '/saved') {
    mutate((s) => {
      s.view = 'saved';
    });
  } else if (conv) {
    mutate((s) => {
      s.view = 'chats';
    });
    await selectConversation(conv[1]!);
  } else {
    mutate((s) => {
      s.view = 'chats';
      s.selectedId = null;
    });
  }
}

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
  void applyUrl();

  /**
   * Publish this device's cryptographic identity, if it has not already.
   *
   * Deliberately after everything else and deliberately unawaited: it is
   * groundwork for encryption that does not exist yet, and it must never be
   * between somebody and their messages. See lib/keys.ts for why it is worth
   * doing before there is anything to decrypt.
   */
  const deviceId = currentDeviceId();
  if (deviceId && state.me) void ensureDeviceKeys(deviceId, state.me.id);
}

export async function loadConversations(
  opts: { archived?: boolean; hidden?: boolean } = {},
): Promise<void> {
  const res = await api<{ conversations?: Conversation[] } | Conversation[]>(
    `/conversations?limit=100${opts.archived ? '&archived=true' : ''}${opts.hidden ? '&hidden=true' : ''}`,
  );
  const list = Array.isArray(res) ? res : (res.conversations ?? []);
  for (const conv of list) {
    const existing = state.conversations.get(conv.id);
    state.conversations.set(conv.id, existing ? { ...existing, ...conv } : conv);
    gateway.cursors.set(conv.id, conv.latestSeq ?? 0);
  }
  notify();
}

/**
 * Jump to a message: replace the list with a window centred on `seq`. The
 * conversation is then *detached* — not anchored to the live tail — until
 * `resetToLatest` re-fetches the tail (the jump-to-latest pill's job there).
 */
export async function loadAround(conversationId: string, seq: number): Promise<void> {
  const res = await api<{ messages: Message[]; hasMore?: boolean }>(
    `/conversations/${conversationId}/messages?limit=60&around=${seq}`,
  );
  await unlock(res.messages);
  state.messages.set(conversationId, res.messages);
  state.historyLoaded.add(conversationId);
  state.hasMoreHistory.set(conversationId, true);
  state.detached.add(conversationId);
  notify();
}

export async function resetToLatest(conversationId: string): Promise<void> {
  const res = await api<{ messages: Message[]; hasMore?: boolean }>(
    `/conversations/${conversationId}/messages?limit=60`,
  );
  await unlock(res.messages);
  state.messages.set(conversationId, res.messages);
  state.hasMoreHistory.set(conversationId, res.hasMore ?? false);
  state.detached.delete(conversationId);
  notify();
}

export async function selectConversation(id: string | null): Promise<void> {
  // A space is a container, not a timeline — selecting one (Explore card, a
  // deep link, an old bookmark) lands in its first text channel. Done here,
  // in the one funnel every selection passes through, so no caller races
  // another to re-select the space id.
  const known = id ? state.conversations.get(id) : null;
  if (id && known?.type === 'space') {
    state.selectedId = id;
    state.view = 'chats';
    notify();
    syncUrl();
    // Deferred import: ui/space/lib already imports this store.
    const space = await import('../ui/space/lib');
    await space.loadChannels(id).catch(() => {});
    const first = space
      .channelsOf(state.conversations, id)
      .find((c) => !c.isVoice);
    // Somebody may have navigated away while channels loaded; don't yank.
    if (first && state.selectedId === id) return selectConversation(first.id);
    return;
  }

  state.selectedId = id;
  if (id) state.view = 'chats';
  gateway.viewing(id);
  notify();
  syncUrl();
  if (!id) return;

  // Belt and braces alongside the ConversationCreate handler: opening a room
  // makes sure its topic is subscribed. Redundant when IDENTIFY already did
  // it; the command is cheap and membership-checked server-side.
  gateway.subscribe(id);

  if (!state.historyLoaded.has(id)) {
    const res = await api<{ messages: Message[]; hasMore?: boolean }>(
      `/conversations/${id}/messages?limit=60`,
    );
    await unlock(res.messages);
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
  await unlock(res.messages);
  const seen = new Set(list!.map((m) => m.id));
  state.messages.set(conversationId, [
    ...res.messages.filter((m) => !seen.has(m.id)),
    ...list!,
  ]);
  state.hasMoreHistory.set(conversationId, res.hasMore ?? false);
  notify();
}


/**
 * The people a private message has to be readable by.
 *
 * A DM is the two of you; anything else is every member, which the client
 * does not always hold — so this returns what it knows and the send falls
 * back to the clear when that is not enough. Encrypted group messages are a
 * later problem and this is deliberately not pretending otherwise.
 */
export function conversationMemberIds(conversationId: string): string[] {
  const conv = state.conversations.get(conversationId);
  const me = state.me?.id;
  const other = conv?.otherUser?.id;
  return [me, other].filter((id): id is string => Boolean(id));
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
