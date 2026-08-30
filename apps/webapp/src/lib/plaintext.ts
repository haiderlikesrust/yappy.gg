import { STORES, idbDelete, idbGet, idbPut } from './idb';

/**
 * What an encrypted message said, kept on this device.
 *
 * This is not a cache. Before the ratchet, a ciphertext could be opened again
 * every time the page loaded, because the keys that opened it were still
 * sitting in IndexedDB — which was precisely the forward-secrecy hole. Now a
 * message key is used once and destroyed, so the ciphertext on the server can
 * never be opened a second time.
 *
 * Which means: if this is not written down here, it is gone. Not "slow to
 * load" — gone, on the next reload, for good. Every other encrypted messenger
 * has the same file under a different name, and it is the reason history does
 * not follow you to a new phone.
 *
 * Kept as plaintext on purpose. Encrypting it would need a key stored beside
 * it, in the same origin, readable by the same code — theatre with a
 * performance cost. What actually protects it is the app lock and whatever the
 * device does about its own disk.
 */

export async function remember(messageId: string, plaintext: string): Promise<void> {
  try {
    await idbPut(STORES.plaintext, messageId, plaintext);
  } catch {
    // The message still displays this time. It will be unreadable after a
    // reload, which is bad, but losing it now would be worse.
  }
}

export async function recall(messageId: string): Promise<string | null> {
  try {
    return await idbGet<string>(STORES.plaintext, messageId);
  } catch {
    return null;
  }
}

/** A deleted message leaves nothing behind here either. */
export async function forget(messageId: string): Promise<void> {
  try {
    await idbDelete(STORES.plaintext, messageId);
  } catch {
    /* nothing to be done */
  }
}
