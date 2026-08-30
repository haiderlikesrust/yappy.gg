import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import {
  MESSAGE_FORMATS,
  NEWEST_MESSAGE_FORMAT,
  formatsAdvertisement,
} from '@yappy/shared';
import { beginSession, openSealed, readFormats, sealWith } from '../src/lib/cipher.ts';
import type { RecipientBundle, Session } from '../src/lib/cipher.ts';

/**
 * An encrypted message, through the real server, with the real ratchet.
 *
 * The sibling script in apps/api checks the *envelope* — storage, per-device
 * delivery, search, previews — with a deliberately fake cipher. This one checks
 * the encryption: keys published to the directory the way a client publishes
 * them, a bundle claimed the way a client claims one, a session started, a
 * message sealed, sent, read back over HTTP, opened by the devices that were
 * meant to open it and by nobody else — and then a reply, which is what turns
 * the ratchet.
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
 * A signed-in device that has published keys, holding what `lib/keys.ts` holds
 * and, in place of IndexedDB, its sessions in a map.
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
    sessions: new Map<string, Session>(),
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
    formats: {
      versions: [...MESSAGE_FORMATS],
      signature: toB64(
        ed25519.sign(
          new TextEncoder().encode(formatsAdvertisement([...MESSAGE_FORMATS])),
          identityPrivate,
        ),
      ),
    },
  });
  if (publish.status !== 200) throw new Error(`publish failed: ${JSON.stringify(publish.body)}`);

  return device;
}

type Device = Awaited<ReturnType<typeof signIn>>;

// Two people, and one of them holding two devices — the case that decides
// whether your own tablet can read what you sent from your laptop.
const aliceLaptop = await signIn('webclient.test@yappy.gg', 'ratchet alice laptop');
const aliceTablet = await signIn('webclient.test@yappy.gg', 'ratchet alice tablet');
const bobPhone = await signIn('webclient.test2@yappy.gg', 'ratchet bob phone');
const stranger = await signIn('webclient.test2@yappy.gg', 'ratchet bob old phone');

const dm = await call(aliceLaptop.token, 'POST', '/conversations', {
  type: 'dm',
  memberIds: [bobPhone.userId],
});
const conversationId = dm.body.conversation.id as string;

// ─── seal, exactly as the client does ────────────────────────────────────────

/** Everybody's devices, minus the one sending: a ratchet cannot talk to itself. */
const wanted = [aliceTablet.deviceId, bobPhone.deviceId];

const claimed = await call(aliceLaptop.token, 'POST', '/keys/claim', {
  userIds: [aliceLaptop.userId, bobPhone.userId],
  deviceIds: wanted,
});
const bundles = (claimed.body.bundles ?? []) as RecipientBundle[];

check('the claim answers about exactly the devices asked for', bundles.length === wanted.length,
  `${bundles.length} of ${wanted.length}`);
check(
  'and carries a signed prekey',
  Boolean(bundles[0]?.signedPreKey?.key && bundles[0]?.signedPreKey?.signature),
);

const SECRET = 'the eagle lands at noon — and the server must not know it';

function sealFrom(from: Device, bundlesFor: RecipientBundle[], text: string) {
  return bundlesFor.map((bundle) => {
    const session = from.sessions.get(bundle.deviceId) ?? beginSession(bundle);
    const sealed = sealWith(session, text, from.sender, NEWEST_MESSAGE_FORMAT)!;
    from.sessions.set(bundle.deviceId, sealed.session);
    return { deviceId: bundle.deviceId, ciphertext: sealed.envelope };
  });
}

const envelopes = sealFrom(aliceLaptop, bundles, SECRET);
check('every intended device got a copy', envelopes.length === 2);
check(
  'the copies are all different',
  new Set(envelopes.map((e) => e.ciphertext)).size === envelopes.length,
);

const sent = await call(aliceLaptop.token, 'POST', `/conversations/${conversationId}/messages`, {
  nonce: `ratchet_${process.pid}_${Date.now() % 100000}`,
  type: 'text',
  content: NOTICE,
  envelopes,
});
check('the send was accepted', sent.status === 201, `status ${sent.status}`);
const messageId = sent.body.message?.id as string;

// ─── read it back over HTTP ──────────────────────────────────────────────────

async function fetchMessage(who: Device) {
  const res = await call(who.token, 'GET', `/conversations/${conversationId}/messages?limit=20`);
  return (res.body.messages ?? []).find((m: { id: string }) => m.id === messageId);
}

