import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';

/**
 * The cipher. This one is real.
 *
 * It replaces a placeholder that base64'd the message and called it sealed.
 * What is here now is an ephemeral-static key agreement — the shape X3DH
 * gives, over the key material the directory has been publishing since the
 * groundwork went in — with a detached signature for authorship:
 *
 *   1. the sender mints a throwaway X25519 keypair, one per recipient device
 *      per message, and drops the private half when it is done;
 *   2. it agrees a secret with that device's **signed prekey**, and, when the
 *      device still has one unclaimed, also with a **one-time prekey**;
 *   3. both agreements go to HKDF, which produces one message key that is
 *      never used for anything else;
 *   4. ChaCha20-Poly1305 encrypts under it, with the whole header as associated
 *      data — so a ciphertext cannot be moved to another device, another
 *      sender, or another message without the tag failing;
 *   5. the sender signs the header and the ciphertext with its **identity
 *      key**, which is the key the safety number is computed from.
 *
 * Step 5 is not decoration. Ephemeral-static agreement encrypts *to* somebody
 * without saying anything about who it came from: the recipient's prekeys are
 * public, so anybody at all can produce a ciphertext that decrypts. The
 * signature is what makes "who sent this" a cryptographic claim rather than a
 * database column, and it is checked against the same key the person read
 * aloud when they compared safety numbers.
 *
 * **What this does not do yet.** There is no ratchet. Message keys are derived
 * fresh and discarded, so they do not chain, but a device that keeps its prekey
 * privates — which this one does, because history has to survive a reload and
 * there is no local plaintext store yet — could decrypt any ciphertext still on
 * the server if it were later compromised. That is the forward-secrecy gap, it
 * is the reason the ratchet exists, and it is written here rather than implied
 * by silence. What the server can read: nothing. That part is done.
 */

const PREFIX = 'yx3dh.v1.';
const DOMAIN = 'yappy.e2e.v1';
/** A constant, so both sides derive the same thing without exchanging it. */
const SALT = sha256(utf8ToBytes(DOMAIN + '.salt'));
/**
 * Separates header fields: a unit separator, which cannot occur in base64, a
 * uuid or a decimal number, so the joined string parses back exactly one way.
 * Without it `p=1, o=23` and `p=12, o=3` would authenticate the same bytes.
 */
const SEP = '\u001f';

// ─── base64, on bytes; identical in a browser and in node ────────────────────

const toB64 = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
const fromB64 = (text: string): Uint8Array =>
  Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

// ─── shapes ──────────────────────────────────────────────────────────────────

/** One recipient device, exactly as `POST /keys/claim` returns it. */
export interface RecipientBundle {
  userId: string;
  deviceId: string;
  identityKey: string;
  signedPreKey: { id: number; key: string; signature: string };
  oneTimePreKey: { id: number; key: string } | null;
}

/** The sending device: who it is, and the key that proves it. */
export interface SenderIdentity {
  deviceId: string;
  userId: string;
  identityPrivate: string;
}

/** The receiving device's private halves, as `keys.ts` stores them. */
export interface RecipientPrivates {
  deviceId: string;
  signedPreKeyId: number;
  signedPreKeyPrivate: string;
  preKeys: Record<number, string>;
}

/** The header, before it is signed and after it is parsed. */
interface Header {
  v: number;
  /** Sending device, and the user it belongs to. Both are claims until checked. */
  s: string;
  u: string;
  /** The one device this copy is for. */
  r: string;
  /** Ephemeral X25519 public key, this message only. */
  e: string;
  /** Which of the recipient's prekeys were used. */
  p: number;
  o: number | null;
  n: string;
  c: string;
  /** Ed25519 over everything above. */
  g: string;
}

// ─── the bytes that get signed and authenticated ─────────────────────────────

/**
 * Everything about a message except its body, in a fixed order.
 *
 * Used twice: as the AEAD's associated data, which binds the ciphertext to this
 * sender, this recipient device and these prekeys; and, with the ciphertext
 * appended, as what the identity key signs. A field present in one and missing
 * from the other would be a hole, so there is one field list.
 */
const fields = (h: Omit<Header, 'c' | 'g'>): Array<string | number> => [
  DOMAIN,
  h.v,
  h.s,
  h.u,
  h.r,
  h.e,
  h.p,
  h.o ?? '-',
];

const headerBytes = (h: Omit<Header, 'c' | 'g'>): Uint8Array =>
  utf8ToBytes(fields(h).join(SEP));

const signedBytes = (h: Omit<Header, 'g'>): Uint8Array =>
  utf8ToBytes([...fields(h), h.c].join(SEP));

/**
 * The message key.
 *
 * Two agreements when the recipient had a one-time prekey to spare, one when it
 * did not — X3DH's documented degraded mode, and the reason the pool gets
 * topped up rather than relied on. Concatenated, not combined: HKDF is what
 * mixes them, and it is the only thing that should.
 */
