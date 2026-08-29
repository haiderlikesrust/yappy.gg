/**
 * REST actions for the chat surface.
 *
 * Everything here goes through `api` (auth + refresh handled) and writes back
 * into the store via `mutate`/`patchMessage`. The gateway echoes most of these
 * as events too; local patches exist so the actor sees the result immediately
 * even on a slow socket, and the WS upsert-by-id makes the echo idempotent.
 */

import { api } from '../../lib/api';
import { isPrivate, sealFor } from '../../lib/e2e';
import {
  conversationMemberIds,
  gateway,
  getState,
  mutate,
  patchMessage,
  unlock,
} from '../../state/store';
import type { Message } from '../../lib/types';

function insertInOrder(list: Message[], msg: Message): void {
  if (list.some((m) => m.id === msg.id)) return;
  let at = list.length;
  while (at > 0 && !list[at - 1]!.pending && list[at - 1]!.seq > msg.seq) at -= 1;
  list.splice(at, 0, msg);
}

export interface ChatSendOptions {
  replyTo?: Message | null;
  /** Confirmed media ids, in tray order. */
  attachmentIds?: string[];
  /** Picked GIF, in the exact sendMessageBody.gif shape. */
  gif?: unknown;
  stickerId?: string;
  /** Mention entities computed at send time. */
  entities?: Array<{ type: 'mention'; offset: number; length: number; userId: string }>;
  /** Starts or continues a thread under this root message. */
  threadRootId?: string;
  /** Overrides the inferred message type (poll, audio, …). */
  type?: string;
  /** The sendMessageBody.poll shape, with `type: 'poll'`. */
  poll?: {
    question: string;
    options: string[];
    multiSelect: boolean;
    anonymous: boolean;
    closesAt: string | null;
  };
}

/**
 * The one send path for the composer: optimistic pending row, nonce
 * idempotency, and every payload kind the composer can produce.
 */
export async function sendChatMessage(
  conversationId: string,
  content: string | null,
  opts: ChatSendOptions = {},
): Promise<void> {
  const me = getState().me;
  if (!me) return;
  const nonce = crypto.randomUUID();
  const { replyTo } = opts;

  const type =
    opts.type ??
    (opts.stickerId
      ? 'sticker'
      : opts.gif
        ? 'gif'
        : (opts.attachmentIds?.length ?? 0) > 0
          ? 'image'
          : 'text');

  const pending: Message = {
    id: `pending:${nonce}`,
    conversationId,
    seq: Number.MAX_SAFE_INTEGER,
    type,
    content,
    sender: me,
    senderId: me.id,
    attachments: [],
    createdAt: new Date().toISOString(),
    pending: true,
    replyTo: replyTo
      ? {
          id: replyTo.id,
          seq: replyTo.seq,
          senderId: replyTo.senderId,
          content: replyTo.content,
          sender: replyTo.sender,
        }
      : null,
    ...(opts.threadRootId ? { threadRootId: opts.threadRootId } : {}),
    // A picked GIF renders from its URL right away — the pending row should
    // show the GIF, not an empty bubble waiting on the echo.
    ...(opts.gif ? { gif: opts.gif as Message['gif'] } : {}),
    // Mention chips light up on the optimistic row too.
    ...(opts.entities?.length ? { entities: opts.entities } : {}),
  };

  mutate((s) => {
    const list = s.messages.get(conversationId) ?? [];
    list.push(pending);
    s.messages.set(conversationId, list);
  });

  /**
   * A private send, when this conversation is flagged and the build allows
   * it. `sealed` is null whenever there is nobody to encrypt to — no keys, no
   * flag, not a dev build — and the send falls back to the clear, which is
   * better than posting something nobody in the room can read.
   *
   * Text only, and deliberately: an attachment is bytes in object storage
   * that this seals nothing of, and a poll is a server-side tally. Sealing
   * the caption of a photo anybody can fetch would be theatre.
   */
  const sealed =
    content && type === 'text' && isPrivate(conversationId)
      ? await sealFor(conversationMemberIds(conversationId), content)
      : null;

  try {
    const res = await api<{ message: Message }>(`/conversations/${conversationId}/messages`, {
      method: 'POST',
      body: {
        nonce,
        type,
        content: sealed ? sealed.content : content,
        ...(sealed ? { envelopes: sealed.envelopes } : {}),
        ...(replyTo ? { replyToId: replyTo.id } : {}),
        ...(opts.attachmentIds?.length ? { attachmentIds: opts.attachmentIds } : {}),
        ...(opts.gif ? { gif: opts.gif } : {}),
        ...(opts.stickerId ? { stickerId: opts.stickerId } : {}),
        ...(opts.entities?.length ? { entities: opts.entities } : {}),
        ...(opts.threadRootId ? { threadRootId: opts.threadRootId } : {}),
        ...(opts.poll ? { poll: opts.poll } : {}),
      },
    });
    // The 201 carries this device's own copy of what it just sealed. Opened
    // here, before the row is drawn, for the same reason history is.
    await unlock([res.message]);

    mutate((s) => {
      const current = s.messages.get(conversationId) ?? [];
      const without = current.filter((m) => m.id !== pending.id);
      insertInOrder(without, res.message);
      s.messages.set(conversationId, without);
      const conv = s.conversations.get(conversationId);
      if (conv) {
        conv.latestSeq = Math.max(conv.latestSeq, res.message.seq);
        conv.lastMessageAt = res.message.createdAt;
        conv.lastMessage = { content: res.message.content, sender: res.message.sender };
        if (conv.self) {
          conv.self.lastReadSeq = Math.max(conv.self.lastReadSeq, res.message.seq);
          conv.self.unreadCount = 0;
        }
      }
    });
    gateway.cursors.set(
      conversationId,
      Math.max(gateway.cursors.get(conversationId) ?? 0, res.message.seq),
    );
  } catch (err) {
    mutate((s) => {
      const current = s.messages.get(conversationId) ?? [];
      const idx = current.findIndex((m) => m.id === pending.id);
      if (idx !== -1) current[idx] = { ...current[idx]!, pending: false, failed: true };
    });
    console.error('send failed', err);
  }
}

