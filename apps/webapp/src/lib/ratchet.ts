import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

/**
 * The Double Ratchet.
 *
 * The cipher this replaces derived one key per message from a fresh ephemeral
 * and threw it away — real encryption, but with a hole where forward secrecy
 * should be: the device kept the prekey privates those keys were derived
 * against, so anybody who took the device could go back and open every
 * ciphertext still sitting on the server.
 *
 * A ratchet closes that by never keeping a key it can still use. Two chains
 * turn:
 *
 *   • the **symmetric chain**, one step per message. Each step hashes the chain
 *     key into a message key and into the next chain key, and the old chain key
 *     is gone. A message key is used once and deleted. Taking the device now
 *     gets you the messages from here on, not the ones behind you — the hash is
 *     one-way, and the keys that opened them no longer exist anywhere.
 *
 *   • the **DH ratchet**, one step per reply. Every time the other side sends a
 *     new ratchet public key, both ends agree a fresh secret and start new
 *     chains from it. That is what heals a compromise rather than merely
 *     limiting it: an attacker who learns the current state loses it again as
 *     soon as one message comes back the other way.
 *
 * The session starts from the X3DH agreement the key directory already
 * supports — the ephemeral, the signed prekey and, when one is free, a one-time
 * prekey. The recipient's signed prekey doubles as its first ratchet key, which
 * is what lets a conversation begin without the recipient being online.
 *
 * Everything here is pure: a session goes in, a new session comes out, nothing
 * is read from disk or the network. That is deliberate — this is the part where
 * a mistake is silent and permanent, so it is the part that has to be testable
 * without a browser. Storage lives in `sessions.ts`, the envelope in
 * `cipher.ts`.
 *
 * The one thing a ratchet costs: a message key does not survive being used, so
 * a ciphertext cannot be opened twice. Decrypted text has to be kept locally or
 * it is gone on the next reload — see `messages.ts` for that half.
 */

const DOMAIN = 'yappy.ratchet.v2';
/** Beyond this many missing messages in one chain, assume something is wrong. */
const MAX_SKIP = 1000;
/** And beyond this many stored keys, stop remembering — the map is unbounded otherwise. */
const MAX_SKIPPED_KEPT = 2000;

// ─── bytes ───────────────────────────────────────────────────────────────────

const toB64 = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
const fromB64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

// ─── shapes ──────────────────────────────────────────────────────────────────

/**
 * A session, as it is stored: base64 and numbers, nothing else, so it survives
 * a round trip through IndexedDB without a custom serialiser.
 */
export interface Session {
  /** The device at the other end. One session per device, never per person. */
  deviceId: string;
  rootKey: string;
  myRatchetPrivate: string;
  myRatchetPublic: string;
  /** Null until the first message from them arrives. */
  theirRatchet: string | null;
  sendChain: string | null;
  recvChain: string | null;
  /** Position in the current chains, and the length of the one before. */
  sendCount: number;
  recvCount: number;
  previousSendCount: number;
  /**
   * Keys for messages that have not arrived yet, by `${theirRatchet}|${n}`.
   *
   * A message that overtakes another must still open, and the key that opens
   * it only exists on the way past. Kept here, deleted the moment it is used —
   * this map is the one place a ratchet holds a usable key for longer than an
   * instant, and it is bounded for that reason.
   */
  skipped: Record<string, string>;
  /**
   * The X3DH preamble, repeated on every message until they answer.
   *
   * A conversation begins with one side talking to a prekey bundle. Until a
   * reply proves the other end built the same session, every message has to
   * carry enough to build it — otherwise losing the first message strands the
   * conversation permanently.
   */
  pending: PreKeyHeader | null;
}

/** What the first messages carry so the other end can derive the same root. */
export interface PreKeyHeader {
  /** The sender's ephemeral public key, this session only. */
  ek: string;
  /** Which of the recipient's prekeys it was agreed against. */
  spkId: number;
  otkId: number | null;
}

/** What every message carries so the ratchet can be followed. */
export interface RatchetHeader {
  /** The sender's current ratchet public key. */
  dh: string;
  /** How long the previous sending chain was, so gaps in it can be closed. */
  pn: number;
  /** Position in the current chain. */
  n: number;
  pre: PreKeyHeader | null;
}

/** The recipient's private halves, as `keys.ts` stores them. */
export interface RecipientPrivates {
  signedPreKeyId: number;
  signedPreKeyPrivate: string;
  preKeys: Record<number, string>;
}

/** The public half of a recipient, as `POST /keys/claim` returns it. */
export interface RecipientBundleKeys {
  deviceId: string;
  signedPreKey: { id: number; key: string };
  oneTimePreKey: { id: number; key: string } | null;
}

// ─── key derivation ──────────────────────────────────────────────────────────

/**
 * The root step: mix a fresh Diffie-Hellman into the root key and get a new
 * root key and a new chain key out.
 *
 * The old root key is the salt rather than the input, which is what makes this
 * a ratchet rather than a chain of hashes: an attacker who learns the DH output
 * still needs the root, and an attacker who learns the root still needs the DH.
 */
