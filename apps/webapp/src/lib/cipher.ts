import { ed25519 } from '@noble/curves/ed25519.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { accept, initiate, ratchetDecrypt, ratchetEncrypt } from './ratchet';
import type { PreKeyHeader, RecipientPrivates, Session } from './ratchet';

/**
 * The envelope: what goes on the wire around a ratcheted message.
 *
 * The ratchet in `ratchet.ts` decides what the key is and destroys it
 * afterwards. This file decides what travels beside the ciphertext, what is
 * authenticated, and who is allowed to have written it:
 *
 *   • the **header** — which device sealed it, which device it is for, where in
 *     the ratchet it sits, and, until the other end answers, the X3DH preamble
 *     that lets them build the same session. It is the AEAD's associated data,
 *     so none of it can be changed without the tag failing.
 *
 *   • the **signature** — Ed25519 over the header and the ciphertext, by the
 *     identity key the safety number is computed from. Without it, "who sent
 *     this" would be a database column: the prekeys a session starts from are
 *     public, so anybody at all can start one and claim to be anybody. With it,
 *     comparing safety numbers in person protects something.
 *
 * `openSealed` also refuses when the envelope's claimed author is not the
 * person the server says wrote the message. That is what stops a sealed body
 * being lifted off one message and hung under another name.
 *
 * Every refusal returns the same null: a copy for another device, a prekey this
 * device no longer holds, a signature that does not check, a message key
 * already used. The caller says "this device cannot read this", which is true
 * of all of them, and none of them tell an attacker which one they hit.
 */

const PREFIX = 'yr.v2.';
const DOMAIN = 'yappy.e2e.v2';

/**
 * Separates header fields: a unit separator, which cannot occur in base64, a
 * uuid or a decimal number, so the joined string parses back exactly one way.
 * Without it `pn=1, n=23` and `pn=12, n=3` would authenticate the same bytes.
 */
const SEP = '\u001f';

// ─── base64, on bytes; identical in a browser and in node ────────────────────

const toB64 = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
const fromB64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

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

export type { RecipientPrivates, Session };

/** The header, before it is signed and after it is parsed. */
interface Header {
  v: number;
  /** Sending device, and the account it belongs to. Both are claims until checked. */
  s: string;
  u: string;
  /** The one device this copy is for. */
  r: string;
  /** The sender's current ratchet public key. */
  d: string;
  /** The previous chain's length, and the position in this one. */
  pn: number;
  n: number;
  /** The X3DH preamble, until the other end has answered. */
  k: PreKeyHeader | null;
  c: string;
  /** Ed25519 over everything above. */
  g: string;
}

// ─── the bytes that get signed and authenticated ─────────────────────────────

/**
 * Everything about a message except its body, in a fixed order — the AEAD's
 * associated data, and, with the ciphertext appended, what the identity key
 * signs. One field list, because a field in one and not the other is a hole.
 */
const fields = (h: Omit<Header, 'c' | 'g'>): Array<string | number> => [
  DOMAIN,
  h.v,
  h.s,
  h.u,
  h.r,
  h.d,
  h.pn,
  h.n,
  h.k?.ek ?? '-',
  h.k?.spkId ?? '-',
  h.k?.otkId ?? '-',
];

const headerBytes = (h: Omit<Header, 'c' | 'g'>): Uint8Array => utf8ToBytes(fields(h).join(SEP));

const signedBytes = (h: Omit<Header, 'g'>): Uint8Array =>
  utf8ToBytes([...fields(h), h.c].join(SEP));

// ─── sealing ─────────────────────────────────────────────────────────────────

/**
 * Start a session with a device that has never been spoken to.
 *
 * Throws when the bundle's signed prekey is not signed by the identity key it
 * claims to come from. That signature is the only thing between a sender and a
 * prekey the server invented, so a bad one is refused rather than encrypted to
 * — the caller drops that device, and if that leaves nobody, sends in the clear
 * rather than into a hole.
 */
export function beginSession(bundle: RecipientBundle): Session {
  const identityKey = fromB64(bundle.identityKey);
  const spk = fromB64(bundle.signedPreKey.key);
  if (!ed25519.verify(fromB64(bundle.signedPreKey.signature), spk, identityKey)) {
    throw new Error('signed prekey for device ' + bundle.deviceId + ' does not verify');
  }
  return initiate(bundle);
}

