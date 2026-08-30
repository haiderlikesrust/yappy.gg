/**
 * Realtime regression test, for the two ways an event can fail to arrive.
 *
 *   1. **Channels.** A space member has no `conversation_members` row in a
 *      channel until something has to be written down there. Every membership
 *      check in the gateway therefore has to resolve through the space, or a
 *      member who has not yet spoken in a channel gets nothing live in it:
 *      no messages, no typing, nobody shown as here.
 *
 *   2. **Other devices.** The client that sent a message already has it. The
 *      rest of that account's devices do not, and used to be skipped along
 *      with it — a message sent on the laptop reached the phone only when the
 *      phone next refetched.
 *
 * Both are invisible in single-device, single-client testing, which is how
 * they lasted. Run against a local api (:3000) and gateway (:3001):
 *
 *   pnpm --filter @yappy/gateway realtime
 */
import WebSocket from 'ws';
import { createDb } from '@yappy/db';

const API = 'http://localhost:3000/v1';
const WS_URL = 'ws://localhost:3001';
const PASSWORD = 'correct-horse-battery-staple';
const stamp = Date.now().toString(36);

let failures = 0;
const ok = (label, extra = '') => console.log(`  ok   ${label}${extra ? ' — ' + extra : ''}`);
const bad = (label, detail) => {
  failures++;
  console.log(`  FAIL ${label} — ${detail}`);
};

