/**
 * Unread divider bookkeeping.
 *
 * `selectConversation` zeroes `self.lastReadSeq` before React paints, so the
 * cursor has to be frozen at the moment of open — not read later from the
 * conversation object. One capture per room per session; remounts reuse it.
 */

const frozen = new Map<string, number>();

export function captureUnreadDivider(conversationId: string, lastReadSeq: number): void {
  if (!frozen.has(conversationId)) frozen.set(conversationId, lastReadSeq);
}

export function unreadDividerSeq(conversationId: string): number | null {
  return frozen.get(conversationId) ?? null;
}