/**
 * One sealed copy, for one device, and the session that replaces this one.
 *
 * The session is returned rather than written here: the caller holds the lock
 * on it (see `sessions.ts`) and is the only thing that knows whether the send
 * survived. A ratchet that steps forward on a message that never left is a
 * conversation nobody can continue.
 */
export function sealWith(
  session: Session,
  plaintext: string,
  sender: SenderIdentity,
): { envelope: string; session: Session } | null {
  // Where the next message will sit in the ratchet, without stepping it: the
  // header has to exist before the associated data can bind it, and the
  // associated data has to exist before the message can be encrypted under it.
  const head = {
    v: 2,
    s: sender.deviceId,
    u: sender.userId,
    r: session.deviceId,
    d: session.myRatchetPublic,
    pn: session.previousSendCount,
    n: session.sendCount,
    k: session.pending,
  };

  const sealed = ratchetEncrypt(session, plaintext, headerBytes(head));
  if (!sealed) return null;

  const c = sealed.ciphertext;
  const g = toB64(ed25519.sign(signedBytes({ ...head, c }), fromB64(sender.identityPrivate)));

  return {
    envelope: PREFIX + toB64(utf8ToBytes(JSON.stringify({ ...head, c, g }))),
    session: sealed.session,
  };
}

// ─── opening ─────────────────────────────────────────────────────────────────

function parse(envelope: string | null | undefined): Header | null {
  if (!envelope?.startsWith(PREFIX)) return null;
  try {
    const h = JSON.parse(new TextDecoder().decode(fromB64(envelope.slice(PREFIX.length)))) as Header;
    return h.v === 2 && h.s && h.u && h.r && h.d && h.c && h.g ? h : null;
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
 * The message and the session that replaces this one, or null.
 *
 * `session` may be null when this is the first message from a device: the
 * preamble on it is what builds the session, and a message carrying none is one
 * this device can no longer place.
 *
 * A null result leaves the caller's stored session untouched on purpose — the
 * ratchet must not step forward on a message that could not be read.
 *
 * `consumedPreKeyId` is set when a session was built here rather than handed
 * in. That prekey has now done the only job it has, and the caller must
 * delete its private half: a one-time prekey that survives its one time lets
 * the same first message be replayed into a fresh session for as long as it
 * exists, which both re-opens a message that should be spent and throws away
 * the real session in the process.
 */
export function openSealed(
  envelope: string | null | undefined,
  session: Session | null,
  me: RecipientPrivates & { deviceId: string },
  senderIdentityKey: string | null,
  expectedAuthorId: string,
): { plaintext: string; session: Session; consumedPreKeyId: number | null } | null {
  const h = parse(envelope);
  if (!h || !senderIdentityKey) return null;

  // Addressed to this device, and from the person the server says wrote it.
  if (h.r !== me.deviceId || h.u !== expectedAuthorId) return null;

  try {
    if (!ed25519.verify(fromB64(h.g), signedBytes(h), fromB64(senderIdentityKey))) return null;

    const wire = { dh: h.d, pn: h.pn, n: h.n, pre: h.k };
    const aad = headerBytes(h);

    // A session this device does not have yet. The preamble is what builds it.
    const fresh = session ? null : h.k ? accept(h.k, me, h.s) : null;
    const known = session ?? fresh;
    if (!known) return null;

    const opened = ratchetDecrypt(known, wire, h.c, aad);
    if (opened) {
      return {
        plaintext: opened.plaintext,
        session: opened.session,
        consumedPreKeyId: fresh ? (h.k?.otkId ?? null) : null,
      };
    }

    // A stored session that cannot read a message still carrying a preamble is
    // a session built from a different one: the sender reinstalled, or this
    // device restored an older copy of itself. Rebuilding from the preamble is
    // the only way back, and it is exactly what a changed safety number means.
    if (!h.k || !session) return null;
    const restarted = accept(h.k, me, h.s);
    if (!restarted) return null;
    const retry = ratchetDecrypt(restarted, wire, h.c, aad);
    return retry
      ? { plaintext: retry.plaintext, session: retry.session, consumedPreKeyId: h.k.otkId }
      : null;
  } catch {
    return null;
  }
}