/** Toggle a reaction: mine → remove (emoji rides the query string), else add. */
export async function toggleReaction(
  conversationId: string,
  message: Message,
  emoji: string,
): Promise<void> {
  const mine = message.myReactions?.includes(emoji) ?? false;
  const base = `/conversations/${conversationId}/messages/${message.id}/reactions`;

  // Optimistic: the chip moves under the click; the WS echo is made
  // idempotent against this in the store's ReactionAdd/Remove handler.
  patchMessage(conversationId, message.id, (m) => {
    const counts = { ...(m.reactions ?? {}) };
    const my = new Set(m.myReactions ?? []);
    if (mine) {
      const next = (counts[emoji] ?? 1) - 1;
      if (next <= 0) delete counts[emoji];
      else counts[emoji] = next;
      my.delete(emoji);
    } else {
      counts[emoji] = (counts[emoji] ?? 0) + 1;
      my.add(emoji);
    }
    m.reactions = counts;
    m.myReactions = [...my];
  });

  try {
    if (mine) {
      await api(`${base}?emoji=${encodeURIComponent(emoji)}`, { method: 'DELETE' });
    } else {
      await api(base, { method: 'PUT', body: { emoji } });
    }
  } catch (err) {
    // Roll the optimistic move back.
    patchMessage(conversationId, message.id, (m) => {
      const counts = { ...(m.reactions ?? {}) };
      const my = new Set(m.myReactions ?? []);
      if (mine) {
        counts[emoji] = (counts[emoji] ?? 0) + 1;
        my.add(emoji);
      } else {
        const next = (counts[emoji] ?? 1) - 1;
        if (next <= 0) delete counts[emoji];
        else counts[emoji] = next;
        my.delete(emoji);
      }
      m.reactions = counts;
      m.myReactions = [...my];
    });
    console.error('reaction toggle failed', err);
  }
}

export async function editMessage(
  conversationId: string,
  messageId: string,
  content: string,
): Promise<void> {
  const res = await api<{ message: Message }>(
    `/conversations/${conversationId}/messages/${messageId}`,
    { method: 'PATCH', body: { content } },
  );
  patchMessage(conversationId, messageId, (m) => {
    m.content = res.message.content;
    m.editedAt = res.message.editedAt ?? new Date().toISOString();
  });
}

/**
 * Delete. `forEveryone: true` (own messages) tombstones for the whole room;
 * `false` hides it for this account only — the query string carries the flag
 * (deleteMessageQuery parses the literal 'true'/'false'), and the local copy
 * is removed outright rather than tombstoned, matching what history will
 * return on the next load.
 */
export async function deleteMessage(
  conversationId: string,
  messageId: string,
  forEveryone = true,
): Promise<void> {
  await api(
    `/conversations/${conversationId}/messages/${messageId}?forEveryone=${forEveryone ? 'true' : 'false'}`,
    { method: 'DELETE' },
  );
  if (forEveryone) {
    patchMessage(conversationId, messageId, (m) => {
      m.content = null;
      m.attachments = [];
      m.deletedAt = new Date().toISOString();
    });
  } else {
    mutate((s) => {
      const list = s.messages.get(conversationId);
      if (list) s.messages.set(conversationId, list.filter((m) => m.id !== messageId));
    });
  }
}

export async function setPinned(
  conversationId: string,
  messageId: string,
  pinned: boolean,
): Promise<void> {
  await api(`/conversations/${conversationId}/pins/${messageId}`, {
    method: pinned ? 'PUT' : 'DELETE',
  });
  patchMessage(conversationId, messageId, (m) => {
    m.isPinned = pinned;
  });
}

