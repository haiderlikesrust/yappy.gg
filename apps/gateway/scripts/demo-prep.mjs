/**
 * Stages demo data for the group-first feature walkthrough: makes the seeded
 * group public, adds thread replies under its newest text message, and sends
 * an @-mention at ada. Idempotent enough to re-run.
 */
import { readFileSync } from 'node:fs';

const ANSI = /[[0-9;]*m/g;
const API = 'http://localhost:3000/v1';
const LOG = process.env.WORKER_LOG;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, path, body, token) {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : {} };
}

function latestCode(phone) {
  const log = readFileSync(LOG, 'utf8').replace(ANSI, '');
  const re = new RegExp(`to: "${phone.replace('+', '\\+')}"\\s*\\n\\s*code: "(\\d{6})"`, 'g');
  let last = null, m;
  while ((m = re.exec(log)) !== null) last = m[1];
  return last;
}

async function signIn(phone) {
  await call('POST', '/auth/otp/request', { phone });
  await sleep(5000);
  const verified = await call('POST', '/auth/otp/verify', {
    phone, code: latestCode(phone), client: { platform: 'web', version: '1.0.0' },
  });
  if (verified.status !== 200) throw new Error(`${phone}: ${JSON.stringify(verified.json)}`);
  return verified.json.accessToken;
}

const ada = await signIn('+15550000001');
const grace = await signIn('+15550000002');

const convs = await call('GET', '/conversations', null, ada);
const group = convs.json.conversations.find((c) => c.title === 'Backend crew');

// 1. Public
const pub = await call('PATCH', `/conversations/${group.id}`, { isPublic: true }, ada);
console.log('public:', pub.status, pub.json.conversation?.isPublic);

// 2. Thread replies under the newest plain text message
const history = await call('GET', `/conversations/${group.id}/messages?limit=50`, null, ada);
const root = [...history.json.messages].reverse().find((m) => m.type === 'text' && !m.system && m.content);
console.log('thread root:', JSON.stringify(root.content).slice(0, 50));
for (const [i, text] of ['agreed, shipping tonight', 'i will watch the deploy'].entries()) {
  const sent = await call('POST', `/conversations/${group.id}/messages`, {
    nonce: `demo_thread_${root.id}_${i}`, type: 'text', content: text, threadRootId: root.id,
  }, grace);
  console.log(`reply ${i + 1}:`, sent.status);
}

// 3. Mention at ada
const content = '@ada can you sanity-check the deploy checklist?';
const mention = await call('POST', `/conversations/${group.id}/messages`, {
  nonce: `demo_mention_${Date.now()}`,
  type: 'text',
  content,
  entities: [{ type: 'mention', offset: 0, length: 4, userId: '00000000-0000-7000-8000-000000000001' }],
}, grace);
console.log('mention:', mention.status);
