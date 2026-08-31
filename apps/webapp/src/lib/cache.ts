/**
 * What the last visit looked like, kept on disk so the next one starts full.
 *
 * Before this, every reload was a blank shell waiting on a network it had no
 * reason to wait for: the conversation list took a round trip, and the room
 * you were reading took another one behind it. The bytes had all been here a
 * second ago. Now they are written down.
 *
 * Rules that keep it honest:
 *
 *  - This is a *paint*, not a source of truth. Nothing hydrated from here is
 *    marked as loaded; the real fetch still runs and still wins. The cache
 *    buys the first frame, not the data.
 *  - Encrypted bodies are never written here. `plaintext` and `ciphertext`
 *    are stripped on the way in — the plaintext store in the key database is
 *    the one place that holds them, and it is the one place the app lock and
 *    "sign out of this device" already know about.
 *  - Its own database, so `signedOutReset` can drop the whole thing in one
 *    call without touching keys or ratchet state.
 */

import type { Conversation, Message } from './types';

const DB_NAME = 'yappy-cache';
const STORE = 'snap';
const KEY = 'home';

/** Rooms whose tail is worth keeping. Beyond this, the network is fine. */
const MAX_ROOMS = 8;
/** Messages per room. One screenful and a bit — the rest pages in. */
const MAX_MESSAGES = 40;
/** Older than this and a stale sidebar is worse than an empty one. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface Snapshot {
  at: number;
  userId: string | null;
  conversations: Conversation[];
  messages: Record<string, Message[]>;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('cache blocked'));
  });
}

/**
 * The last snapshot, or null.
 *
 * Null for every reason — no database, another origin's tab holding an
 * upgrade, a snapshot from a different account, one older than a week. A
 * cache that cannot answer is not an error; it is a normal cold start.
 */
export async function readSnapshot(userId: string | null): Promise<Snapshot | null> {
  try {
    const db = await open();
    const snap = await new Promise<Snapshot | null>((resolve) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
      request.onsuccess = () => resolve((request.result as Snapshot | undefined) ?? null);
      request.onerror = () => resolve(null);
    });
    db.close();
    if (!snap) return null;
    if (snap.userId !== userId) return null;
    if (Date.now() - snap.at > MAX_AGE_MS) return null;
    return snap;
  } catch {
    return null;
  }
}

/** A message with nothing in it that does not belong on an unlocked disk. */
function safeMessage(msg: Message): Message {
  if (!msg.isEncrypted) return msg;
  return { ...msg, plaintext: undefined, ciphertext: undefined };
}

let writeTimer: ReturnType<typeof setTimeout> | null = null;
let writing = false;

async function put(snap: Snapshot): Promise<void> {
  try {
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(snap, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    /* private mode, quota, a locked database — the app is unaffected */
  }
}

/**
 * Write the snapshot, at most once every few seconds and never on the way to
 * anything. A busy room mutates the store dozens of times a minute and none
 * of those writes is worth a transaction of its own; the last one wins and
 * that is the only one anybody will ever read.
 */
export function saveSnapshot(
  userId: string | null,
  conversations: Iterable<Conversation>,
  messages: Map<string, Message[]>,
  recentRoomIds: readonly string[],
): void {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    if (writing) return;
    writing = true;
    const rooms: Record<string, Message[]> = {};
    for (const id of recentRoomIds.slice(0, MAX_ROOMS)) {
      const list = messages.get(id);
      if (!list?.length) continue;
      rooms[id] = list.filter((m) => !m.pending).slice(-MAX_MESSAGES).map(safeMessage);
    }
    void put({ at: Date.now(), userId, conversations: [...conversations], messages: rooms }).finally(
      () => {
        writing = false;
      },
    );
  }, 4_000);
}

export async function clearSnapshot(): Promise<void> {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  try {
    const db = await open();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
    db.close();
  } catch {
    /* nothing to clear */
  }
}