async function call(method, path, { token, body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (res.status >= 300) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
  return json;
}

const register = (username) =>
  call('POST', '/auth/register', {
    body: {
      email: `${username}@example.test`,
      password: PASSWORD,
      username,
      displayName: username,
      client: { platform: 'android', version: '1.0.0' },
    },
  }).then((r) => ({ token: r.accessToken, userId: r.user.id, username }));

/** A second sign-in is a second device, which is the whole point of part 2. */
const login = (username, platform) =>
  call('POST', '/auth/login', {
    body: {
      email: `${username}@example.test`,
      password: PASSWORD,
      client: { platform, version: '1.0.0', device: platform },
    },
  }).then((r) => r.accessToken);

/** A gateway connection that keeps every dispatch it is sent. */
class Client {
  constructor(label, token) {
    this.label = label;
    this.token = token;
    this.events = [];
    this.acks = new Map();
    this.n = 0;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(WS_URL);
      const timer = setTimeout(() => reject(new Error(`${this.label}: no READY`)), 10_000);
      this.ws.on('message', (raw) => {
        const frame = JSON.parse(raw.toString());
        if (frame.op === 0) {
          this.ws.send(
            JSON.stringify({
              op: 1,
              d: {
                token: this.token,
                protocolVersion: 1,
                client: { platform: 'web', version: '1.0.0' },
                presence: 'online',
              },
            }),
          );
        } else if (frame.op === 2) {
          clearTimeout(timer);
          resolve(this);
        } else if (frame.op === 5) {
          this.events.push({ t: frame.t, d: frame.d });
        } else if (frame.op === 11) {
          this.acks.get(frame.nonce)?.(frame.d);
          this.acks.delete(frame.nonce);
        }
      });
      this.ws.on('error', reject);
    });
  }

  command(body) {
    const nonce = `n${++this.n}`;
    return new Promise((resolve) => {
      this.acks.set(nonce, resolve);
      this.ws.send(JSON.stringify({ op: 10, nonce, d: body }));
      setTimeout(() => resolve({ ok: false, error: 'timeout' }), 5_000);
    });
  }

  async waitFor(pred, ms = 4_000) {
    const deadline = Date.now() + ms;
    for (;;) {
      const hit = this.events.find(pred);
      if (hit) return hit;
      if (Date.now() > deadline) return null;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  close() {
    this.ws?.close();
  }
}

const { sql } = createDb({ url: process.env.DATABASE_URL, max: 2 });

// ── A space, and someone in it who has never opened one of its channels ─────
console.log('\n── setup ──────────────────────────────────────────');
const alice = await register(`rt_a_${stamp}`);
const bob = await register(`rt_b_${stamp}`);

const { conversation } = await call('POST', '/conversations', {
  token: alice.token,
  body: { type: 'group', title: `space ${stamp}` },
});
const spaceId = conversation.id;
await call('POST', `/conversations/${spaceId}/upgrade-to-space`, { token: alice.token, body: {} });

const { invite } = await call('POST', `/conversations/${spaceId}/invites`, {
  token: alice.token,
  body: { maxUses: 0 },
});
await call('POST', `/conversations/invites/${invite.code}/join`, { token: bob.token, body: {} });
ok('bob joined the space');

const { channel } = await call('POST', `/conversations/${spaceId}/channels`, {
  token: alice.token,
  body: { title: `quiet-${stamp}` },
});
ok('channel created', channel.id);

const held = (
  await sql`select conversation_id from conversation_members
             where user_id = ${bob.userId}
               and conversation_id in ${sql([spaceId, channel.id])}`
).map((r) => r.conversation_id);
held.includes(spaceId) && !held.includes(channel.id)
  ? ok('bob is a member of the channel without a row in it', 'the case that used to break')
  : bad('bob is a member of the channel without a row in it', JSON.stringify(held));

// ── 1. Everything live, for a member with no row ────────────────────────────
console.log('\n── channel realtime ───────────────────────────────');
const bobWs = await new Client('bob', bob.token).connect();
const aliceWs = await new Client('alice', alice.token).connect();

const sub = await bobWs.command({ c: 'conversation.subscribe', conversationId: channel.id });
sub.ok ? ok('conversation.subscribe accepted') : bad('conversation.subscribe accepted', JSON.stringify(sub));

await call('POST', `/conversations/${channel.id}/messages`, {
  token: alice.token,
  body: { nonce: `m1_${stamp}`, type: 'text', content: 'live or not' },
});
const got = await bobWs.waitFor((e) => e.t === 'message.create' && e.d?.conversationId === channel.id);
got ? ok('message arrived live', got.d.content) : bad('message arrived live', 'no event');

await aliceWs.command({ c: 'conversation.subscribe', conversationId: channel.id });
await aliceWs.command({ c: 'typing.start', conversationId: channel.id });
const typing = await bobWs.waitFor((e) => e.t === 'typing.start' && e.d?.conversationId === channel.id);
typing ? ok('typing indicator arrived') : bad('typing indicator arrived', 'no event');

const presence = await bobWs.command({ c: 'presence.query', conversationId: channel.id });
presence.ok && presence.online?.some((p) => p.userId === alice.userId)
  ? ok('presence.query sees the room', `${presence.online.length} online`)
  : bad('presence.query sees the room', JSON.stringify(presence));

const viewing = await bobWs.command({ c: 'conversation.viewing', conversationId: channel.id });
viewing.ok ? ok('conversation.viewing accepted') : bad('conversation.viewing accepted', JSON.stringify(viewing));

const read = await bobWs.command({ c: 'read.ack', conversationId: channel.id, seq: got?.d?.seq ?? 1 });
read.ok && read.unreadCount === 0
  ? ok('read.ack cleared the badge', `lastReadSeq ${read.lastReadSeq}`)
  : bad('read.ack cleared the badge', JSON.stringify(read));

// ── 2. The account's other devices ──────────────────────────────────────────
console.log('\n── second device, same account ────────────────────');
const phone = await new Client('alice-phone', await login(alice.username, 'ios')).connect();
await phone.command({ c: 'conversation.subscribe', conversationId: channel.id });

await call('POST', `/conversations/${channel.id}/messages`, {
  token: alice.token,
  body: { nonce: `m2_${stamp}`, type: 'text', content: 'sent from the laptop' },
});

const onPhone = await phone.waitFor((e) => e.t === 'message.create' && e.d?.content === 'sent from the laptop');
onPhone ? ok('the phone got what the laptop sent') : bad('the phone got what the laptop sent', 'no event');

const echoes = aliceWs.events.filter((e) => e.t === 'message.create' && e.d?.content === 'sent from the laptop');
echoes.length === 0
  ? ok('the sending device got no echo of its own')
  : bad('the sending device got no echo of its own', `${echoes.length} echoes`);

await new Promise((r) => setTimeout(r, 300));
bobWs.close();
aliceWs.close();
phone.close();
await sql.end();

console.log(`\n${failures === 0 ? 'all green' : `${failures} failure(s)`}\n`);
process.exit(failures === 0 ? 0 : 1);
