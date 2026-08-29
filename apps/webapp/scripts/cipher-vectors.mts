import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { beginSession, openSealed, sealWith } from '../src/lib/cipher.ts';
import type { RecipientBundle } from '../src/lib/cipher.ts';

/**
 * The cross-platform test vectors.
 *
 * Three clients implement this cipher and they have to agree on every byte that
 * is hashed, signed, or authenticated. Each of them round-tripping with itself
 * proves nothing about that — a shared mistake round-trips beautifully. So each
 * platform seals one message with the fixed keys in this file, the result is
 * committed, and every platform's test opens all of them.
 *
 * Running this regenerates the web entry and checks that every other entry
 * still opens. It never mints new keys once the file exists: those keys *are*
 * the vectors, and rotating them would quietly invalidate the other platforms'
 * entries instead of failing.
 *
 *   pnpm --filter @yappy/webapp cipher-vectors
 *
 * Everything in that file is test material. It is committed to a public
 * repository and protects nothing.
 */

const PATH = new URL('../../../packages/shared/vectors/e2e.json', import.meta.url);
const toB64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

interface Vectors {
  note: string;
  plaintext: string;
  recipient: {
    userId: string;
    deviceId: string;
    identityPublic: string;
    /** So a test can sign a reply and turn the ratchet, not only open one. */
    identityPrivate: string;
    signedPreKey: { id: number; key: string; signature: string };
    signedPreKeyPrivate: string;
    oneTimePreKey: { id: number; key: string };
    preKeys: Record<string, string>;
  };
  sender: { userId: string; deviceId: string; identityPublic: string; identityPrivate: string };
  /** platform → an envelope that platform produced. */
  sealed: Record<string, string>;
}

/** Minted once, on the first run, and never again. */
function mint(): Vectors {
  const recipientIdentity = ed25519.utils.randomSecretKey();
  const spkPrivate = x25519.utils.randomSecretKey();
  const spkPublic = x25519.getPublicKey(spkPrivate);
  const otkPrivate = x25519.utils.randomSecretKey();
  const senderIdentity = ed25519.utils.randomSecretKey();

  return {
    note:
      'Cross-platform vectors for the yr.v2 message format — the double ratchet. ' +
      'Each client seals one first message with the fixed keys below, its envelope ' +
      'is committed under `sealed`, and every client opens all of them: a round ' +
      'trip against yourself proves nothing when three implementations have to ' +
      'agree byte for byte. A first message carries its own X3DH preamble, which ' +
      'is why these open with no stored session. Web regenerates its entry with ' +
      '`pnpm --filter @yappy/webapp cipher-vectors`; Android prints its own from ' +
      '`./gradlew :app:testDebugUnitTest`; Apple has no entry yet, because it ' +
      'needs a Mac and that project has no test target. Everything here is test ' +
      'material, committed to a public repository, protecting nothing.',
    plaintext: 'the eagle lands at noon — ünïcode, emoji 🔒, and a | pipe',
    recipient: {
      userId: '00000000-0000-4000-8000-00000000beef',
      deviceId: '00000000-0000-4000-8000-0000000000d1',
      identityPublic: toB64(ed25519.getPublicKey(recipientIdentity)),
      identityPrivate: toB64(recipientIdentity),
      signedPreKey: {
        id: 1,
        key: toB64(spkPublic),
        signature: toB64(ed25519.sign(spkPublic, recipientIdentity)),
      },
      signedPreKeyPrivate: toB64(spkPrivate),
      oneTimePreKey: { id: 7, key: toB64(x25519.getPublicKey(otkPrivate)) },
      preKeys: { '7': toB64(otkPrivate) },
    },
    sender: {
      userId: '00000000-0000-4000-8000-00000000cafe',
      deviceId: '00000000-0000-4000-8000-0000000000d2',
      identityPublic: toB64(ed25519.getPublicKey(senderIdentity)),
      identityPrivate: toB64(senderIdentity),
    },
    sealed: {},
  };
}

if (!existsSync(PATH)) mkdirSync(new URL('.', PATH), { recursive: true });
const v: Vectors = existsSync(PATH) ? (JSON.parse(readFileSync(PATH, 'utf8')) as Vectors) : mint();

const bundle: RecipientBundle = {
  userId: v.recipient.userId,
  deviceId: v.recipient.deviceId,
  identityKey: v.recipient.identityPublic,
  signedPreKey: v.recipient.signedPreKey,
  oneTimePreKey: v.recipient.oneTimePreKey,
};

v.sealed.web = sealWith(beginSession(bundle), v.plaintext, {
  deviceId: v.sender.deviceId,
  userId: v.sender.userId,
  identityPrivate: v.sender.identityPrivate,
})!.envelope;

const privates = {
  deviceId: v.recipient.deviceId,
  signedPreKeyId: v.recipient.signedPreKey.id,
  signedPreKeyPrivate: v.recipient.signedPreKeyPrivate,
  preKeys: v.recipient.preKeys as unknown as Record<number, string>,
};

let failures = 0;
for (const [platform, envelope] of Object.entries(v.sealed)) {
  const ok =
    openSealed(envelope, null, privates, v.sender.identityPublic, v.sender.userId)?.plaintext ===
    v.plaintext;
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : '  FAIL'}  web opens the ${platform} vector`);
}

writeFileSync(PATH, JSON.stringify(v, null, 2) + '\n');
console.log(failures === 0 ? '\nall green' : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
