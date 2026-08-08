/**
 * Stages the embeds + bot demo: creates a bot, adds it to "Backend crew",
 * posts a rich embed as the bot, and posts a link as a human so the worker
 * unfurls it. Re-runnable — reuses the bot if the username is taken.
 */
import { readFileSync } from 'node:fs';

const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
const API = 'http://localhost:3000/v1';
const LOG = process.env.WORKER_LOG;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  // `pnpm dev` prefixes every line with the package name, so the two fields are
  // not adjacent — match across whatever sits between them.
  const re = new RegExp(`to: "${phone.replace('+', '\\+')}"[\\s\\S]{0,120}?code: "(\\d{6})"`, 'g');
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
  return `Bearer ${verified.json.accessToken}`;
}

const ada = await signIn('+15550000001');

const convs = await call('GET', '/conversations', null, ada);
const group = convs.json.conversations.find((c) => c.title === 'Backend crew');
console.log('group:', group.id);

// 1. Create the bot (or reuse an existing one).
let botToken = null;
let botUserId = null;
const created = await call('POST', '/apps', {
  name: 'Deploy Bot',
  username: 'deploybot',
  description: 'Ships things and tells you about it',
}, ada);

if (created.status === 201) {
  botToken = created.json.token;
  botUserId = created.json.application.bot.id;
  console.log('bot created:', created.json.application.tokenPrefix + '…');
} else {
  console.log('create returned', created.status, JSON.stringify(created.json).slice(0, 120));
  const mine = await call('GET', '/apps', null, ada);
  const existing = mine.json.applications?.[0];
  if (!existing) throw new Error('no bot available');
  botUserId = existing.bot.id;
  const rotated = await call('POST', `/apps/${existing.id}/token`, null, ada);
  botToken = rotated.json.token;
  console.log('bot reused, token rotated');
}

// 2. Bot identifies itself.
const me = await call('GET', '/apps/me', null, `Bot ${botToken}`);
console.log('bot /me:', me.status, me.json.user?.username, 'isBot=', me.json.user?.isBot);

// 3. Add the bot to the group.
const added = await call('POST', `/conversations/${group.id}/members`, { userIds: [botUserId] }, ada);
console.log('add bot to group:', added.status);

// 4. Bot posts a rich embed.
const embedMsg = await call('POST', `/conversations/${group.id}/messages`, {
  nonce: `bot_embed_${Date.now()}`,
  type: 'text',
  content: 'Deploy finished',
  embeds: [{
    title: 'yappy-api v1.4.2 deployed',
    description: 'All checks green. 33/33 smoke tests passed in 41s.',
    url: 'https://github.com/livekit/livekit',
    color: '#17B978',
    author: { name: 'Deploy Bot' },
    fields: [
      { name: 'Environment', value: 'production', inline: true },
      { name: 'Duration', value: '2m 14s', inline: true },
      { name: 'Commit', value: 'feat: group flair + embeds', inline: false },
    ],
    footer: { text: 'yappy CI · eu-west-1' },
  }],
}, `Bot ${botToken}`);
console.log('bot embed:', embedMsg.status, embedMsg.json.message?.embeds?.length, 'embed(s)');

// 5. A human posts a rich embed — must be rejected.
const humanEmbed = await call('POST', `/conversations/${group.id}/messages`, {
  nonce: `human_embed_${Date.now()}`, type: 'text', content: 'sneaky',
  embeds: [{ title: 'Yappy Security', description: 'Verify your account' }],
}, ada);
console.log('human rich embed rejected:', humanEmbed.status, humanEmbed.json.error?.code);

// 6. A human posts a link — the worker should unfurl it.
const linkMsg = await call('POST', `/conversations/${group.id}/messages`, {
  nonce: `link_${Date.now()}`,
  type: 'text',
  content: 'the SFU we use: https://github.com/livekit/livekit',
}, ada);
console.log('link message:', linkMsg.status, 'seq', linkMsg.json.message?.seq);

await sleep(6000);
const history = await call('GET', `/conversations/${group.id}/messages?limit=5`, null, ada);
for (const m of history.json.messages ?? []) {
  if (m.embeds?.length) {
    console.log(`  embeds on seq ${m.seq}:`, m.embeds.map((e) => `${e.type}:${e.title}`).join(', '));
  }
}
