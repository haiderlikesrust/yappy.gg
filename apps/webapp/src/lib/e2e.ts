import { ENCRYPTED_NOTICE } from '@yappy/shared';
import { api, currentDeviceId } from './api';
import type { RecipientBundle } from './cipher';
import { openSealed, sealTo, sealedSender } from './cipher';
import { loadIdentity } from './keys';

/**
 * The session layer: who a message gets sealed to, and what this device can
 * open. The cipher itself is in `cipher.ts`, and it is real — there is no
 * longer a placeholder anywhere in this path.
 *
 * What is still deliberately narrow: it is one message key per message, with no
 * ratchet chaining them, and it is switched on per conversation by hand in a
 * dev build. Everything around it — the fan-out, the storage, the rendering,
 * the failure states — was built against a fake cipher precisely so that
 * swapping in a real one would touch two functions. It did.
 */

/** A dev-only switch. Off unless the build is a dev build *and* it is set. */
const FLAG = 'yappy.e2e.dev';

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

export interface Envelope {
  deviceId: string;
  ciphertext: string;
}

// ─── the identity keys of everybody else ─────────────────────────────────────

interface DirectoryEntry {
  fetchedAt: number;
  /** device id → Ed25519 identity key. */
  byDevice: Map<string, string>;
}

const directory = new Map<string, DirectoryEntry>();
/** Long enough that reading a screenful of history is one request per person. */
const DIRECTORY_TTL = 5 * 60 * 1000;

/**
 * The identity key a device publishes, which is what its signatures are checked
 * against.
 *
 * Cached per person, and refetched when a message names a device the cache has
 * never seen — that is exactly what somebody adding a phone looks like from
 * here, and the alternative is that their first message from it is permanently
 * unreadable.
 */
async function identityKeyOf(userId: string, deviceId: string): Promise<string | null> {
  const hit = directory.get(userId);
  if (hit && (hit.byDevice.has(deviceId) || Date.now() - hit.fetchedAt < DIRECTORY_TTL)) {
    return hit.byDevice.get(deviceId) ?? null;
  }
  try {
    const res = await api<{ devices: Array<{ deviceId: string; identityKey: string }> }>(
      `/keys/user/${userId}`,
    );
    const byDevice = new Map(res.devices.map((d) => [d.deviceId, d.identityKey]));
    directory.set(userId, { fetchedAt: Date.now(), byDevice });
    return byDevice.get(deviceId) ?? null;
  } catch {
    return null;
  }
}

// ─── sealing ─────────────────────────────────────────────────────────────────

/**
 * Everybody who should be able to read this, as devices.
 *
 * Includes the sender's own devices, and unlike the placeholder that came
 * before it, that now includes the device doing the sending. It has the
 * plaintext in front of it today and none of it tomorrow: there is no local
 * message store yet, so on the next reload the only copy of what you said is
 * the one on the server, and if nothing there is addressed to you, your own
 * messages come back unreadable. One extra envelope is the whole fix.
 */
async function recipients(memberIds: string[]): Promise<RecipientBundle[]> {
  const res = await api<{ bundles: RecipientBundle[] }>('/keys/claim', {
    method: 'POST',
    body: { userIds: memberIds },
  });
  return res.bundles;
}

/**
 * What a private send puts on the wire.
 *
 * `content` carries the notice rather than the message — see
 * `messages.isEncrypted` on the server for why it is not left empty — and the
 * body goes one copy per device.
 *
 * Returns null when there is nobody to encrypt to, which is not an error: it
 * means every recipient device is one this build has no usable keys for, and
 * the caller should send in the clear rather than post something nobody can
 * read. A device whose signed prekey does not verify is dropped on its own,
 * not taken as a reason to abandon the message — that is one bad device, and
 * everybody else in the conversation is still owed their copy.
 */
export async function sealFor(
  memberIds: string[],
  plaintext: string,
): Promise<{ content: string; envelopes: Envelope[] } | null> {
  if (!e2eAvailable()) return null;
  try {
    const identity = await loadIdentity();
    if (!identity || identity.deviceId !== currentDeviceId()) return null;

    const sender = {
      deviceId: identity.deviceId,
      userId: identity.userId,
      identityPrivate: identity.identityPrivate,
    };

    const envelopes: Envelope[] = [];
    for (const bundle of await recipients(memberIds)) {
      try {
        envelopes.push({ deviceId: bundle.deviceId, ciphertext: sealTo(plaintext, bundle, sender) });
      } catch {
        // A device whose prekey does not verify. Skipped, loudly nowhere —
        // the safety-number screen is where that conversation belongs.
      }
    }
    return envelopes.length > 0 ? { content: ENCRYPTED_NOTICE, envelopes } : null;
  } catch {
    return null;
  }
}

// ─── opening ─────────────────────────────────────────────────────────────────

/**
 * What this device can read of an encrypted message.
 *
 * `authorId` is the server's word for who wrote it, and the signature has to
 * agree with it — a sealed body lifted from one message and hung under another
 * name fails here rather than being shown under the wrong face.
 *
 * Null covers every refusal: no keys on this device, a copy for a different
 * device, an unknown sender, a tag that does not check. The caller says "this
 * device cannot read this", which is true of all of them.
 */
export async function decrypt(
  ciphertext: string | null | undefined,
  authorId: string,
): Promise<string | null> {
  if (!ciphertext) return null;
  const claim = sealedSender(ciphertext);
  if (!claim) return null;

  const identity = await loadIdentity();
  if (!identity || identity.deviceId !== currentDeviceId()) return null;

  const senderKey = await identityKeyOf(claim.userId, claim.deviceId);
  return openSealed(
    ciphertext,
    {
      deviceId: identity.deviceId,
      signedPreKeyId: identity.signedPreKeyId,
      signedPreKeyPrivate: identity.signedPreKeyPrivate,
      preKeys: identity.preKeys,
    },
    senderKey,
    authorId,
  );
}
