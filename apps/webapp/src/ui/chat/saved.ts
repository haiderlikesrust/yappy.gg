/**
 * Saved messages — personal bookmarks.
 *
 * The saved set is the viewer's own metadata: nothing fans out, no event
 * arrives for it, so a module-level cache with an explicit refresh is the
 * honest model. `ensureSaved()` loads the ids once per session; toggles keep
 * the cache in step optimistically and poke the store so hover bars re-label.
 */

import { api } from '../../lib/api';
import { mutate } from '../../state/store';
import type { Message } from '../../lib/types';

export interface SavedItem {
  savedAt: string;
  conversation: { id: string; type: string; title: string | null };
  message: Message | null;
}

const savedIds = new Set<string>();
let loaded = false;
let loading: Promise<void> | null = null;

export function isSaved(messageId: string): boolean {
  return savedIds.has(messageId);
}

/** Load the id set once, so Save/Unsave labels are right from first hover. */
export function ensureSaved(): void {
  if (loaded || loading) return;
  loading = api<{ items: SavedItem[] }>('/users/me/saved?limit=100')
    .then((res) => {
      for (const item of res.items) if (item.message) savedIds.add(item.message.id);
      loaded = true;
    })
    .catch(() => {
      /* labels default to "Save"; the next toggle still works */
    })
    .finally(() => {
      loading = null;
    });
}

export async function toggleSaved(conversationId: string, messageId: string): Promise<void> {
  const wasSaved = savedIds.has(messageId);
  if (wasSaved) savedIds.delete(messageId);
  else savedIds.add(messageId);
  mutate(() => {}); // relabel open hover bars
  try {
    await api(`/conversations/${conversationId}/messages/${messageId}/save`, {
      method: wasSaved ? 'DELETE' : 'PUT',
    });
  } catch (err) {
    if (wasSaved) savedIds.add(messageId);
    else savedIds.delete(messageId);
    mutate(() => {});
    console.error('save toggle failed', err);
  }
}

/** The full list for the Saved screen — always fresh, and re-syncs the id set. */
export async function fetchSaved(): Promise<SavedItem[]> {
  const res = await api<{ items: SavedItem[] }>('/users/me/saved?limit=100');
  savedIds.clear();
  for (const item of res.items) if (item.message) savedIds.add(item.message.id);
  loaded = true;
  return res.items;
}
