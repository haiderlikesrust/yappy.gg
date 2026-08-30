/**
 * The encrypted message path, end to end, with a placeholder cipher.
 *
 * Proves the plumbing the real ratchet will sit inside: one ciphertext per
 * recipient device, stored with the message, handed back only to the device it
 * was addressed to, invisible to search, and preview-free in the conversation
 * list. The "cipher" here is reversible nonsense on purpose — this checks the
 * envelope, not the encryption.
 */
const API = 'http://localhost:3000/v1';

const login = async (email, device) => {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      password: 'yappy-web-dev-2026',
      client: { platform: 'web', version: '1.0.0', device },
    }),
  });
  const body = await res.json();
  const did = JSON.parse(Buffer.from(body.accessToken.split('.')[1], 'base64').toString()).did;
  return { token: body.accessToken, deviceId: did, userId: body.user.id };
};

const call = async (token, method, path, payload) => {
  const res = await fetch(API + path, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
};

// Two people; one of them holding two devices, which is the case that matters.
const alice = await login('webclient.test@yappy.gg', 'alice laptop');
const bobPhone = await login('webclient.test2@yappy.gg', 'bob phone');
const bobTablet = await login('webclient.test2@yappy.gg', 'bob tablet');

const dm = await call(alice.token, 'POST', '/conversations', {
  type: 'dm',
  memberIds: [bobPhone.userId],
});
const conversationId = dm.body.conversation.id;

const seal = (text, deviceId) => Buffer.from(`stub:${deviceId}:${text}`).toString('base64');
const open = (blob) => Buffer.from(blob, 'base64').toString('utf8').split(':').slice(2).join(':');

const secret = 'the eagle lands at noon';
const sent = await call(alice.token, 'POST', `/conversations/${conversationId}/messages`, {
  nonce: `env_${Date.now()}`,
  type: 'text',
  content: 'This message is encrypted. Update yappy to read it.',
  envelopes: [
    { deviceId: bobPhone.deviceId, ciphertext: seal(secret, bobPhone.deviceId) },
    { deviceId: bobTablet.deviceId, ciphertext: seal(secret, bobTablet.deviceId) },
  ],
});

const historyFor = async (who) => {
  const res = await call(who.token, 'GET', `/conversations/${conversationId}/messages?limit=10`);
  // By id: the conversation may hold encrypted messages from an earlier run,
  // addressed to devices that no longer exist.
  return res.body.messages.find((m) => m.id === sent.body.message.id);
};

const onPhone = await historyFor(bobPhone);
const onTablet = await historyFor(bobTablet);
const onAlice = await historyFor(alice);

const search = await call(bobPhone.token, 'GET', '/search/messages?q=encrypted');
const list = await call(bobPhone.token, 'GET', '/conversations?limit=20');
const row = (list.body.conversations ?? []).find((c) => c.id === conversationId);

const checks = [
  ['the send was accepted', sent.status === 201],
  ['the message is marked encrypted', onPhone?.isEncrypted === true],
  ['the phone got a ciphertext', Boolean(onPhone?.ciphertext)],
  ['it decrypts to what was sent', open(onPhone?.ciphertext ?? '') === secret],
  ['the tablet got its own, different copy', onTablet?.ciphertext !== onPhone?.ciphertext],
  ['and it decrypts to the same message', open(onTablet?.ciphertext ?? '') === secret],
  [
    "the sender's device, addressed to nobody, gets none",
    onAlice?.isEncrypted === true && onAlice?.ciphertext === null,
  ],
  ['the notice is what a client that cannot read it sees', onPhone?.content?.includes('encrypted')],
  [
    'search does not return it',
    !(search.body.results ?? search.body.messages ?? []).some((m) => m.id === onPhone?.id),
  ],
  ['the conversation list says "Encrypted message"', row?.lastMessage?.preview === 'Encrypted message'],
];

for (const [what, ok] of checks) console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
const failed = checks.filter(([, ok]) => !ok).length;
if (failed) console.log('\n  list row was:', JSON.stringify(row?.lastMessage ?? row?.lastMessagePreview));
console.log(`\n${failed === 0 ? 'all green' : `${failed} failure(s)`}\n`);
process.exit(failed === 0 ? 0 : 1);
