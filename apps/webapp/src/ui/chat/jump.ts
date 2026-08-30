/**
 * Jump-to-message plumbing, usable from any surface (pinned bar, search, …).
 *
 * `jumpToMessage(convId, seq)` makes sure a window containing the message is
 * loaded (via `loadAround`, which detaches the conversation from the live
 * tail) and records the target; ChatView picks the target up after render,
 * scrolls the row into view and flash-highlights it. While a conversation is
 * detached, the jump-to-latest pill calls `resetToLatest` and the bottom-pin
 * logic stays off.
 */

import { getState, loadAround, mutate } from '../../state/store';

const pendingJump = new Map<string, number>();

export function peekJump(conversationId: string): number | null {
  return pendingJump.get(conversationId) ?? null;
}

export function clearJump(conversationId: string): void {
  pendingJump.delete(conversationId);
}

export async function jumpToMessage(conversationId: string, seq: number): Promise<void> {
  const list = getState().messages.get(conversationId);
  const loaded = list?.some((m) => !m.pending && m.seq === seq) ?? false;
  pendingJump.set(conversationId, seq);
  if (loaded) {
    mutate(() => {}, 'messages'); // just poke the host so its post-render effect runs
    return;
  }
  try {
    await loadAround(conversationId, seq);
  } catch (err) {
    pendingJump.delete(conversationId);
    console.error('jump-to-message failed', err);
  }
}
