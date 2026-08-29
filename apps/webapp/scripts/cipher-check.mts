import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { beginSession, isSealed, openSealed, sealWith, sealedSender } from '../src/lib/cipher.ts';
import type { RecipientBundle, Session } from '../src/lib/cipher.ts';

/**
 * The envelope, and what it must refuse.
 *
 * The ratchet underneath has its own tests — chains, skipped messages, replay.
 * What is checked here is the layer around it: the header that gets bound, the
 * signature that says who wrote it, and the four or five ways somebody could
 * try to move a sealed body somewhere it does not belong.
 *
 *   pnpm --filter @yappy/webapp cipher-check
 */

const toB64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ok  ' : '  FAIL'}  ${name}${detail && !ok ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

/** A device, both halves: what it publishes and what it keeps. */
function makeDevice(userId: string, deviceId: string) {
  const identityPrivate = ed25519.utils.randomSecretKey();
  const spkPrivate = x25519.utils.randomSecretKey();
  const spkPublic = x25519.getPublicKey(spkPrivate);
  const otkPrivate = x25519.utils.randomSecretKey();

  return {
    userId,
    deviceId,
    identityPublic: toB64(ed25519.getPublicKey(identityPrivate)),
    sender: { deviceId, userId, identityPrivate: toB64(identityPrivate) },
    privates: {
      deviceId,
      signedPreKeyId: 1,
      signedPreKeyPrivate: toB64(spkPrivate),
      preKeys: { 7: toB64(otkPrivate) },
    },
    bundle: {
      userId,
      deviceId,
      identityKey: toB64(ed25519.getPublicKey(identityPrivate)),
      signedPreKey: {
        id: 1,
        key: toB64(spkPublic),
        signature: toB64(ed25519.sign(spkPublic, identityPrivate)),
      },
      oneTimePreKey: { id: 7, key: toB64(x25519.getPublicKey(otkPrivate)) },
    } satisfies RecipientBundle,
  };
}

const alice = makeDevice('user-alice', 'device-alice');
const bob = makeDevice('user-bob', 'device-bob');
const bobPhone = makeDevice('user-bob', 'device-bob-phone');
const mallory = makeDevice('user-mallory', 'device-mallory');

const MESSAGE = 'meet me at the usual place — 8pm 🔒';

// ─── it works at all ─────────────────────────────────────────────────────────

const started = beginSession(bob.bundle);
const first = sealWith(started, MESSAGE, alice.sender)!;

check('sealed output is recognisably sealed', isSealed(first.envelope));
check(
  'the sender is readable before the key is fetched',
  sealedSender(first.envelope)?.deviceId === 'device-alice' &&
    sealedSender(first.envelope)?.userId === 'user-alice',
);

const opened = openSealed(first.envelope, null, bob.privates, alice.identityPublic, 'user-alice');
check('a first message builds the session and opens', opened?.plaintext === MESSAGE);

const reply = sealWith(opened!.session, 'i am here', bob.sender)!;
const backAtAlice = openSealed(
  reply.envelope,
  first.session,
  alice.privates,
  bob.identityPublic,
  'user-bob',
);
check('the reply opens on the other side', backAtAlice?.plaintext === 'i am here');

// ─── the server learns nothing ───────────────────────────────────────────────

const decoded = Buffer.from(first.envelope.slice('yr.v2.'.length), 'base64').toString('utf8');
check('the plaintext is nowhere in the envelope', !decoded.includes('usual place'));

const again = sealWith(first.session, MESSAGE, alice.sender)!;
check('the same message sealed twice differs', again.envelope !== first.envelope);

// ─── it refuses the rest ─────────────────────────────────────────────────────

check(
  "another device cannot open bob's copy",
  openSealed(first.envelope, null, bobPhone.privates, alice.identityPublic, 'user-alice') === null,
);

/** Rewrite the header, leaving the signature over the old one. */
function tamper(envelope: string, edit: (h: Record<string, unknown>) => void): string {
  const h = JSON.parse(Buffer.from(envelope.slice('yr.v2.'.length), 'base64').toString('utf8'));
  edit(h);
  return 'yr.v2.' + Buffer.from(JSON.stringify(h), 'utf8').toString('base64');
}

check(
  'a flipped byte in the ciphertext does not open',
  openSealed(
    tamper(first.envelope, (h) => {
      const c = Buffer.from(h.c as string, 'base64');
      c[0] ^= 0xff;
      h.c = c.toString('base64');
    }),
    null,
    bob.privates,
    alice.identityPublic,
    'user-alice',
  ) === null,
);

check(
  'readdressing a copy to another device does not open it',
  openSealed(
    tamper(first.envelope, (h) => {
      h.r = 'device-bob-phone';
    }),
    null,
    bobPhone.privates,
    alice.identityPublic,
    'user-alice',
  ) === null,
);

check(
  'moving it along the ratchet does not open it',
  openSealed(
    tamper(first.envelope, (h) => {
      h.n = 3;
    }),
    null,
    bob.privates,
    alice.identityPublic,
    'user-alice',
  ) === null,
);

check(
  "a body signed by mallory does not pass as alice's",
  openSealed(
    sealWith(beginSession(bob.bundle), MESSAGE, {
      ...mallory.sender,
      // Claiming to be alice, signing as mallory.
      deviceId: 'device-alice',
      userId: 'user-alice',
    })!.envelope,
    null,
    bob.privates,
    alice.identityPublic,
    'user-alice',
  ) === null,
);

check(
  'a genuine message from mallory is not shown as being from alice',
  openSealed(
    sealWith(beginSession(bob.bundle), MESSAGE, mallory.sender)!.envelope,
    null,
    bob.privates,
    mallory.identityPublic,
    'user-alice',
  ) === null,
);

check(
  'without the sender key there is no decryption at all',
  openSealed(first.envelope, null, bob.privates, null, 'user-alice') === null,
);

check(
  'an envelope from the previous format does not open',
  openSealed('yx3dh.v1.abc', null, bob.privates, alice.identityPublic, 'user-alice') === null,
);

// A prekey the server invented: right shape, wrong signature.
let threw = false;
try {
  beginSession({
    ...bob.bundle,
    signedPreKey: {
      ...bob.bundle.signedPreKey,
      key: toB64(x25519.getPublicKey(x25519.utils.randomSecretKey())),
    },
  });
} catch {
  threw = true;
}
check('a prekey the server swapped is refused, not encrypted to', threw);

// ─── a session that has moved on ─────────────────────────────────────────────

{
  // Alice reinstalls: new session, same identity. Bob's stored session cannot
  // read the new preamble, and has to start again rather than go silent.
  const stale = openSealed(first.envelope, null, bob.privates, alice.identityPublic, 'user-alice')!;
  const restarted = beginSession(bob.bundle);
  const afterReinstall = sealWith(restarted, 'i got a new laptop', alice.sender)!;
  const read = openSealed(
    afterReinstall.envelope,
    stale.session,
    bob.privates,
    alice.identityPublic,
    'user-alice',
  );
  check('a sender who started again is still readable', read?.plaintext === 'i got a new laptop');
}

{
  // And a failed open must not move the stored session on.
  const session: Session = JSON.parse(JSON.stringify(first.session)) as Session;
  const before = JSON.stringify(session);
  openSealed(
    sealWith(beginSession(bob.bundle), 'nope', mallory.sender)!.envelope,
    session,
    bob.privates,
    alice.identityPublic,
    'user-alice',
  );
  check('a refusal leaves the session where it was', JSON.stringify(session) === before);
}

console.log(failures === 0 ? '\nall green' : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