/**
 * Vote in a poll. The body is `{optionIds}` with replace semantics — an empty
 * array retracts. The response carries fresh tallies as
 * `{options: [{id, voteCount}]}` which we fold back into the local poll.
 */
export async function votePoll(
  conversationId: string,
  messageId: string,
  optionIds: string[],
): Promise<void> {
  const res = await api<{ ok: boolean; options: Array<{ id: string; voteCount: number }> }>(
    `/conversations/${conversationId}/messages/${messageId}/poll/vote`,
    { method: 'POST', body: { optionIds } },
  );
  const chosen = new Set(optionIds);
  patchMessage(conversationId, messageId, (m) => {
    if (!m.poll) return;
    const tally = new Map(res.options.map((o) => [o.id, o.voteCount]));
    m.poll = {
      ...m.poll,
      options: m.poll.options.map((o) => ({
        ...o,
        votes: tally.get(o.id) ?? o.votes,
        me: chosen.has(o.id),
      })),
      myVotes: optionIds,
    };
  });
}

export async function closePoll(conversationId: string, messageId: string): Promise<void> {
  await api(`/conversations/${conversationId}/messages/${messageId}/poll/close`, {
    method: 'POST',
    body: {},
  });
  patchMessage(conversationId, messageId, (m) => {
    if (m.poll) m.poll = { ...m.poll, closedAt: new Date().toISOString() };
  });
}

/**
 * Press a bot button. Body is `{customId}`; the response is `{message}` —
 * usually the pressed message rewritten by the bot. Applied by id: replace if
 * we hold it, insert in seq order if it is a brand-new message.
 */
export async function pressMessageButton(
  conversationId: string,
  messageId: string,
  customId: string,
): Promise<void> {
  const res = await api<{ message?: Message | null }>(
    `/conversations/${conversationId}/messages/${messageId}/interactions`,
    { method: 'POST', body: { customId } },
  );
  const updated = res.message;
  if (!updated?.id) return;
  mutate((s) => {
    const list = s.messages.get(updated.conversationId ?? conversationId);
    if (!list) return;
    const idx = list.findIndex((m) => m.id === updated.id);
    if (idx !== -1) list[idx] = { ...list[idx]!, ...updated };
    else insertInOrder(list, updated);
  });
}

// ── Fetch-only shapes ────────────────────────────────────────────────────────

export interface SlashCommand {
  name: string;
  description: string;
  usage: string;
  botId: string;
  botUsername: string | null;
  botAvatarUrl: string | null;
}

export async function fetchCommands(conversationId: string): Promise<SlashCommand[]> {
  const res = await api<{ commands: SlashCommand[] }>(`/conversations/${conversationId}/commands`);
  return res.commands;
}

export interface MentionCandidate {
  userId: string;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  isBot: boolean;
}

/** The room's people, for @mention autocomplete. Cached by the composer. */
export async function fetchMentionCandidates(
  conversationId: string,
): Promise<MentionCandidate[]> {
  const res = await api<{
    members: Array<{
      user: { id: string; username: string | null; displayName: string | null; avatarUrl: string | null; isBot: boolean };
    }>;
  }>(`/conversations/${conversationId}/members?limit=100`);
  return res.members.map((m) => ({
    userId: m.user.id,
    username: m.user.username,
    displayName: m.user.displayName,
    avatarUrl: m.user.avatarUrl,
    isBot: m.user.isBot,
  }));
}

export interface PinEntry {
  message: Message;
  position: number;
  pinnedAt: string;
}

export async function fetchPins(conversationId: string): Promise<PinEntry[]> {
  const res = await api<{ pins: PinEntry[] }>(`/conversations/${conversationId}/pins`);
  return res.pins;
}

/**
 * Translate one message into the viewer's browser language, shown inline
 * under the original. Calling it again while a translation is up hides it —
 * the button is a toggle, and hiding costs nothing.
 */
export async function translateMessage(conversationId: string, message: Message): Promise<void> {
  if (message.translation && !message.translation.pending) {
    patchMessage(conversationId, message.id, (m) => (m.translation = null));
    return;
  }
  const to = navigator.language || 'English';
  patchMessage(conversationId, message.id, (m) => {
    m.translation = { text: '', detected: '', pending: true };
  });
  try {
    const res = await api<{ translation: string; detected: string }>(
      `/conversations/${conversationId}/messages/${message.id}/translate`,
      { method: 'POST', body: { to } },
    );
    patchMessage(conversationId, message.id, (m) => {
      m.translation = { text: res.translation, detected: res.detected };
    });
  } catch (err) {
    patchMessage(conversationId, message.id, (m) => (m.translation = null));
    console.error('translate failed', err);
  }
}