function rootStep(rootKey: Uint8Array, dh: Uint8Array): [Uint8Array, Uint8Array] {
  const out = hkdf(sha256, dh, rootKey, utf8ToBytes(`${DOMAIN}.root`), 64);
  return [out.slice(0, 32), out.slice(32)];
}

/**
 * The chain step: one message key, and the chain key that replaces this one.
 *
 * Two different constants so the message key can never be walked forward into
 * the chain — knowing a message key must say nothing about the next.
 */
function chainStep(chainKey: Uint8Array): [Uint8Array, Uint8Array] {
  const messageKey = hmac(sha256, chainKey, Uint8Array.of(1));
  const nextChain = hmac(sha256, chainKey, Uint8Array.of(2));
  return [messageKey, nextChain];
}

/** A message key is a key and a nonce; neither is ever reused, so neither travels. */
function messageCipher(messageKey: Uint8Array, aad: Uint8Array) {
  const out = hkdf(sha256, messageKey, undefined, utf8ToBytes(`${DOMAIN}.message`), 44);
  return chacha20poly1305(out.slice(0, 32), out.slice(32), aad);
}

/** The X3DH agreement, from either side. Two DHs, or one when no prekey was free. */
function initialRoot(dhSpk: Uint8Array, dhOtk: Uint8Array | null): Uint8Array {
  const ikm = dhOtk ? new Uint8Array([...dhSpk, ...dhOtk]) : dhSpk;
  return hkdf(sha256, ikm, sha256(utf8ToBytes(`${DOMAIN}.salt`)), utf8ToBytes(`${DOMAIN}.x3dh`), 32);
}

// ─── starting a session ──────────────────────────────────────────────────────

/**
 * Begin talking to a device that has never talked back.
 *
 * The recipient's signed prekey stands in as its first ratchet key. That is the
 * whole trick behind an encrypted message to somebody whose phone is off: their
 * half of the first DH is something they published in advance and still hold.
 */
export function initiate(bundle: RecipientBundleKeys): Session {
  const ephemeral = x25519.utils.randomSecretKey();
  const spk = fromB64(bundle.signedPreKey.key);

  const root = initialRoot(
    x25519.getSharedSecret(ephemeral, spk),
    bundle.oneTimePreKey ? x25519.getSharedSecret(ephemeral, fromB64(bundle.oneTimePreKey.key)) : null,
  );

  // The first DH ratchet step happens immediately, so the very first message is
  // already under a key neither the prekey nor the ephemeral can reproduce.
  const myRatchet = x25519.utils.randomSecretKey();
  const [rootKey, sendChain] = rootStep(root, x25519.getSharedSecret(myRatchet, spk));

  return {
    deviceId: bundle.deviceId,
    rootKey: toB64(rootKey),
    myRatchetPrivate: toB64(myRatchet),
    myRatchetPublic: toB64(x25519.getPublicKey(myRatchet)),
    theirRatchet: bundle.signedPreKey.key,
    sendChain: toB64(sendChain),
    recvChain: null,
    sendCount: 0,
    recvCount: 0,
    previousSendCount: 0,
    skipped: {},
    pending: {
      ek: toB64(x25519.getPublicKey(ephemeral)),
      spkId: bundle.signedPreKey.id,
      otkId: bundle.oneTimePreKey?.id ?? null,
    },
  };
}

/**
 * Build the other side of a session from the preamble on an incoming message.
 *
 * Null when this device does not hold the prekeys the sender used: a pool that
 * has been rotated, or a message for somebody else. The caller shows the
 * unreadable state, which is the honest answer.
 */
export function accept(pre: PreKeyHeader, me: RecipientPrivates, theirDeviceId: string): Session | null {
  if (pre.spkId !== me.signedPreKeyId) return null;
  const otkPrivate = pre.otkId === null ? null : me.preKeys[pre.otkId];
  if (pre.otkId !== null && !otkPrivate) return null;

  try {
    const ephemeral = fromB64(pre.ek);
    const root = initialRoot(
      x25519.getSharedSecret(fromB64(me.signedPreKeyPrivate), ephemeral),
      otkPrivate ? x25519.getSharedSecret(fromB64(otkPrivate), ephemeral) : null,
    );

    // The signed prekey is this end's first ratchet key, matching what the
    // sender assumed. The first DH step happens when their message is read.
    return {
      deviceId: theirDeviceId,
      rootKey: toB64(root),
      myRatchetPrivate: me.signedPreKeyPrivate,
      myRatchetPublic: toB64(x25519.getPublicKey(fromB64(me.signedPreKeyPrivate))),
      theirRatchet: null,
      sendChain: null,
      recvChain: null,
      sendCount: 0,
      recvCount: 0,
      previousSendCount: 0,
      skipped: {},
      pending: null,
    };
  } catch {
    return null;
  }
}

// ─── sending ─────────────────────────────────────────────────────────────────

/**
 * One message, and the session that replaces this one.
 *
 * The session is returned rather than mutated so a failed send cannot advance
 * the ratchet: a chain that has stepped past a message nobody received is a
 * conversation that never recovers.
 */