function messageKey(dhSpk: Uint8Array, dhOtk: Uint8Array | null, info: Uint8Array): Uint8Array {
  const ikm = dhOtk ? new Uint8Array([...dhSpk, ...dhOtk]) : dhSpk;
  return hkdf(sha256, ikm, SALT, info, 32);
}

// ─── sealing ─────────────────────────────────────────────────────────────────

/**
 * One sealed copy, for one device.
 *
 * Throws if the bundle's signed prekey is not signed by the identity key it
 * claims to come from. That signature is the only thing between a sender and a
 * prekey the server invented, so a bad one is refused rather than encrypted to
 * — the caller drops that device, and if that leaves nobody, sends in the clear
 * rather than into a hole.
 */
export function sealTo(plaintext: string, bundle: RecipientBundle, sender: SenderIdentity): string {
  const identityKey = fromB64(bundle.identityKey);
  const spk = fromB64(bundle.signedPreKey.key);
  if (!ed25519.verify(fromB64(bundle.signedPreKey.signature), spk, identityKey)) {
    throw new Error('signed prekey for device ' + bundle.deviceId + ' does not verify');
  }

  const ephemeral = x25519.utils.randomSecretKey();
  const dhSpk = x25519.getSharedSecret(ephemeral, spk);
  const dhOtk = bundle.oneTimePreKey
    ? x25519.getSharedSecret(ephemeral, fromB64(bundle.oneTimePreKey.key))
    : null;

  const head = {
    v: 1,
    s: sender.deviceId,
    u: sender.userId,
    r: bundle.deviceId,
    e: toB64(x25519.getPublicKey(ephemeral)),
    p: bundle.signedPreKey.id,
    o: bundle.oneTimePreKey?.id ?? null,
    n: toB64(randomBytes(12)),
  };

  const aad = headerBytes(head);
  const key = messageKey(dhSpk, dhOtk, aad);
  const c = toB64(chacha20poly1305(key, fromB64(head.n), aad).encrypt(utf8ToBytes(plaintext)));
  const g = toB64(ed25519.sign(signedBytes({ ...head, c }), fromB64(sender.identityPrivate)));

  return PREFIX + toB64(utf8ToBytes(JSON.stringify({ ...head, c, g })));
}

// ─── opening ─────────────────────────────────────────────────────────────────

function parse(envelope: string | null | undefined): Header | null {
  if (!envelope?.startsWith(PREFIX)) return null;
  try {
    const h = JSON.parse(new TextDecoder().decode(fromB64(envelope.slice(PREFIX.length)))) as Header;
    return h.v === 1 && h.s && h.u && h.r && h.e && h.n && h.c && h.g ? h : null;
  } catch {
    return null;
  }
}

/**
 * Who a sealed message claims to be from, so the reader knows whose identity
 * key to fetch. A claim, and treated as one: `openSealed` believes it only
 * after the signature checks out against that key.
 */
export function sealedSender(
  envelope: string | null | undefined,
): { deviceId: string; userId: string } | null {
  const h = parse(envelope);
  return h ? { deviceId: h.s, userId: h.u } : null;
}

/** Whether this is a sealed envelope at all, without trying to open it. */
export function isSealed(envelope: string | null | undefined): boolean {
  return Boolean(envelope?.startsWith(PREFIX));
}

/**
 * The message, or null — and null is a real answer, not only an error.
 *
 * Every reason to refuse ends the same way, on purpose: a copy addressed to
 * another device, a prekey this device no longer holds, a signature from
 * somebody other than the person the server says wrote it, a tag that does not
 * check. The caller shows "this device cannot read this", which is true of all
 * of them, and none of them tell an attacker which one they hit.
 */
export function openSealed(
  envelope: string | null | undefined,
  me: RecipientPrivates,
  senderIdentityKey: string | null,
  expectedAuthorId: string,
): string | null {
  const h = parse(envelope);
  if (!h || !senderIdentityKey) return null;

  // Addressed to this device, and from the person the server says wrote it.
  // The second check is what stops a sealed body being lifted off one message
  // and hung under somebody else's name.
  if (h.r !== me.deviceId || h.u !== expectedAuthorId) return null;

  try {
    if (!ed25519.verify(fromB64(h.g), signedBytes(h), fromB64(senderIdentityKey))) return null;

    if (h.p !== me.signedPreKeyId) return null;
    // A client that omits the key rather than writing null means the same
    // thing by it, so the check is loose on purpose.
    const otk = h.o ?? null;
    const otkPrivate = otk === null ? null : me.preKeys[otk];
    if (otk !== null && !otkPrivate) return null;

    const ephemeral = fromB64(h.e);
    const dhSpk = x25519.getSharedSecret(fromB64(me.signedPreKeyPrivate), ephemeral);
    const dhOtk = otkPrivate ? x25519.getSharedSecret(fromB64(otkPrivate), ephemeral) : null;

    const aad = headerBytes(h);
    const key = messageKey(dhSpk, dhOtk, aad);
    return new TextDecoder().decode(
      chacha20poly1305(key, fromB64(h.n), aad).decrypt(fromB64(h.c)),
    );
  } catch {
    return null;
  }
}
