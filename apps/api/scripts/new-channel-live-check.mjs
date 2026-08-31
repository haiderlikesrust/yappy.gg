/**
 * A channel made while you are already connected has to reach you.
 *
 * A client subscribes to conversation topics at IDENTIFY and whenever a
 * `conversation.create` names a new one. Channel creation announced neither —
 * it published `conversation.update { channelsChanged }` to the *space* topic,
 * which says the list moved and subscribes nobody to anything.
 *
 * So a support bot opening a ticket for somebody delivered nothing live to
 * them: no message event, no banner, no badge. The first they knew of their
 * own ticket was finding it by hand.
 *
 * This holds a real socket open, creates a channel admitting that account, and
 * requires both the announcement and the first message to arrive on it.
 *
 *   pnpm --filter @yappy/api new-channel-live-check
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

const owner = await login('webclient.test@yappy.gg', 'live owner');
const mate = await login('webclient.test2@yappy.gg', 'live mate');

const space = (
  await call(owner, 'POST', '/conversations', { type: 'space', title: `live ${Date.now()}` })
).body.conversation;
const invite = await call(owner, 'POST', `/conversations/${space.id}/invites`, {});
await call(mate, 'POST', `/conversations/invites/${invite.body.invite?.code ?? invite.body.code}/join`, {});

// ─── mate's socket, connected before the channel exists ──────────────────────

const seen = { created: null, message: null };
const socket = new WebSocket(GATEWAY);
const subscribed = new Set();

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('gateway never sent READY')), 15_000);
  socket.onmessage = (raw) => {
    const frame = JSON.parse(String(raw.data));
    // HELLO → IDENTIFY → READY, the ordinary handshake.
    if (frame.op === 0) {
      socket.send(JSON.stringify({
        op: 1,
        d: { token: mate.token, client: { platform: 'web', version: '1.0.0' } },
      }));
      return;
    }
    if (frame.op === 2) {
      clearTimeout(timer);
      // The gateway closes an idle socket at 4009; this check outlives that
      // only if it keeps the heartbeat up like a real client.
      const beat = setInterval(() => socket.send(JSON.stringify({ op: 3 })), 15_000);
      socket.addEventListener('close', () => clearInterval(beat));
      resolve();
      return;
    }
    if (frame.op !== 5) return;

    if (frame.t === 'conversation.create') {
      seen.created = frame.d;
      /*
       * What a real client does with the announcement, and the whole point of
       * sending it: subscribe, so messages in the new room arrive live.
       */
      const id = frame.d?.id;
      if (id && !subscribed.has(id)) {
        subscribed.add(id);
        socket.send(JSON.stringify({ op: 10, d: { c: 'conversation.subscribe', conversationId: id }, nonce: id }));
      }
    }
    if (frame.t === 'message.create') seen.message = frame.d;
  };
  socket.onerror = () => reject(new Error('socket error'));
});

console.log('\nA channel created while they are connected\n');

const ticket = (
  await call(owner, 'POST', `/conversations/${space.id}/channels`, {
    title: `ticket-${Date.now()}`,
    isPrivate: true,
    members: [mate.userId],
  })
).body.channel;

await new Promise((r) => setTimeout(r, 1500));
check(
  'the person admitted is told it exists',
  seen.created?.id === ticket.id,
  'without this they only find it by refreshing the channel list by hand',
);

await call(owner, 'POST', `/conversations/${ticket.id}/messages`, {
  type: 'text',
  nonce: `live-${Date.now()}`,
  content: 'Hello — someone will be with you shortly.',
});

await new Promise((r) => setTimeout(r, 1500));
check(
  'and the first message arrives live',
  seen.message?.conversationId === ticket.id,
  'this is what raises the in-app banner and the unread badge',
);

socket.close();
await call(owner, 'DELETE', `/conversations/${space.id}`);

console.log(failures === 0 ? '\n✓ a new room announces itself\n' : `\n✗ ${failures} failure(s)\n`);
process.exit(failures === 0 ? 0 : 1);
