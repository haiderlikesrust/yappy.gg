import { ENCRYPTED_NOTICE } from '@yappy/shared';
import { api, currentDeviceId } from './api';

/**
 * The session layer, with a placeholder where the cipher goes.
 *
 * **Nothing here encrypts anything.** `seal` is reversible by anybody who reads
 * this file, and it is gated on a development build so it cannot reach a
 * release. It exists because the ratchet is the *small* part of shipping
 * encrypted messages: the rest is one ciphertext per recipient device, what a
 * device that was not a recipient shows, what happens when somebody adds a
 * phone mid-conversation, what the composer says, what push can say. All of
 * that is product behaviour that has to be settled anyway, and settling it
 * against a fake cipher is far cheaper than settling it against a real one.
 *
 * When vodozemac lands, `seal` and `open` are the two functions that change.
 * Everything else — the fan-out, the storage, the rendering, the failure
 * states — is already right or already wrong by then.
 */

/** A dev-only switch. Off unless the build is a dev build *and* it is set. */
const FLAG = 'yappy.e2e.dev';
const PREFIX = 'stub.v0.';

export function e2eAvailable(): boolean {
  // Two locks: the build, and the flag. Neither alone turns it on.
  return import.meta.env.DEV && localStorage.getItem(FLAG) === 'on';
}

/** Which conversations this device is sending encrypted, locally. */
const CONVERSATIONS = 'yappy.e2e.conversations';

function flagged(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(CONVERSATIONS) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

export function isPrivate(conversationId: string): boolean {
  return e2eAvailable() && flagged().has(conversationId);
}

export function setPrivate(conversationId: string, on: boolean): void {
  const set = flagged();
  if (on) set.add(conversationId);
  else set.delete(conversationId);
  localStorage.setItem(CONVERSATIONS, JSON.stringify([...set]));
}

interface Bundle {
  userId: string;
  deviceId: string;
  identityKey: string;
}

/**
 * Everybody who should be able to read this, as devices.
 *
 * Includes the sender's *own* other devices: a message you sent from a laptop
 * is unreadable on your phone otherwise, which is the single most reported
 * complaint about every encrypted messenger that got this wrong.
 *
 * The device sending is deliberately excluded — it already has the plaintext,
 * and an envelope addressed to itself is a byte of storage that proves nothing.
 */
async function recipients(memberIds: string[]): Promise<Bundle[]> {
  const res = await api<{ bundles: Bundle[] }>('/keys/claim', {
    method: 'POST',
    body: { userIds: memberIds },
  });
  const self = currentDeviceId();
  return res.bundles.filter((b) => b.deviceId !== self);
}

export interface Envelope {
  deviceId: string;
  ciphertext: string;
}

/**
 * NOT ENCRYPTION. A reversible encoding, so the plumbing can be exercised.
 *
 * Tagged with the device it is addressed to so a mis-routed envelope is
 * obvious rather than silently readable, and prefixed with a version so the
 * real thing can refuse to try to open one of these.
 */
function seal(plaintext: string, deviceId: string): string {
  return PREFIX + btoa(unescape(encodeURIComponent(`${deviceId}|${plaintext}`)));
}

export function open(ciphertext: string | null | undefined): string | null {
  if (!ciphertext?.startsWith(PREFIX)) return null;
  try {
    const decoded = decodeURIComponent(escape(atob(ciphertext.slice(PREFIX.length))));
    const bar = decoded.indexOf('|');
    if (bar === -1) return null;
    // Addressed to this device, or it is not ours to read.
    if (decoded.slice(0, bar) !== currentDeviceId()) return null;
    return decoded.slice(bar + 1);
  } catch {
    return null;
  }
}

/**
 * What a private send puts on the wire.
 *
 * `content` carries the notice rather than the message — see
 * `messages.isEncrypted` on the server for why it is not left empty — and the
 * body goes one copy per device.
 *
 * Returns null when there is nobody to encrypt to, which is not an error: it
 * means every recipient device is one this build has no keys for, and the
 * caller should send in the clear rather than post something nobody can read.
 */
export async function sealFor(
  memberIds: string[],
  plaintext: string,
): Promise<{ content: string; envelopes: Envelope[] } | null> {
  if (!e2eAvailable()) return null;
  try {
    const bundles = await recipients(memberIds);
    if (bundles.length === 0) return null;
    return {
      content: ENCRYPTED_NOTICE,
      envelopes: bundles.map((b) => ({ deviceId: b.deviceId, ciphertext: seal(plaintext, b.deviceId) })),
    };
  } catch {
    return null;
  }
}