export function ratchetEncrypt(
  session: Session,
  plaintext: string,
  aad: Uint8Array,
): { session: Session; header: RatchetHeader; ciphertext: string } | null {
  if (!session.sendChain) return null;

  const [messageKey, nextChain] = chainStep(fromB64(session.sendChain));
  const header: RatchetHeader = {
    dh: session.myRatchetPublic,
    pn: session.previousSendCount,
    n: session.sendCount,
    pre: session.pending,
  };

  const ciphertext = toB64(messageCipher(messageKey, aad).encrypt(utf8ToBytes(plaintext)));

  return {
    session: { ...session, sendChain: toB64(nextChain), sendCount: session.sendCount + 1 },
    header,
    ciphertext,
  };
}

// ─── receiving ───────────────────────────────────────────────────────────────

/**
 * Walk a chain forward, keeping the keys for messages that have not arrived.
 *
 * Messages overtake each other — a phone that was asleep, two sockets, a retry.
 * Every key stepped over is one that opens a message still in flight, so it is
 * kept until it is used. The cap is a guard against a header claiming a
 * message number far in the future, which would otherwise be an invitation to
 * derive keys until the tab dies.
 */
function skipTo(session: Session, until: number): Session | null {
  if (!session.recvChain || !session.theirRatchet) return session;
  if (until - session.recvCount > MAX_SKIP) return null;

  const skipped = { ...session.skipped };
  let chain = fromB64(session.recvChain);
  let n = session.recvCount;

  while (n < until) {
    const [messageKey, nextChain] = chainStep(chain);
    skipped[`${session.theirRatchet}|${n}`] = toB64(messageKey);
    chain = nextChain;
    n += 1;
  }

  // Oldest first, so what falls off the end is what is least likely to arrive.
  const keys = Object.keys(skipped);
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_SKIPPED_KEPT))) delete skipped[key];

  return { ...session, skipped, recvChain: toB64(chain), recvCount: n };
}

/** A DH ratchet step: their new key arrived, so both chains start again. */
function turn(session: Session, theirRatchet: string): Session {
  const stepped = {
    ...session,
    previousSendCount: session.sendCount,
    sendCount: 0,
    recvCount: 0,
    theirRatchet,
  };

  const theirKey = fromB64(theirRatchet);
  const [rootAfterReceive, recvChain] = rootStep(
    fromB64(session.rootKey),
    x25519.getSharedSecret(fromB64(session.myRatchetPrivate), theirKey),
  );

  // A new keypair of our own, so the reply travels under a secret they cannot
  // derive from anything they have seen. This is the step that heals.
  const myRatchet = x25519.utils.randomSecretKey();
  const [rootKey, sendChain] = rootStep(rootAfterReceive, x25519.getSharedSecret(myRatchet, theirKey));

  return {
    ...stepped,
    rootKey: toB64(rootKey),
    myRatchetPrivate: toB64(myRatchet),
    myRatchetPublic: toB64(x25519.getPublicKey(myRatchet)),
    recvChain: toB64(recvChain),
    sendChain: toB64(sendChain),
  };
}

/**
 * The message, and the session that replaces this one — or null.
 *
 * Null is every failure: a header from a chain this session cannot reach, a
 * key that was already used, a tag that does not check. None of them are
 * distinguished, and none of them advance the ratchet, so a message that
 * cannot be opened costs nothing but itself.
 */
export function ratchetDecrypt(
  session: Session,
  header: RatchetHeader,
  ciphertext: string,
  aad: Uint8Array,
): { session: Session; plaintext: string } | null {
  const open = (key: Uint8Array): string | null => {
    try {
      return new TextDecoder().decode(messageCipher(key, aad).decrypt(fromB64(ciphertext)));
    } catch {
      return null;
    }
  };

  // A message that arrived late, whose key was kept on the way past.
  const skippedKey = `${header.dh}|${header.n}`;
  const stored = session.skipped[skippedKey];
  if (stored) {
    const plaintext = open(fromB64(stored));
    if (plaintext === null) return null;
    const skipped = { ...session.skipped };
    delete skipped[skippedKey];
    return { session: { ...session, skipped }, plaintext };
  }

  try {
    let next = session;

    // Their ratchet moved on. Close out the chain we were reading first: the
    // messages we never saw from it may still turn up.
    if (header.dh !== session.theirRatchet) {
      const closed = skipTo(next, header.pn);
      if (!closed) return null;
      next = turn(closed, header.dh);
    }

    const caughtUp = skipTo(next, header.n);
    if (!caughtUp || !caughtUp.recvChain) return null;

    const [messageKey, nextChain] = chainStep(fromB64(caughtUp.recvChain));
    const plaintext = open(messageKey);
    if (plaintext === null) return null;

    return {
      session: {
        ...caughtUp,
        recvChain: toB64(nextChain),
        recvCount: caughtUp.recvCount + 1,
        // They have answered, so the X3DH preamble has done its job.
        pending: null,
      },
      plaintext,
    };
  } catch {
    return null;
  }
}
