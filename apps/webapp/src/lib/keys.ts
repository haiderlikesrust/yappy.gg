import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { api } from './api';

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

const DB_NAME = 'yappy-keys';
const STORE = 'identity';
const RECORD = 'device';

/** Below this many unclaimed prekeys, top the pool back up. */
const LOW_WATER = 20;
const POOL = 60;

interface StoredIdentity {
  /** The device this belongs to. A different device id means a different identity. */
  deviceId: string;
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

function openAt(version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = version ? indexedDB.open(DB_NAME, version) : indexedDB.open(DB_NAME);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * The database, with its store guaranteed.
 *
 * Opened at whatever version exists rather than at a fixed one, because a
 * database can exist without the store inside it — an upgrade interrupted
 * halfway leaves exactly that — and reopening at the same version would never
 * fire `onupgradeneeded` to fix it. Bumping the version does.
 */
async function open(): Promise<IDBDatabase> {
  const db = await openAt();
  if (db.objectStoreNames.contains(STORE)) return db;
  const version = db.version + 1;
  db.close();
  return openAt(version);
}

async function read(): Promise<StoredIdentity | null> {
  const db = await open();
  return new Promise((resolve) => {
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(RECORD);
    request.onsuccess = () => resolve((request.result as StoredIdentity | undefined) ?? null);
    request.onerror = () => resolve(null);
  });
}

async function write(identity: StoredIdentity): Promise<void> {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(identity, RECORD);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ─── minting ─────────────────────────────────────────────────────────────────

function mintIdentity(deviceId: string): StoredIdentity {
  const identityPrivate = ed25519.utils.randomSecretKey();
  const signedPrivate = x25519.utils.randomSecretKey();

  return {
    deviceId,
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
export async function ensureDeviceKeys(deviceId: string): Promise<void> {
  if (!deviceId || typeof indexedDB === 'undefined') return;

  try {
    let identity = await read();

    // A new device id means a new device: the old private keys belong to a
    // session that is gone, and using them here would claim to be a device the
    // server has revoked.
    if (!identity || identity.deviceId !== deviceId) {
      identity = mintIdentity(deviceId);
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