const [onLaptop, onTablet, onPhone, onStranger] = await Promise.all(
  [aliceLaptop, aliceTablet, bobPhone, stranger].map(fetchMessage),
);

check('the message comes back marked encrypted', onPhone?.isEncrypted === true);
check('the stored body is the notice, not the message', onPhone?.content === NOTICE);
check('the server never saw the plaintext', !JSON.stringify(onPhone ?? {}).includes(SECRET));

function open(msg: { ciphertext?: string | null } | undefined, who: Device, from: Device) {
  const opened = openSealed(
    msg?.ciphertext,
    who.sessions.get(from.deviceId) ?? null,
    who.privates,
    from.identityPublic,
    from.userId,
  );
  if (opened) {
    who.sessions.set(from.deviceId, opened.session);
    // Exactly what the client does: a prekey that has started a session is
    // spent, and it is spending it that makes the first message unreplayable.
    if (opened.consumedPreKeyId !== null) delete who.privates.preKeys[opened.consumedPreKeyId];
  }
  return opened?.plaintext ?? null;
}

check("the recipient's phone reads it", open(onPhone, bobPhone, aliceLaptop) === SECRET);
check("the sender's own tablet reads it", open(onTablet, aliceTablet, aliceLaptop) === SECRET);
check(
  'the sending device gets no copy of its own — the ratchet cannot address itself',
  !onLaptop?.ciphertext,
);
check('a device outside the fan-out gets no copy', !onStranger?.ciphertext);

check(
  'a stolen copy does not open on the wrong device',
  openSealed(onPhone?.ciphertext, null, stranger.privates, aliceLaptop.identityPublic, aliceLaptop.userId) ===
    null,
);
check(
  'a body attributed to the wrong author does not open',
  openSealed(onPhone?.ciphertext, null, bobPhone.privates, aliceLaptop.identityPublic, bobPhone.userId) ===
    null,
);
check(
  'and it does not open a second time — the message key is gone',
  open(onPhone, bobPhone, aliceLaptop) === null,
);

// ─── the reply, which is what turns the ratchet ──────────────────────────────

const replyEnvelopes = sealFrom(
  bobPhone,
  [
    {
      userId: aliceLaptop.userId,
      deviceId: aliceLaptop.deviceId,
      identityKey: aliceLaptop.identityPublic,
      // Bob already has a session with Alice's laptop, so none of this is used;
      // it is here because the fan-out is written in terms of bundles.
      signedPreKey: { id: 1, key: '', signature: '' },
      oneTimePreKey: null,
    },
  ],
  'i am here',
);

const replied = await call(bobPhone.token, 'POST', `/conversations/${conversationId}/messages`, {
  nonce: `ratchet_reply_${process.pid}_${Date.now() % 100000}`,
  type: 'text',
  content: NOTICE,
  envelopes: replyEnvelopes,
});
check('the reply was accepted', replied.status === 201, `status ${replied.status}`);

const replyAtAlice = await (async () => {
  const res = await call(aliceLaptop.token, 'GET', `/conversations/${conversationId}/messages?limit=5`);
  return (res.body.messages ?? []).find((m: { id: string }) => m.id === replied.body.message?.id);
})();
check(
  'the reply opens back on the laptop, one ratchet turn later',
  open(replyAtAlice, aliceLaptop, bobPhone) === 'i am here',
);

// ─── the rest of the product still behaves ───────────────────────────────────

// ─── what each device says it can read ───────────────────────────────────────

{
  const directory = await call(aliceLaptop.token, 'GET', `/keys/user/${bobPhone.userId}`);
  const entry = (directory.body.devices ?? []).find(
    (d: { deviceId: string }) => d.deviceId === bobPhone.deviceId,
  ) as { identityKey: string; formats: string | null; formatsSignature: string | null };

  check('the directory hands back what a device advertised', entry?.formats === MESSAGE_FORMATS.join(','));
  check(
    'and the advertisement verifies against that device',
    readFormats(entry?.formats, entry?.formatsSignature, entry?.identityKey).join() ===
      MESSAGE_FORMATS.join(),
  );
  check(
    'a shrunken list does not verify, so a downgrade is refused',
    readFormats('1', entry?.formatsSignature, entry?.identityKey).join() !== '1',
  );
}

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

console.log(failures === 0 ? '\nall green' : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
