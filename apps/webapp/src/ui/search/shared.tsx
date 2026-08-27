import type { ReactNode } from 'react';
import { getState } from '../../state/store';

/**
 * Shared plumbing for the search surfaces.
 *
 * Wire shapes, taken from apps/api/src/routes/search.ts:
 *
 *   GET /v1/search?q=          → { conversations: […], users: […], messages: [] }
 *     (messages is always empty there — FTS hits come from the endpoint below,
 *      kept separate so people/chats render without waiting on it)
 *   GET /v1/search/messages    → { results: MessageHit[], nextCursor }
 *     params: q (1..256), conversationId?, fromUserId?, hasAttachment?, type?,
 *             before?, after?, limit (≤50, default 25), cursor?
 */

export interface SearchUser {
  id: string;
  username: string | null;
  displayName: string | null;
  isVerified: boolean;
  avatarUrl: string | null;
  isBot?: boolean;
  badge?: string | null;
  badges?: string[];
}

export interface SearchConversation {
  id: string;
  type: string;
  title: string | null;
  memberCount: number;
  avatarUrl: string | null;
}

export interface MessageHit {
  messageId: string;
  conversationId: string;
  /** The jump anchor: deep-link the chat with ?around=<seq> via loadAround. */
  seq: number;
  senderId: string | null;
  type: string;
  /** ts_headline output — matches wrapped in <em>…</em>, otherwise raw text. */
  snippet: string;
  createdAt: string;
}

export interface UnifiedSearchResponse {
  conversations: SearchConversation[];
  users: SearchUser[];
  messages: MessageHit[];
}

export interface MessageSearchResponse {
  results: MessageHit[];
  nextCursor: string | null;
}

/**
 * Fuzzy score for local filtering: substring beats subsequence, earlier beats
 * later, word-start beats mid-word. `null` means no match at all.
 */
export function fuzzyScore(query: string, text: string | null | undefined): number | null {
  if (!text) return null;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (q.length === 0) return 0;

  const at = t.indexOf(q);
  if (at !== -1) {
    let score = 100 - Math.min(at, 40);
    if (at === 0) score += 40;
    else if (/[\s._-]/.test(t[at - 1] ?? '')) score += 20;
    return score;
  }

  // Subsequence with gaps — "ypg" matches "yappy pet group".
  let ti = 0;
  let gaps = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found === -1) return null;
    gaps += found - ti;
    ti = found + 1;
  }
  return Math.max(1, 30 - gaps);
}

/**
 * Render a ts_headline snippet, treating everything except the <em> markers as
 * literal text — message content is user input and must never hit innerHTML.
 */
export function Snippet(props: { text: string }) {
  const out: ReactNode[] = [];
  const re = /<em>(.*?)<\/em>/gs;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(props.text)) !== null) {
    if (m.index > last) out.push(props.text.slice(last, m.index));
    out.push(<mark key={key++}>{m[1]}</mark>);
    last = m.index + m[0].length;
  }
  if (last < props.text.length) out.push(props.text.slice(last));
  return <>{out}</>;
}

/**
 * Best-effort sender name for a message hit — the endpoint returns senderId
 * only. Me → "You"; a DM partner is on the conversation; otherwise scavenge
 * any loaded message from that sender.
 */
export function senderName(hit: Pick<MessageHit, 'senderId' | 'conversationId'>): string {
  const s = getState();
  if (!hit.senderId) return 'Someone';
  if (s.me?.id === hit.senderId) return 'You';
  const conv = s.conversations.get(hit.conversationId);
  if (conv?.otherUser?.id === hit.senderId) {
    return conv.otherUser.displayName ?? conv.otherUser.username ?? 'Someone';
  }
  const seen = s.messages.get(hit.conversationId)?.find((m) => m.senderId === hit.senderId);
  return seen?.sender?.displayName ?? seen?.sender?.username ?? 'Someone';
}

/** Where a message hit lives, for the row's context line. */
export function conversationName(conversationId: string): string {
  const conv = getState().conversations.get(conversationId);
  if (!conv) return 'a chat';
  return (
    conv.title ??
    conv.otherUser?.displayName ??
    conv.otherUser?.username ??
    'a chat'
  );
}

/** Compact timestamp: time today, weekday this week, date otherwise. */
export function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const days = (now.getTime() - d.getTime()) / 86_400_000;
  if (days < 6) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/**
 * The jump handshake with the chat surface: after loadAround the switcher
 * writes {conversationId, seq} here; the message list reads (and clears) it to
 * scroll to and highlight the target row.
 */
export const JUMP_KEY = 'yappy.jump';

export function setJumpTarget(conversationId: string, seq: number): void {
  try {
    sessionStorage.setItem(JUMP_KEY, JSON.stringify({ conversationId, seq }));
  } catch {
    /* storage denied — the chat still lands on the right window */
  }
}
