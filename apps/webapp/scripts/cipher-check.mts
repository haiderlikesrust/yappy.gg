import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { isSealed, openSealed, sealTo, sealedSender } from '../src/lib/cipher.ts';
import type { RecipientBundle, RecipientPrivates, SenderIdentity } from '../src/lib/cipher.ts';

/**
 * What the cipher is supposed to refuse.
 *
 * A round trip proves almost nothing on its own — base64 round-trips too, which
 * is exactly what this replaced. The tests that matter are the ones below it:
 * a copy addressed elsewhere, a body swapped after signing, a sender forged, a
 * prekey the server made up. Each has to come back null or throw, and none may
 * come back with somebody's message in it.
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
function makeDevice(userId: string, deviceId: string, preKeyCount = 2) {
  const identityPrivate = ed25519.utils.randomSecretKey();
  const spkPrivate = x25519.utils.randomSecretKey();
  const spkPublic = x25519.getPublicKey(spkPrivate);

  const preKeys: Record<number, string> = {};
  const published: Array<{ id: number; key: string }> = [];
  for (let id = 1; id <= preKeyCount; id += 1) {
    const priv = x25519.utils.randomSecretKey();
    preKeys[id] = toB64(priv);
    published.push({ id, key: toB64(x25519.getPublicKey(priv)) });
  }

  const bundle = (oneTimePreKey: { id: number; key: string } | null): RecipientBundle => ({
    userId,
    deviceId,
    identityKey: toB64(ed25519.getPublicKey(identityPrivate)),
    signedPreKey: {
      id: 1,
      key: toB64(spkPublic),
      signature: toB64(ed25519.sign(spkPublic, identityPrivate)),
    },
    oneTimePreKey,
  });

  return {
    sender: { deviceId, userId, identityPrivate: toB64(identityPrivate) } satisfies SenderIdentity,
    identityPublic: toB64(ed25519.getPublicKey(identityPrivate)),
    privates: {
      deviceId,
      signedPreKeyId: 1,
      signedPreKeyPrivate: toB64(spkPrivate),
      preKeys,
    } satisfies RecipientPrivates,
    published,
    bundle,
  };
}

const alice = makeDevice('user-alice', 'device-alice');
const bob = makeDevice('user-bob', 'device-bob');
const bobPhone = makeDevice('user-bob', 'device-bob-phone');
const mallory = makeDevice('user-mallory', 'device-mallory');

const MESSAGE = 'meet me at the usual place — 8pm 🔒';

// ─── it works at all ─────────────────────────────────────────────────────────

const sealed = sealTo(MESSAGE, bob.bundle(bob.published[0]!), alice.sender);
check('sealed output is recognisably sealed', isSealed(sealed));
check(
  'round trip, with a one-time prekey',
  openSealed(sealed, bob.privates, alice.identityPublic, 'user-alice') === MESSAGE,
);

const noOtk = sealTo(MESSAGE, bob.bundle(null), alice.sender);
check(
  'round trip, when the prekey pool is empty',
  openSealed(noOtk, bob.privates, alice.identityPublic, 'user-alice') === MESSAGE,
);

check(
  'the sender is readable before the key is fetched',
  sealedSender(sealed)?.deviceId === 'device-alice' &&
    sealedSender(sealed)?.userId === 'user-alice',
);

// ─── the server learns nothing ───────────────────────────────────────────────

const decoded = Buffer.from(sealed.slice('yx3dh.v1.'.length), 'base64').toString('utf8');
check('the plaintext is nowhere in the envelope', !decoded.includes('usual place'));
check(
  'the same message sealed twice differs',
  sealTo(MESSAGE, bob.bundle(bob.published[1]!), alice.sender) !== sealed,
);

// ─── it refuses the rest ─────────────────────────────────────────────────────

check(
  "another device cannot open bob's copy",
  openSealed(sealed, bobPhone.privates, alice.identityPublic, 'user-alice') === null,
);

check(
  'a copy sealed for a second device is not readable by the first',
  openSealed(
    sealTo(MESSAGE, bobPhone.bundle(bobPhone.published[0]!), alice.sender),
    bob.privates,
    alice.identityPublic,
    'user-alice',
  ) === null,
);

/** Re-seal a header with the body swapped, then re-sign it as the attacker. */
function tamper(envelope: string, edit: (h: Record<string, unknown>) => void): string {
  const h = JSON.parse(Buffer.from(envelope.slice('yx3dh.v1.'.length), 'base64').toString('utf8'));
  edit(h);
  return 'yx3dh.v1.' + Buffer.from(JSON.stringify(h), 'utf8').toString('base64');
}

check(
  'a flipped byte in the ciphertext does not open',
  openSealed(
    tamper(sealed, (h) => {
      const c = Buffer.from(h.c as string, 'base64');
      c[0] ^= 0xff;
      h.c = c.toString('base64');
    }),
    bob.privates,
    alice.identityPublic,
    'user-alice',
  ) === null,
);

check(
  'readdressing a copy to another device does not open it',
  openSealed(
    tamper(sealed, (h) => {
      h.r = 'device-bob-phone';
    }),
    bobPhone.privates,
    alice.identityPublic,
    'user-alice',
  ) === null,
);

check(
  "a body signed by mallory does not pass as alice's",
  openSealed(
    sealTo(MESSAGE, bob.bundle(bob.published[0]!), {
      ...mallory.sender,
      // Claiming to be alice, signing as mallory.
      deviceId: 'device-alice',
      userId: 'user-alice',
    }),
    bob.privates,
    alice.identityPublic,
    'user-alice',
  ) === null,
);

check(
  'a genuine message from mallory is not shown as being from alice',
  openSealed(
    sealTo(MESSAGE, bob.bundle(bob.published[0]!), mallory.sender),
    bob.privates,
    mallory.identityPublic,
    'user-alice',
  ) === null,
);

check(
  'a prekey id this device never had does not open',
  openSealed(
    tamper(sealed, (h) => {
      h.o = 99;
    }),
    bob.privates,
    alice.identityPublic,
    'user-alice',
  ) === null,
);

check(
  'without the sender key there is no decryption at all',
  openSealed(sealed, bob.privates, null, 'user-alice') === null,
);

check('a stub envelope from the old build does not open', openSealed('stub.v0.abc', bob.privates, alice.identityPublic, 'user-alice') === null);

// A prekey the server invented: right shape, wrong signature.
const forgedBundle: RecipientBundle = {
  ...bob.bundle(null),
  signedPreKey: {
    id: 1,
    key: toB64(x25519.getPublicKey(x25519.utils.randomSecretKey())),
    signature: bob.bundle(null).signedPreKey.signature,
  },
};
let threw = false;
try {
  sealTo(MESSAGE, forgedBundle, alice.sender);
} catch {
  threw = true;
}
check('a prekey the server swapped is refused, not encrypted to', threw);

// ─── own devices ─────────────────────────────────────────────────────────────

const aliceTablet = makeDevice('user-alice', 'device-alice-tablet');
check(
  "alice's own tablet can read what her laptop sent",
  openSealed(
    sealTo(MESSAGE, aliceTablet.bundle(aliceTablet.published[0]!), alice.sender),
    aliceTablet.privates,
    alice.identityPublic,
    'user-alice',
  ) === MESSAGE,
);

console.log(failures === 0 ? '\nall green' : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
