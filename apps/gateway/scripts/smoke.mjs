import { readFileSync } from 'node:fs';
import WebSocket from 'ws';

/** pino-pretty colour codes. The ESC byte must be part of the pattern —
 *  stripping only the bracketed part leaves stray escapes behind. */
const ANSI = /\u001b\[[0-9;]*m/g;

const API = 'http://localhost:3000/v1';
const WS_URL = 'ws://localhost:3001';
const LOG = process.env.WORKER_LOG;

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
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

function latestCodeFor(phone) {
  // pino-pretty wraps keys in ANSI colour codes, so strip them before matching.
  const log = readFileSync(LOG, 'utf8').replace(ANSI, '');
  const escaped = phone.replace('+', '\\+');
  // `to:` and `code:` are adjacent lines in a raw worker log, but `pnpm dev`
  // prefixes every line with the package name, so they are not *literally*
  // adjacent. Allow a short gap rather than assuming either layout.
  const re = new RegExp(`to: "${escaped}"[\\s\\S]{0,120}?code: "(\\d{6})"`, 'g');
  let last = null, m;
  while ((m = re.exec(log)) !== null) last = m[1];
  return last;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function signUp(phone, username, displayName) {
  const req = await call('POST', '/auth/otp/request', { body: { phone } });
  if (req.status !== 200) throw new Error(`otp/request ${req.status} ${JSON.stringify(req.json)}`);

  let code = null;
  for (let i = 0; i < 25 && !code; i++) { await sleep(400); code = latestCodeFor(phone); }
  if (!code) throw new Error('no OTP code appeared in worker log');

  const verify = await call('POST', '/auth/otp/verify', {
    body: { phone, code, client: { platform: 'android', version: '1.0.0' } },
  });
  if (verify.status !== 200) throw new Error(`otp/verify ${verify.status} ${JSON.stringify(verify.json)}`);

  const token = verify.json.accessToken;
  if (verify.json.needsOnboarding) {
    const prof = await call('POST', '/auth/complete-profile', {
      token, body: { username, displayName },
    });
    if (prof.status !== 200) throw new Error(`complete-profile ${prof.status} ${JSON.stringify(prof.json)}`);
  }
  return { token, userId: verify.json.user.id, refreshToken: verify.json.refreshToken };
}

console.log('\n── health ─────────────────────────────────────────');
{
  const h = await fetch('http://localhost:3000/health').then((r) => r.json());
  h.ok ? ok('api /health') : bad('api /health', JSON.stringify(h));
  const g = await fetch('http://localhost:3001/health').then((r) => r.json());
  g.ok ? ok('gateway /health', `node ${g.node}`) : bad('gateway /health', JSON.stringify(g));
  const r = await fetch('http://localhost:3000/ready').then((r) => r.json());
  r.ok ? ok('api /ready (db reachable)') : bad('api /ready', JSON.stringify(r));
}

console.log('\n── auth ───────────────────────────────────────────');
const stamp = Date.now().toString().slice(-7);
const alice = await signUp(`+1555${stamp}`, `alice_${stamp}`, 'Alice');
ok('alice signed up + onboarded', alice.userId);
const bob = await signUp(`+1666${stamp}`, `bob_${stamp}`, 'Bob');
ok('bob signed up + onboarded', bob.userId);

{
  const r = await call('POST', '/auth/refresh', { body: { refreshToken: alice.refreshToken } });
  r.status === 200 && r.json.accessToken ? ok('refresh token rotation') : bad('refresh', JSON.stringify(r.json));
  const reuse = await call('POST', '/auth/refresh', { body: { refreshToken: alice.refreshToken } });
  reuse.status === 200 ? ok('previous refresh token accepted once (retry tolerance)')
                       : bad('refresh retry', `${reuse.status}`);
  alice.token = r.json.accessToken;
}

{
  const me = await call('GET', '/users/me', { token: alice.token });
  me.status === 200 ? ok('GET /users/me', me.json.user.username) : bad('/users/me', JSON.stringify(me.json));
  const noAuth = await call('GET', '/users/me');
  noAuth.status === 401 && noAuth.json.error?.code === 'unauthenticated'
    ? ok('unauthenticated request rejected with typed code')
    : bad('auth guard', `${noAuth.status}`);
}

console.log('\n── social graph ───────────────────────────────────');
{
  await call('POST', `/social/follow/${bob.userId}`, { token: alice.token });
  const back = await call('POST', `/social/follow/${alice.userId}`, { token: bob.token });
  // The default `whoCanAddToGroups` audience is "contacts", i.e. a mutual
  // follow — so this is a prerequisite for the group test below, not decoration.
  back.json.isMutual ? ok('mutual follow detected by trigger') : bad('mutual follow', JSON.stringify(back.json));
  const contacts = await call('GET', '/social/me/contacts', { token: alice.token });
  contacts.json.users?.length === 1 ? ok('mutual shows up in contacts') : bad('contacts', JSON.stringify(contacts.json));
}

console.log('\n── conversations ──────────────────────────────────');
const dm = await call('POST', '/conversations', {
  token: alice.token, body: { type: 'dm', memberIds: [bob.userId] },
});
dm.status === 201 ? ok('DM created', dm.json.conversation.id) : bad('create DM', JSON.stringify(dm.json));
const convId = dm.json.conversation?.id;

{
  const again = await call('POST', '/conversations', {
    token: alice.token, body: { type: 'dm', memberIds: [bob.userId] },
  });
  again.status === 200 && again.json.conversation.id === convId
    ? ok('duplicate DM resolves to the same conversation (dm_key)')
    : bad('DM idempotency', `${again.status} ${again.json.conversation?.id}`);
}

const group = await call('POST', '/conversations', {
  token: alice.token,
  body: { type: 'group', memberIds: [bob.userId], title: 'Smoke Test Group' },
});
group.status === 201 && group.json.conversation.memberCount === 2
  ? ok('group created', `${group.json.conversation.memberCount} members`)
  : bad('create group', JSON.stringify(group.json).slice(0, 200));
const groupId = group.json.conversation?.id;

console.log('\n── messages ───────────────────────────────────────');
let msgId, msgSeq;
{
  const send = await call('POST', `/conversations/${convId}/messages`, {
    token: alice.token, body: { nonce: `n_${stamp}_1`, type: 'text', content: 'hello from the smoke test' },
  });
  if (send.status === 201) { msgId = send.json.message.id; msgSeq = send.json.message.seq; ok('message sent', `seq=${msgSeq}`); }
  else bad('send message', JSON.stringify(send.json));

  const retry = await call('POST', `/conversations/${convId}/messages`, {
    token: alice.token, body: { nonce: `n_${stamp}_1`, type: 'text', content: 'hello from the smoke test' },
  });
  retry.status === 200 && retry.json.message.id === msgId
    ? ok('duplicate nonce returns the original message (idempotency)')
    : bad('nonce idempotency', `${retry.status}`);
}

{
  await call('POST', `/conversations/${convId}/messages`, {
    token: bob.token, body: { nonce: `n_${stamp}_2`, type: 'text', content: 'hi back' },
  });
  const hist = await call('GET', `/conversations/${convId}/messages?limit=10`, { token: alice.token });
  const seqs = hist.json.messages?.map((m) => m.seq);
  JSON.stringify(seqs) === JSON.stringify([1, 2])
    ? ok('history ordered by gapless seq', `[${seqs}]`)
    : bad('history', JSON.stringify(seqs));
}

{
  const edit = await call('PATCH', `/conversations/${convId}/messages/${msgId}`, {
    token: alice.token, body: { content: 'edited text' },
  });
  edit.status === 200 && edit.json.message.editedAt ? ok('message edited') : bad('edit', JSON.stringify(edit.json));

  const notMine = await call('PATCH', `/conversations/${convId}/messages/${msgId}`, {
    token: bob.token, body: { content: 'hijack' },
  });
  notMine.status === 404 ? ok("editing someone else's message returns 404") : bad('edit guard', `${notMine.status}`);
}

console.log('\n── reactions, pins, polls ─────────────────────────');
{
  const react = await call('PUT', `/conversations/${convId}/messages/${msgId}/reactions`, {
    token: bob.token, body: { emoji: '🔥' },
  });
  react.status === 200 ? ok('reaction added') : bad('react', JSON.stringify(react.json));

  const hist = await call('GET', `/conversations/${convId}/messages?limit=5`, { token: alice.token });
  const target = hist.json.messages.find((m) => m.id === msgId);
  target?.reactions?.['🔥'] === 1
    ? ok('reaction rollup maintained by trigger', JSON.stringify(target.reactions))
    : bad('reaction rollup', JSON.stringify(target?.reactions));

  await call('DELETE', `/conversations/${convId}/messages/${msgId}/reactions?emoji=${encodeURIComponent('🔥')}`, { token: bob.token });
  const after = await call('GET', `/conversations/${convId}/messages?limit=5`, { token: alice.token });
  const t2 = after.json.messages.find((m) => m.id === msgId);
  Object.keys(t2.reactions).length === 0 ? ok('reaction removed and key pruned') : bad('reaction remove', JSON.stringify(t2.reactions));
}

{
  const pin = await call('PUT', `/conversations/${convId}/pins/${msgId}`, { token: alice.token });
  pin.status === 200 ? ok('message pinned') : bad('pin', JSON.stringify(pin.json));
  const pins = await call('GET', `/conversations/${convId}/pins`, { token: alice.token });
  pins.json.pins?.length === 1 ? ok('pinned list returns the message') : bad('pins list', JSON.stringify(pins.json));
}

{
  const poll = await call('POST', `/conversations/${groupId}/messages`, {
    token: alice.token,
    body: {
      nonce: `n_${stamp}_poll`, type: 'poll',
      poll: { question: 'Ship it?', options: ['Yes', 'No'], multiSelect: false, anonymous: false },
    },
  });
  const pollMsgId = poll.json.message?.id;
  const optionId = poll.json.message?.poll?.options?.[0]?.id;
  poll.status === 201 && optionId ? ok('poll created', poll.json.message.poll.options.length + ' options')
                                  : bad('poll create', JSON.stringify(poll.json));

  const vote = await call('POST', `/conversations/${groupId}/messages/${pollMsgId}/poll/vote`, {
    token: bob.token, body: { optionIds: [optionId] },
  });
  vote.json.options?.find((o) => o.id === optionId)?.voteCount === 1
    ? ok('poll vote tallied by trigger')
    : bad('poll vote', JSON.stringify(vote.json));
}

console.log('\n── read state & sync ──────────────────────────────');
{
  const head = (await call("GET", `/conversations/${convId}`, { token: bob.token })).json.conversation.latestSeq;
  const read = await call("POST", `/conversations/${convId}/read`, { token: bob.token, body: { seq: head } });
  read.json.unreadCount === 0 ? ok('read ack clears unread') : bad('read ack', JSON.stringify(read.json));

  const backwards = await call("POST", `/conversations/${convId}/read`, { token: bob.token, body: { seq: 1 } });
  backwards.json.lastReadSeq === head ? ok('read cursor is monotonic (cannot move back)')
                                   : bad('read monotonic', JSON.stringify(backwards.json));

  const badge = await call('GET', '/sync/badge', { token: alice.token });
  badge.status === 200 ? ok('badge query', JSON.stringify(badge.json)) : bad('badge', JSON.stringify(badge.json));

  const sync = await call('POST', '/sync', { token: alice.token, body: { cursors: [], messagesPerConversation: 10 } });
  sync.status === 200 && sync.json.conversations.length >= 2
    ? ok('cold sync returns all conversations', `${sync.json.conversations.length} convs`)
    : bad('sync', JSON.stringify(sync.json).slice(0, 200));

  const warm = await call('POST', '/sync', {
    token: alice.token,
    body: { cursors: sync.json.conversations.map((c) => ({ conversationId: c.id, seq: c.latestSeq })) },
  });
  warm.json.conversations.length === 0
    ? ok('warm sync returns nothing when cursors are current (delta works)')
    : bad('warm sync', `${warm.json.conversations.length} conversations returned`);
}

console.log('\n── search ─────────────────────────────────────────');
{
  const s = await call('GET', '/search/messages?q=back', { token: alice.token });
  s.status === 200 ? ok('full-text search', `${s.json.results.length} hit(s)`) : bad('search', JSON.stringify(s.json));
  const u = await call(`GET`, `/users?q=bob_${stamp}`, { token: alice.token });
  u.json.users?.length === 1 ? ok('user search by username prefix') : bad('user search', JSON.stringify(u.json));
}

console.log('\n── permissions ────────────────────────────────────');
{
  const outsider = await signUp(`+1777${stamp}`, `eve_${stamp}`, 'Eve');
  const peek = await call('GET', `/conversations/${convId}/messages`, { token: outsider.token });
  peek.status === 404 ? ok('non-member gets 404, not 403 (no membership leak)') : bad('membership guard', `${peek.status}`);

  const kick = await call('DELETE', `/conversations/${groupId}/members/${alice.userId}`, { token: bob.token });
  kick.status === 403 ? ok('member cannot kick the owner') : bad('rank guard', `${kick.status} ${JSON.stringify(kick.json)}`);
}

console.log('\n── websocket gateway ──────────────────────────────');
await new Promise((resolve) => {
  const ticketP = call('POST', '/auth/gateway-ticket', { token: bob.token });
  ticketP.then(({ json }) => {
    const ws = new WebSocket(WS_URL);
    const seen = [];
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      try { ws.close(); } catch {}
      if (err) bad('websocket', err);
      resolve();
    };
    const timer = setTimeout(() => finish('timed out waiting for message.create'), 15000);

    ws.on('open', () => ok('gateway connection opened'));
    ws.on('message', async (raw) => {
      const f = JSON.parse(raw.toString());
      seen.push(f.op);

      if (f.op === 0) {
        ok('HELLO received', `heartbeat ${f.d.heartbeatIntervalMs}ms`);
        ws.send(JSON.stringify({ op: 1, d: { token: json.ticket, protocolVersion: 1, client: { platform: 'android', version: '1.0.0' }, cursors: [] } }));
      }
      if (f.op === 2) {
        ok('READY received', `${f.d.conversations.length} conversations`);
        ws.send(JSON.stringify({ op: 10, nonce: 'c1', d: { c: 'typing.start', conversationId: convId } }));
        // Alice sends over REST; it must arrive on Bob's socket.
        await call('POST', `/conversations/${convId}/messages`, {
          token: alice.token, body: { nonce: `n_${stamp}_ws`, type: 'text', content: 'realtime delivery' },
        });
      }
      if (f.op === 11 && f.nonce === 'c1') ok('command ack (typing.start)');
      if (f.op === 5 && f.t === 'message.create') {
        f.d.content === 'realtime delivery'
          ? ok('message.create pushed over LISTEN/NOTIFY', `seq=${f.d.seq}, s=${f.s}`)
          : bad('realtime payload', JSON.stringify(f.d).slice(0, 120));
        clearTimeout(timer);
        finish();
      }
    });
    ws.on('error', (e) => finish(e.message));
    ws.on('close', (code, r) => finish(`socket closed ${code} ${r}`));
  });
});

console.log('\n───────────────────────────────────────────────────');
console.log(failures === 0 ? '✓ all smoke checks passed' : `✗ ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
