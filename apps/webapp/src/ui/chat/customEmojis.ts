/**
 * Custom emoji, per conversation.
 *
 * GET /conversations/:id/emojis → { emojis: [{ id, name, animated, url }] },
 * fetched once per conversation per session. Reactions with a custom emoji
 * send the `:name:` key through the ordinary `emoji` field of reactionBody
 * (a string ≤64 chars; the server treats reaction keys as opaque) — neither
 * phone client reacts with custom emoji yet, so this key is the web's
 * convention and renders as plain text there until they catch up.
 */

import { api } from '../../lib/api';
import { mutate } from '../../state/store';

export interface CustomEmoji {
  id: string;
  name: string;
  animated: boolean;
  url: string;
}

const cache = new Map<string, CustomEmoji[]>();
const inFlight = new Set<string>();

export function customEmojisFor(conversationId: string): CustomEmoji[] {
  return cache.get(conversationId) ?? [];
}

export function ensureCustomEmojis(conversationId: string): void {
  if (cache.has(conversationId) || inFlight.has(conversationId)) return;
  inFlight.add(conversationId);
  api<{ emojis: CustomEmoji[] }>(`/conversations/${conversationId}/emojis`)
    .then((res) => {
      cache.set(conversationId, res.emojis);
      mutate(() => {}, 'messages'); // poke the open chat so chips re-render as images
    })
    .catch((err) => console.error('custom emoji fetch failed', err))
    .finally(() => inFlight.delete(conversationId));
}

export const customEmojiKey = (emoji: CustomEmoji): string => `:${emoji.name}:`;

/** A reaction key like `:party_parrot:` → the emoji, if this room has it. */
export function customEmojiByKey(conversationId: string, key: string): CustomEmoji | null {
  const m = /^:([a-z0-9_]{2,32}):$/.exec(key);
  if (!m) return null;
  return customEmojisFor(conversationId).find((e) => e.name === m[1]) ?? null;
}
