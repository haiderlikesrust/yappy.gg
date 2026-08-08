/**
 * Developer-portal sign-in, end to end.
 *
 * The interesting assertions are the refusals. A device grant is a session
 * handed to a machine nobody has authenticated, so what matters is that it
 * cannot be obtained by guessing, by racing, by skipping the confirmation, or
 * by a second person claiming someone else's code.
 *
 *   WORKER_LOG=… node scripts/portal.mjs
 */
import { readFileSync } from 'node:fs';

const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
const API = 'http://localhost:3000/v1';
const LOG = process.env.WORKER_LOG;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const ok = (l, x = '') => console.log(`  ok   ${l}${x ? ' — ' + x : ''}`);
const bad = (l, d) => { failures++; console.log(`  FAIL ${l} — ${d}`); };
const expect = (l, a, w) => (a === w ? ok(l, String(a)) : bad(l, `expected ${w}, got ${a}`));

async function call(method, path, body, auth) {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : {} };
}

function latestCode(phone) {
  const log = readFileSync(LOG, 'utf8').replace(ANSI, '');
  const re = new RegExp(`to: "${phone.replace('+', '\\+')}"[\\s\\S]{0,160}?code: "(\\d{6})"`, 'g');
  let last = null, m;
  while ((m = re.exec(log)) !== null) last = m[1];
  return last;
}

async function signUp(phone, username, displayName) {
  await call('POST', '/auth/otp/request', { phone });
  let code = null;
  for (let i = 0; i < 25 && !code; i++) { await sleep(300); code = latestCode(phone); }
  if (!code) throw new Error(`no OTP for ${phone}`);
  const v = await call('POST', '/auth/otp/verify', { phone, code, client: { platform: 'web', version: '1.0.0' } });
  if (v.status !== 200) throw new Error(JSON.stringify(v.json));
  const auth = `Bearer ${v.json.accessToken}`;
  if (v.json.needsOnboarding) await call('POST', '/auth/complete-profile', { username, displayName }, auth);
  const me = await call('GET', '/users/me', null, auth);
  return { auth, id: me.json.user.id, username };
}

/**
 * Open (or reuse) the DM with yapper, send it a line, and wait for the reply
 * *to that line*.
 *
 * The seq bookkeeping is not incidental: the bot answers asynchronously, so
 * simply reading the newest message from it returns the answer to the previous
 * command and every assertion afterwards checks the wrong string.
 */
async function tellYapper(actor, text, yapperId) {
  const dm = await call('POST', '/conversations', { type: 'dm', memberIds: [yapperId] }, actor.auth);
  const conversationId = dm.json.conversation.id;

  const sent = await call('POST', `/conversations/${conversationId}/messages`, {
    nonce: `t_${Math.random().toString(36).slice(2)}`, type: 'text', content: text,
  }, actor.auth);
  const afterSeq = sent.json.message?.seq ?? 0;

  for (let i = 0; i < 24; i++) {
    await sleep(250);
    const hist = await call('GET', `/conversations/${conversationId}/messages?limit=10`, null, actor.auth);
    const reply = (hist.json.messages ?? [])
      .filter((m) => m.senderId === yapperId && m.seq > afterSeq)
      .sort((a, b) => a.seq - b.seq)[0];
    if (reply) return reply.content ?? '';
  }
  return null;
}

const stamp = String(Date.now()).slice(-7);

console.log('\n── setup ──────────────────────────────────────────');
const dev = await signUp(`+1581${stamp}`, `dev_${stamp}`, 'Developer');
const other = await signUp(`+1582${stamp}`, `other_${stamp}`, 'Someone Else');

const found = await call('GET', '/users?q=yapper', null, dev.auth);
const yapper = found.json.users?.find((u) => u.username === 'yapper');
if (!yapper) { console.log('  FAIL yapper bot does not exist — run packages/db/scripts/create-yapper.mjs'); process.exit(1); }
ok('yapper exists', yapper.id);
expect('and is marked staff', yapper.badge, 'staff');

console.log('\n── the browser asks ───────────────────────────────');
const start = await call('POST', '/portal/auth/start');
expect('grant issued', start.status, 201);
const { userCode, pollToken } = start.json;
ok('code', userCode);
expect('code is two groups of four', /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(userCode), true);

