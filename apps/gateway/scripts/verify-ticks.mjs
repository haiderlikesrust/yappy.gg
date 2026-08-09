/**
 * Exercise the delivery/read tick flow end to end against the dev stack:
 * identify-time catch-up, delivery.ack, and the receipt events a DM sender
 * relies on for the second tick.
 */
import WebSocket from 'ws';

const API = 'http://localhost:3000/v1';
const GATEWAY = 'ws://localhost:3001';
const stamp = Math.floor(Math.random() * 1e9).toString(36);

const call = async (token, method, path, body) => {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const register = async (name) => {
  const r = await call(null, 'POST', '/auth/register', {
    email: `${name}_${stamp}@example.com`,
    password: 'correct horse battery staple',
    username: `${name}${stamp}`.slice(0, 20),
    client: { platform: 'ios', version: '1.0.0' },
  });
  if (r.status >= 300) throw new Error(`register ${name}: ${JSON.stringify(r.body)}`);
  return { token: r.body.accessToken, id: r.body.user.id, username: r.body.user.username };
};

/** Minimal gateway client: HELLO → IDENTIFY → READY, then commands + events. */
const connect = async (token) => {
  const { body } = await call(token, 'POST', '/auth/gateway-ticket');
  const ticket = body.ticket;
  if (!ticket) throw new Error('no ticket');

  const ws = new WebSocket(GATEWAY);
  const events = [];
  let nonce = 0;
  const acks = new Map();

  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('gateway handshake timeout')), 8000);
    ws.on('message', (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.op === 0) {
        ws.send(JSON.stringify({
          op: 1,
          d: {
            token: ticket,
            protocolVersion: 1,
            client: { platform: 'ios', version: '1.0.0' },
            presence: 'online',
            cursors: [],
          },
        }));
      } else if (frame.op === 2) {
        clearTimeout(timer);
        resolve(frame.d);
      } else if (frame.op === 5) {
        events.push({ t: frame.t, d: frame.d });
      } else if (frame.op === 11) {
        acks.get(frame.nonce)?.(frame.d);
      }
    });
    ws.on('error', reject);
  });

  const command = (payload) =>
    new Promise((resolve) => {
      const n = `n${++nonce}`;
      acks.set(n, resolve);
      ws.send(JSON.stringify({ op: 10, nonce: n, d: payload }));
      setTimeout(() => resolve({ ok: false, error: 'ack timeout' }), 4000);
    });

  return { ws, ready, events, command };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── The scenario ─────────────────────────────────────────────────────────────

const alice = await register('tick_a');
const bob = await register('tick_b');
console.log(`alice=@${alice.username}  bob=@${bob.username}`);

const dm = await call(alice.token, 'POST', '/conversations', { type: 'dm', memberIds: [bob.id] });
const conversationId = dm.body.conversation.id;

const m1 = await call(alice.token, 'POST', `/conversations/${conversationId}/messages`, {
  nonce: `t1_${Date.now()}`, type: 'text', content: 'first — sent while bob is offline',
});
const seq1 = m1.body.message.seq;

let receipts = await call(alice.token, 'GET', `/conversations/${conversationId}/receipts?seq=0`);
let bobRow = receipts.body.readBy.find((r) => r.user.id === bob.id);
console.log(`before bob connects:  delivered=${bobRow?.deliveredSeq}  read=${bobRow?.seq}   (want 0/0)`);

// Alice online to catch the receipt events a real sender would see.
const aliceWs = await connect(alice.token);

// Bob connects: the identify catch-up should mark everything delivered.
const bobWs = await connect(bob.token);
await sleep(600);

receipts = await call(alice.token, 'GET', `/conversations/${conversationId}/receipts?seq=0`);
bobRow = receipts.body.readBy.find((r) => r.user.id === bob.id);
console.log(`after bob connects:   delivered=${bobRow?.deliveredSeq}  read=${bobRow?.seq}   (want ${seq1}/0)`);
const catchupEvent = aliceWs.events.find((e) => e.t === 'delivery.receipt');
console.log(`alice saw delivery.receipt from catch-up: ${catchupEvent ? 'yes, seq ' + catchupEvent.d.seq : 'NO'}`);

// Second message while bob is connected; bob's client delivery-acks it.
const m2 = await call(alice.token, 'POST', `/conversations/${conversationId}/messages`, {
  nonce: `t2_${Date.now()}`, type: 'text', content: 'second — bob is online now',
});
const seq2 = m2.body.message.seq;
await sleep(400);

const ackResult = await bobWs.command({ c: 'delivery.ack', conversationId, seq: seq2 });
console.log(`delivery.ack answer:  ${JSON.stringify(ackResult)}   (want ok + seq ${seq2})`);
await sleep(400);

const liveEvent = aliceWs.events.filter((e) => e.t === 'delivery.receipt').at(-1);
console.log(`alice's live receipt: seq=${liveEvent?.d?.seq}   (want ${seq2})`);

// Bob reads; alice should see the read receipt that turns the ticks blue.
await bobWs.command({ c: 'read.ack', conversationId, seq: seq2 });
await sleep(400);
const readEvent = aliceWs.events.find((e) => e.t === 'read.receipt');
console.log(`alice's read receipt: seq=${readEvent?.d?.seq}   (want ${seq2})`);

receipts = await call(alice.token, 'GET', `/conversations/${conversationId}/receipts?seq=${seq2}`);
console.log(`seen-by for seq ${seq2}:  ${receipts.body.readBy.map((r) => '@' + r.user.username).join(', ')}   (want bob only or bob+alice)`);

aliceWs.ws.close();
bobWs.ws.close();
console.log('done');
process.exit(0);
