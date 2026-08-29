import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { openSealed, sealTo } from '../src/lib/cipher.ts';
import type { RecipientBundle } from '../src/lib/cipher.ts';

/**
 * An encrypted message, through the real server, with the real cipher.
 *
 * The sibling script in apps/api checks the *envelope* — storage, per-device
 * delivery, search, previews — with a deliberately fake cipher. This one checks
 * the encryption: keys published to the directory the way a client publishes
 * them, a bundle claimed the way a client claims one, a message sealed, sent,
 * read back over HTTP, and opened by the devices that were meant to open it and
 * by nobody else.
 *
 * Needs the local stack up and the two dev accounts seeded.
 *
 *   pnpm --filter @yappy/webapp e2e-check
 */

const API = 'http://localhost:3000/v1';
const PASSWORD = 'yappy-web-dev-2026';
const NOTICE = 'This message is encrypted. Update yappy to read it.';

const toB64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ok  ' : '  FAIL'}  ${name}${detail && !ok ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

async function call(token: string, method: string, path: string, payload?: unknown) {
  const res = await fetch(API + path, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

/**
 * A signed-in device that has published keys, holding the private halves the
 * way `lib/keys.ts` holds them.
 */
async function signIn(email: string, deviceName: string) {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      password: PASSWORD,
      client: { platform: 'web', version: '1.0.0', device: deviceName },
    }),
  });
  const body = await res.json();
  if (!body.accessToken) throw new Error(`login failed for ${email}: ${JSON.stringify(body)}`);
  const claims = JSON.parse(Buffer.from(body.accessToken.split('.')[1]!, 'base64').toString());

  const identityPrivate = ed25519.utils.randomSecretKey();
  const spkPrivate = x25519.utils.randomSecretKey();
  const spkPublic = x25519.getPublicKey(spkPrivate);
  const preKeys: Record<number, string> = {};
  const published: Array<{ id: number; key: string }> = [];
  for (let id = 1; id <= 5; id += 1) {
    const priv = x25519.utils.randomSecretKey();
    preKeys[id] = toB64(priv);
    published.push({ id, key: toB64(x25519.getPublicKey(priv)) });
  }

  const device = {
    name: deviceName,
    token: body.accessToken as string,
    deviceId: claims.did as string,
    userId: body.user.id as string,
    identityPublic: toB64(ed25519.getPublicKey(identityPrivate)),
    sender: {
      deviceId: claims.did as string,
      userId: body.user.id as string,
      identityPrivate: toB64(identityPrivate),
    },
    privates: {
      deviceId: claims.did as string,
      signedPreKeyId: 1,
      signedPreKeyPrivate: toB64(spkPrivate),
      preKeys,
    },
  };

  const publish = await call(device.token, 'POST', '/keys/publish', {
    deviceId: device.deviceId,
    identityKey: device.identityPublic,
    signedPreKey: {
      id: 1,
      key: toB64(spkPublic),
      signature: toB64(ed25519.sign(spkPublic, identityPrivate)),
    },
    oneTimePreKeys: published,
  });
  if (publish.status !== 200) throw new Error(`publish failed: ${JSON.stringify(publish.body)}`);

  return device;
}

// Two people, and one of them holding two devices — the case that decides
// whether your own laptop can read what you sent from your phone.
const aliceLaptop = await signIn('webclient.test@yappy.gg', 'e2e alice laptop');
const aliceTablet = await signIn('webclient.test@yappy.gg', 'e2e alice tablet');
const bobPhone = await signIn('webclient.test2@yappy.gg', 'e2e bob phone');
const stranger = await signIn('webclient.test2@yappy.gg', 'e2e bob old phone');

const dm = await call(aliceLaptop.token, 'POST', '/conversations', {
  type: 'dm',
  memberIds: [bobPhone.userId],
});
const conversationId = dm.body.conversation.id as string;

// ─── seal, exactly as the client does ────────────────────────────────────────

const claimed = await call(aliceLaptop.token, 'POST', '/keys/claim', {
  userIds: [aliceLaptop.userId, bobPhone.userId],
});
const bundles = (claimed.body.bundles ?? []) as RecipientBundle[];

