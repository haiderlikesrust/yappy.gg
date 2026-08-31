/**
 * Which rooms this device sends encrypted, and whether it may at all.
 *
 * Split out of `e2e.ts` for one reason: this is two localStorage reads, and
 * `e2e.ts` drags the curves, the ratchet and the hashes in behind it — about
 * 50KB that the chat surface was loading on every page view so that the send
 * path could ask a question whose answer is almost always "no". The cipher
 * now loads at the moment somebody actually sends something private.
 */

/** A dev-only switch. Off unless the build is a dev build *and* it is set. */
const FLAG = 'yappy.e2e.dev';

/** Which conversations this device is sending encrypted, locally. */
const CONVERSATIONS = 'yappy.e2e.conversations';

export function e2eAvailable(): boolean {
  // Two locks: the build, and the flag. Neither alone turns it on.
  return import.meta.env.DEV && localStorage.getItem(FLAG) === 'on';
}

export function privateConversationIds(): Set<string> {
  if (!e2eAvailable()) return new Set();
  try {
    return new Set(JSON.parse(localStorage.getItem(CONVERSATIONS) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

export function isPrivate(conversationId: string): boolean {
  return privateConversationIds().has(conversationId);
}

export function setPrivate(conversationId: string, on: boolean): void {
  const set = privateConversationIds();
  if (on) set.add(conversationId);
  else set.delete(conversationId);
  localStorage.setItem(CONVERSATIONS, JSON.stringify([...set]));
}
