/**
 * Reading a channel has to clear the badge above it.
 *
 * A space reports its channels' mentions along with its own, because a channel
 * never appears in the home list and a mention inside one would otherwise
 * reach nothing that draws a badge. The corollary is the bit that broke:
 * reading a channel changes a number on a row nobody was told about. Every
 * client patches its list by conversation id, the id on a read is the
 * channel's, and no row in the list matches it — so the badge sat at three
 * long after the mentions had been read.
 *
 * This holds the socket to the fix: after a read, a `conversation.state_update`
 * naming the *space* must arrive, carrying the recomputed roll-up.
 *
 *   pnpm --filter @yappy/api mention-rollup-check
 */
const API = 'http://localhost:3000/v1';
const GATEWAY = process.env.YAPPY_GATEWAY ?? 'ws://localhost:3001';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

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
  return { token: body.accessToken, userId: body.user.id };
};
const call = async (u, method, path, payload) => {
  const res = await fetch(API + path, {
    method,
    headers: { authorization: `Bearer ${u.token}`, 'content-type': 'application/json' },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
};

const owner = await login('webclient.test@yappy.gg', 'rollup owner');
const mate = await login('webclient.test2@yappy.gg', 'rollup mate');

const made = await call(owner, 'POST', '/conversations', {
  type: 'space',
  title: `rollup ${Date.now()}`,
});
if (!made.body.conversation) {
  console.log(`\n  --    could not create a space (${made.status}); the bucket refills slowly.\n`);
  process.exit(0);
}
const spaceId = made.body.conversation.id;

const invite = await call(owner, 'POST', `/conversations/${spaceId}/invites`, {});
await call(
  mate,
  'POST',
  `/conversations/invites/${invite.body.invite?.code ?? invite.body.code}/join`,
  {},
);
const channel = (
  await call(owner, 'POST', `/conversations/${spaceId}/channels`, { title: 'general' })
).body.channel;
if (!channel) {
  console.log('\n  --    could not create a channel (rate limited); try again in a minute.\n');
  process.exit(0);
}

// ─── the owner's socket, the way a client holds one ──────────────────────────

const seen = [];
const socket = new WebSocket(GATEWAY);
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('gateway never sent READY')), 15_000);
  socket.onmessage = (raw) => {
    const frame = JSON.parse(String(raw.data));
    if (frame.op === 0) {
      socket.send(JSON.stringify({
        op: 1,
        d: { token: owner.token, client: { platform: 'web', version: '1.0.0' } },
      }));
      return;
    }
    if (frame.op === 2) {
      clearTimeout(timer);
      const beat = setInterval(() => socket.send(JSON.stringify({ op: 3 })), 15_000);
      socket.addEventListener('close', () => clearInterval(beat));
      resolve();
      return;
    }
    if (frame.op === 5 && frame.t === 'conversation.state_update') seen.push(frame.d);
  };
  socket.onerror = () => reject(new Error('socket error'));
});

console.log('\nThree mentions in a channel\n');

seen.length = 0;
for (let i = 0; i < 3; i += 1) {
  const content = `@webclient_test rollup ${i + 1}`;
  await call(mate, 'POST', `/conversations/${channel.id}/messages`, {
    type: 'text',
    nonce: `ru-${Date.now()}-${i}`,
    content,
    entities: [{ type: 'mention', offset: 0, length: 15, userId: owner.userId }],
  });
}
await new Promise((r) => setTimeout(r, 1500));

/*
 * The badge has to *rise* on the socket as well as fall on one.
 *
 * `message.create` names the channel, and a channel is not in the home list —
 * so before this the number only moved on the next full fetch. Somebody with
 * the app open was told nothing at all.
 */
check(
  'the space is told its roll-up went up',
  seen.some((e) => e.conversationId === spaceId && e.mentionCount === 3),
  JSON.stringify(seen),
);

const listed = await call(owner, 'GET', '/conversations');
const spaceRow = (listed.body.conversations ?? []).find((c) => c.id === spaceId);
check(
  'the space reports them, though they are in a channel',
  spaceRow?.self?.mentionCount === 3,
  `got ${spaceRow?.self?.mentionCount} — a channel is not in the home list, so this is the only row that can carry them`,
);

console.log('\nReading the channel\n');

seen.length = 0;
const fresh = await call(owner, 'GET', `/conversations/${spaceId}/channels`);
const tip = (fresh.body.channels ?? []).find((c) => c.id === channel.id)?.latestSeq ?? 0;
await call(owner, 'POST', `/conversations/${channel.id}/read`, { seq: tip });
await new Promise((r) => setTimeout(r, 1500));

check(
  'the channel is told its own count is zero',
  seen.some((e) => e.conversationId === channel.id && e.mentionCount === 0),
  JSON.stringify(seen),
);
check(
  'and the space is told its roll-up is too',
  seen.some((e) => e.conversationId === spaceId && e.mentionCount === 0),
  'without this every client keeps drawing the old number: it patches by id, and the id on a read is the channel\'s',
);

const after = await call(owner, 'GET', '/conversations');
check(
  'which agrees with a fresh fetch',
  (after.body.conversations ?? []).find((c) => c.id === spaceId)?.self?.mentionCount === 0,
);

socket.close();
await call(owner, 'DELETE', `/conversations/${spaceId}`);

console.log(failures === 0 ? '\n✓ reading a room clears the badge above it\n' : `\n✗ ${failures} failure(s)\n`);
process.exit(failures === 0 ? 0 : 1);
