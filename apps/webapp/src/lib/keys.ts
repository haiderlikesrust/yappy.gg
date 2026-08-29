import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { api } from './api';
import { STORES, idbGet, idbPut } from './idb';

/**
 * This device's cryptographic identity, published so other devices can find it.
 *
 * Nothing here encrypts a message. It is the part of end-to-end encryption that
 * cannot be added afterwards: key distribution. A device that has never
 * published an identity key has no way to be handed one retroactively, so the
 * day encryption is switched on, every account older than that day would find
 * its other devices unreachable and its history unreadable. Publishing from now
 * on means the switch is a feature flag rather than a migration people
 * experience as loss.
 *
 * What a device holds:
 *
 *   • an **Ed25519 identity key**, generated once and never rotated silently —
 *     rotating it is the alarming, visible event ("safety number changed") that
 *     the whole verification mechanism exists to surface. Its public half is
 *     what the fingerprint on the sessions screen is computed from, and it can
 *     be converted to X25519 for key agreement when there is any.
 *   • a **signed prekey**, an X25519 key signed by the identity key, so a sender
 *     can check the prekey really came from this device.
 *   • a pool of **one-time prekeys**, each handed out exactly once. The server
 *     deletes one as it claims it; reusing one would defeat the forward secrecy
 *     it exists to provide.
 *
 * Where the private halves live: IndexedDB, in this origin. A browser cannot
 * hide a key from its own page, so this is worth exactly what the app lock is
 * worth — it defends against somebody else picking up the laptop, not against
 * code running on the page. Signal Desktop has the same property. It is written
 * down here so nobody has to guess later.
 */

/** One record, because a device has one identity. */
const RECORD = 'device';

/** Below this many unclaimed prekeys, top the pool back up. */
const LOW_WATER = 20;
const POOL = 60;

export interface StoredIdentity {
  /** The device this belongs to. A different device id means a different identity. */
  deviceId: string;
  /**
   * The account it belongs to, so a sealed message can name its sender without
   * this module having to reach into the store for it.
   */
  userId: string;
  identityPrivate: string;
  identityPublic: string;
  signedPreKeyId: number;
  signedPreKeyPrivate: string;
  signedPreKeyPublic: string;
  /** Highest one-time prekey id minted so far; ids never repeat for a device. */
  lastPreKeyId: number;
  /** id → private key, for the prekeys still unclaimed. */
  preKeys: Record<number, string>;
}

// ─── base64, on bytes ────────────────────────────────────────────────────────

const toB64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const fromB64 = (text: string): Uint8Array =>
  Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

// ─── storage ─────────────────────────────────────────────────────────────────

async function read(): Promise<StoredIdentity | null> {
  return idbGet<StoredIdentity>(STORES.identity, RECORD);
}

async function write(identity: StoredIdentity): Promise<void> {
  await idbPut(STORES.identity, RECORD, identity);
}

// ─── minting ─────────────────────────────────────────────────────────────────

function mintIdentity(deviceId: string, userId: string): StoredIdentity {
  const identityPrivate = ed25519.utils.randomSecretKey();
  const signedPrivate = x25519.utils.randomSecretKey();

  return {
    deviceId,
    userId,
    identityPrivate: toB64(identityPrivate),
    identityPublic: toB64(ed25519.getPublicKey(identityPrivate)),
    signedPreKeyId: 1,
    signedPreKeyPrivate: toB64(signedPrivate),
    signedPreKeyPublic: toB64(x25519.getPublicKey(signedPrivate)),
    lastPreKeyId: 0,
    preKeys: {},
  };
}

/** `count` fresh one-time prekeys, recorded against the identity. */
function mintPreKeys(identity: StoredIdentity, count: number): Array<{ id: number; key: string }> {
  const minted: Array<{ id: number; key: string }> = [];
  for (let i = 0; i < count; i += 1) {
    const id = identity.lastPreKeyId + 1 + i;
    const priv = x25519.utils.randomSecretKey();
    identity.preKeys[id] = toB64(priv);
    minted.push({ id, key: toB64(x25519.getPublicKey(priv)) });
  }
  identity.lastPreKeyId += count;
  return minted;
}