const early = await call('POST', '/portal/auth/poll', { pollToken });
expect('polling before anything happens is pending', early.json.status, 'pending');

console.log('\n── guessing does not work ─────────────────────────');
const wrong = await tellYapper(dev, '/login dev AAAA-BBBB', yapper.id);
expect('a wrong code is refused', /not valid|expired/i.test(wrong ?? ''), true);

console.log('\n── claiming ───────────────────────────────────────');
const claimed = await tellYapper(dev, `/login dev ${userCode}`, yapper.id);
expect('the bot describes the client', /Client:/.test(claimed ?? ''), true);
expect('and names the address', /Address:/.test(claimed ?? ''), true);
ok('bot said', (claimed ?? '').split('\n')[0]);

const midway = await call('POST', '/portal/auth/poll', { pollToken });
expect('claiming alone does not grant a session', midway.json.status, 'awaiting_confirm');
expect('and hands over no token', midway.json.token, undefined);

console.log('\n── someone else cannot take it ────────────────────');
const stolen = await tellYapper(other, `/login dev ${userCode}`, yapper.id);
expect('a second person is refused', /already signing in/i.test(stolen ?? ''), true);

console.log('\n── confirming ─────────────────────────────────────');
const approved = await tellYapper(dev, '/login yes', yapper.id);
expect('the bot confirms', /Approved/i.test(approved ?? ''), true);

const granted = await call('POST', '/portal/auth/poll', { pollToken });
expect('the browser gets a session', granted.json.status, 'approved');
const portalToken = granted.json.token;
expect('with a token', typeof portalToken, 'string');

console.log('\n── what the session can and cannot do ─────────────');
const who = await call('GET', '/portal/me', null, `Bearer ${portalToken}`);
expect('it identifies the developer', who.json.user?.username, dev.username);

// The whole reason for a separate token type.
const misuse = await call('GET', '/users/me', null, `Bearer ${portalToken}`);
expect('a portal token cannot call the app API', misuse.status, 401);

const reverse = await call('GET', '/portal/me', null, dev.auth);
expect('an app token cannot call the portal API', reverse.status, 401);

console.log('\n── single use ─────────────────────────────────────');
const replay = await call('POST', '/portal/auth/poll', { pollToken });
expect('the grant cannot be redeemed twice', replay.json.status, 'consumed');

console.log('\n── rejecting ──────────────────────────────────────');
const second = await call('POST', '/portal/auth/start');
await tellYapper(dev, `/login dev ${second.json.userCode}`, yapper.id);
const denied = await tellYapper(dev, '/login no', yapper.id);
expect('the bot confirms the rejection', /Denied/i.test(denied ?? ''), true);
const deniedPoll = await call('POST', '/portal/auth/poll', { pollToken: second.json.pollToken });
expect('and the browser is told', deniedPoll.json.status, 'denied');

console.log('\n── yapper is not a group member ───────────────────');
// It answers commands in a DM and nowhere else, so being addable to a group
// would only ever produce confusion or a place to try commands in front of an
// audience. Enforced by its own privacy setting, not a special case.
const group = await call('POST', '/conversations', {
  type: 'group', title: `With a bot ${stamp}`, memberIds: [],
}, dev.auth);
const groupId = group.json.conversation.id;
const addBot = await call('POST', `/conversations/${groupId}/members`, {
  userIds: [yapper.id],
}, dev.auth);
// Adding members is a partial-success endpoint: one refusal reports itself in
// `skipped` rather than failing the whole request, so the assertion is about
// the outcome for yapper rather than the status code.
expect('the request itself succeeds', addBot.status, 200);
expect(
  'but yapper is skipped',
  addBot.json.skipped?.some((s) => s.userId === yapper.id),
  true,
);
const after = await call('GET', `/conversations/${groupId}`, null, dev.auth);
expect('and it is not in the group', after.json.conversation?.memberCount, 1);

console.log('\n── the bot is only a bot in its own DM ────────────');
const help = await tellYapper(dev, '/help', yapper.id);
expect('it answers /help', /developer-portal sign-ins/i.test(help ?? ''), true);

console.log('\n───────────────────────────────────────────────────');
console.log(failures === 0 ? '✓ portal sign-in holds' : `✗ ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