check('the directory returned bundles', bundles.length > 0);
check(
  'the claim carries a signed prekey',
  Boolean(bundles[0]?.signedPreKey?.key && bundles[0]?.signedPreKey?.signature),
);

const SECRET = 'the eagle lands at noon — and the server must not know it';

// Everybody the claim returned, including this device: there is no local
// message store, so an envelope addressed to the sender is how the sender
// reads their own history tomorrow.
const wanted = new Set([aliceLaptop.deviceId, aliceTablet.deviceId, bobPhone.deviceId]);
const envelopes = bundles
  .filter((b) => wanted.has(b.deviceId))
  .map((b) => ({ deviceId: b.deviceId, ciphertext: sealTo(SECRET, b, aliceLaptop.sender) }));

check('every intended device got a copy', envelopes.length === 3, `${envelopes.length} of 3`);
check(
  'the copies are all different',
  new Set(envelopes.map((e) => e.ciphertext)).size === envelopes.length,
);

const sent = await call(aliceLaptop.token, 'POST', `/conversations/${conversationId}/messages`, {
  nonce: `e2e_${process.pid}_${envelopes.length}_${bundles.length}`,
  type: 'text',
  content: NOTICE,
  envelopes,
});
check('the send was accepted', sent.status === 201, `status ${sent.status}`);
const messageId = sent.body.message?.id as string;

// ─── read it back over HTTP ──────────────────────────────────────────────────

async function fetchMessage(who: { token: string }) {
  const res = await call(who.token, 'GET', `/conversations/${conversationId}/messages?limit=20`);
  return (res.body.messages ?? []).find((m: { id: string }) => m.id === messageId);
}

const [onLaptop, onTablet, onPhone, onStranger] = await Promise.all(
  [aliceLaptop, aliceTablet, bobPhone, stranger].map(fetchMessage),
);

check('the message comes back marked encrypted', onPhone?.isEncrypted === true);
check('the stored body is the notice, not the message', onPhone?.content === NOTICE);
check('the server never saw the plaintext', JSON.stringify(onPhone ?? {}).includes(SECRET) === false);

const open = (msg: { ciphertext?: string | null } | undefined, who: typeof bobPhone) =>
  openSealed(msg?.ciphertext, who.privates, aliceLaptop.identityPublic, aliceLaptop.userId);

check("the recipient's phone reads it", open(onPhone, bobPhone) === SECRET);
check("the sender's own tablet reads it", open(onTablet, aliceTablet) === SECRET);
check('the sending device reads its own copy back', open(onLaptop, aliceLaptop) === SECRET);

check('a device outside the fan-out gets no copy', !onStranger?.ciphertext);
check(
  'and could not open one if it stole it',
  openSealed(onPhone?.ciphertext, stranger.privates, aliceLaptop.identityPublic, aliceLaptop.userId) ===
    null,
);
check(
  "a copy cannot be opened with another device's keys",
  openSealed(onPhone?.ciphertext, aliceTablet.privates, aliceLaptop.identityPublic, aliceLaptop.userId) ===
    null,
);
check(
  'a body attributed to the wrong author does not open',
  openSealed(onPhone?.ciphertext, bobPhone.privates, aliceLaptop.identityPublic, bobPhone.userId) === null,
);

// ─── the rest of the product still behaves ───────────────────────────────────

const search = await call(bobPhone.token, 'GET', '/search/messages?q=eagle');
check(
  'an encrypted message is not searchable',
  !(search.body.messages ?? []).some((m: { id: string }) => m.id === messageId),
);

const list = await call(bobPhone.token, 'GET', '/conversations?limit=20');
const row = (list.body.conversations ?? []).find((c: { id: string }) => c.id === conversationId);
check(
  'the conversation list shows no preview of it',
  !JSON.stringify(row?.lastMessage ?? {}).includes('eagle'),
);

const envelope = await call(
  bobPhone.token,
  'GET',
  `/conversations/${conversationId}/messages/${messageId}/envelope`,
);
check(
  'the envelope endpoint hands a device its own copy',
  openSealed(envelope.body.ciphertext, bobPhone.privates, aliceLaptop.identityPublic, aliceLaptop.userId) ===
    SECRET,
);

console.log(failures === 0 ? '\nall green' : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