/** The signature that proves this prekey came from this identity. */
function signPreKey(identity: StoredIdentity): string {
  return toB64(
    ed25519.sign(fromB64(identity.signedPreKeyPublic), fromB64(identity.identityPrivate)),
  );
}

// ─── the one thing the app calls ─────────────────────────────────────────────

/**
 * Make sure this device has an identity on the server, and enough prekeys.
 *
 * Safe to call on every boot: it publishes once per device and afterwards only
 * tops the pool up when the server says it is running low. Failures are
 * swallowed on purpose — this is groundwork for a feature that does not exist
 * yet, and it must never be the reason somebody cannot open their chats.
 */
export async function ensureDeviceKeys(deviceId: string, userId: string): Promise<void> {
  if (!deviceId || !userId || typeof indexedDB === 'undefined') return;

  try {
    let identity = await read();

    // An identity minted before this record carried an account id. Filled in,
    // never re-minted: `/keys/publish` deliberately refuses to overwrite an
    // identity key that is already out there, so a device that threw its
    // private half away would be left signing with a key nobody can check.
    if (identity && identity.deviceId === deviceId && identity.userId !== userId) {
      identity = { ...identity, userId };
      await write(identity);
    }

    // A new device id means a new device: the old private keys belong to a
    // session that is gone, and using them here would claim to be a device the
    // server has revoked.
    if (!identity || identity.deviceId !== deviceId) {
      identity = mintIdentity(deviceId, userId);
      const oneTimePreKeys = mintPreKeys(identity, POOL);
      await write(identity);
      await api('/keys/publish', {
        method: 'POST',
        body: {
          deviceId,
          identityKey: identity.identityPublic,
          signedPreKey: {
            id: identity.signedPreKeyId,
            key: identity.signedPreKeyPublic,
            signature: signPreKey(identity),
          },
          oneTimePreKeys,
        },
      });
      return;
    }

    const { availablePreKeys } = await api<{ availablePreKeys: number }>('/keys/count');
    if (availablePreKeys >= LOW_WATER) return;

    const oneTimePreKeys = mintPreKeys(identity, POOL - availablePreKeys);
    await write(identity);
    await api('/keys/publish', {
      method: 'POST',
      body: {
        deviceId,
        identityKey: identity.identityPublic,
        signedPreKey: {
          id: identity.signedPreKeyId,
          key: identity.signedPreKeyPublic,
          signature: signPreKey(identity),
        },
        oneTimePreKeys,
      },
    });
  } catch {
    // Next boot tries again. Nothing depends on this yet.
  }
}

/**
 * The private halves, for the cipher.
 *
 * Nothing else in the app should call this. It hands out key material, and the
 * only place key material belongs is `cipher.ts`, which is where every use of
 * it is auditable in one file.
 */
export async function loadIdentity(): Promise<StoredIdentity | null> {
  if (typeof indexedDB === 'undefined') return null;
  try {
    return await read();
  } catch {
    return null;
  }
}

/**
 * Forget a one-time prekey, now that it has started the session it existed
 * for.
 *
 * This is what makes it one-time. While the private half is still here, the
 * first message of a session can be replayed into a brand new session — which
 * re-opens a message whose key was supposed to be spent, and discards the
 * real session as it goes. It is also half of what the prekey pool is for:
 * the other half of the agreement it protected cannot be recomputed once this
 * is gone.
 *
 * Read and written together rather than patched in place, because the pool is
 * one record. The top-up path does the same and they must not disagree.
 */
export async function consumePreKey(id: number): Promise<void> {
  try {
    const identity = await read();
    if (!identity || identity.preKeys[id] === undefined) return;
    const preKeys = { ...identity.preKeys };
    delete preKeys[id];
    await write({ ...identity, preKeys });
  } catch {
    // Next launch still has it. Worth a retry, not worth a failed message.
  }
}

/** This device's own fingerprint, for the sessions screen. */
export async function deviceFingerprint(): Promise<string | null> {
  const identity = await read();
  if (!identity) return null;
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(identity.identityPublic),
  );
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  // Grouped the same way the server groups it, so the two can be compared.
  return (hex.match(/.{1,5}/g) ?? []).slice(0, 12).join(' ');
}
