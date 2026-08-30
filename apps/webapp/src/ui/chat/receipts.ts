/**
 * Receipt cursors: the data behind the ticks and the seen-by sheet.
 *
 * GET /conversations/:id/receipts (no seq → every receipt-visible member)
 * returns `{ readBy: [{ user, seq, readAt, deliveredSeq }] }`. Fetched once
 * per conversation per session and folded into `state.readBy` /
 * `state.deliveredTo`, which the gateway's ReadReceipt/DeliveryReceipt events
 * keep moving afterwards. The user objects are cached here for the seen-by
 * sheet, which needs names and avatars, not just cursors.
 */

import { api } from '../../lib/api';
import { getState, mutate } from '../../state/store';
import type { Message, PublicUser } from '../../lib/types';

export interface ReceiptEntry {
  user: PublicUser;
  seq: number;
  readAt: string | null;
  deliveredSeq: number;
}

const fetched = new Set<string>();
const usersByConv = new Map<string, Map<string, PublicUser>>();

/** The receipt-visible members we know about, for the seen-by sheet. */
export function receiptUsers(conversationId: string): Map<string, PublicUser> {
  return usersByConv.get(conversationId) ?? new Map();
}

export async function ensureReceipts(conversationId: string): Promise<void> {
  if (fetched.has(conversationId)) return;
  fetched.add(conversationId);
  try {
    const res = await api<{ readBy: ReceiptEntry[] }>(
      `/conversations/${conversationId}/receipts`,
    );
    const meId = getState().me?.id;
    const users = usersByConv.get(conversationId) ?? new Map<string, PublicUser>();
    usersByConv.set(conversationId, users);
    mutate((s) => {
      const read = s.readBy.get(conversationId) ?? new Map<string, number>();
      const delivered = s.deliveredTo.get(conversationId) ?? new Map<string, number>();
      for (const entry of res.readBy) {
        users.set(entry.user.id, entry.user);
        if (entry.user.id === meId) continue;
        read.set(entry.user.id, Math.max(read.get(entry.user.id) ?? 0, entry.seq));
        // Reading implies delivery; the higher watermark wins either way.
        delivered.set(
          entry.user.id,
          Math.max(delivered.get(entry.user.id) ?? 0, entry.deliveredSeq, entry.seq),
        );
      }
      s.readBy.set(conversationId, read);
      s.deliveredTo.set(conversationId, delivered);
    }, 'receipts');
  } catch (err) {
    fetched.delete(conversationId); // let the next open retry
    console.error('receipts fetch failed', err);
  }
}

export type ReceiptState = 'pending' | 'sent' | 'delivered' | 'read';

/**
 * What the tick on one of your own bubbles should say. Android parity: the
 * watermark is the MAX cursor across every *other* member, so in a group one
 * reader is enough for the accent pair — "someone has read this", not
 * "everyone has".
 */
export function receiptStateFor(message: Message, conversationId: string): ReceiptState {
  if (message.pending) return 'pending';
  const s = getState();
  const meId = s.me?.id;
  let read = 0;
  let delivered = 0;
  for (const [userId, seq] of s.readBy.get(conversationId) ?? []) {
    if (userId !== meId) read = Math.max(read, seq);
  }
  for (const [userId, seq] of s.deliveredTo.get(conversationId) ?? []) {
    if (userId !== meId) delivered = Math.max(delivered, seq);
  }
  if (message.seq <= read) return 'read';
  if (message.seq <= Math.max(delivered, read)) return 'delivered';
  return 'sent';
}

/** Everyone (other than me) whose read cursor covers this message. */
export function readersOf(message: Message, conversationId: string): PublicUser[] {
  const s = getState();
  const meId = s.me?.id;
  const users = receiptUsers(conversationId);
  const out: PublicUser[] = [];
  for (const [userId, seq] of s.readBy.get(conversationId) ?? []) {
    if (userId === meId || seq < message.seq) continue;
    const user = users.get(userId);
    if (user) out.push(user);
  }
  return out;
}
