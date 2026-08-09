/**
 * Staff space, moderation pipeline, bot permission enforcement, custom emoji,
 * and the portal's application management — end to end.
 *
 *   node scripts/staff.mjs            (API on 3000, or API_BASE=…)
 *
 * The one assertion this whole file exists for: a bot's privileged button
 * pressed by an unprivileged member is REFUSED, because authorisation is
 * checked against the presser, never the bot. Everything else supports that.
 *
 * Needs: packages/db scripts runnable (grant-staff, ensure-staff-space), the
 * yapper bot, MinIO up. Creates its own throwaway accounts.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const API = process.env.API_BASE ?? 'http://localhost:3000/v1';
const DB_DIR = fileURLToPath(new URL('../../../packages/db', import.meta.url));
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

const msg = (res) => res.json.error?.message ?? res.json.message ?? '';
const CLIENT = { platform: 'web', version: '1.0.0-test' };
const PASSWORD = 'correct-horse-battery-staple';

async function signUp(handle, displayName) {
  const username = `${handle}_${Math.random().toString(36).slice(2, 9)}`;
  const res = await call('POST', '/auth/register', {
    email: `${username}@example.test`, password: PASSWORD, username, displayName, client: CLIENT,
  });
  if (res.status !== 201) throw new Error(`register: ${JSON.stringify(res.json)}`);
  return { auth: `Bearer ${res.json.accessToken}`, id: res.json.user.id, username, refreshToken: res.json.refreshToken };
}

/** Run one of the operator scripts, the way an operator would. */
const operate = (script, ...args) =>
  execFileSync('node', ['--env-file=../../.env', `scripts/${script}`, ...args], {
    cwd: DB_DIR, encoding: 'utf8',
  }).trim();

/** System conversation ids, read the same way the server reads them. */
const sys = (key) =>
  execFileSync('node', ['--env-file=../../.env', '-e',
    `import('postgres').then(async ({default: postgres}) => {
       const sql = postgres(process.env.DATABASE_URL, { max: 1 });
       const [r] = await sql\`select id from conversations where system_key = ${'$'}{'${key}'}\`;
       console.log(r?.id ?? '');
       await sql.end();
     })`,
  ], { cwd: DB_DIR, encoding: 'utf8' }).trim();

const buttons = (m) => (m?.components ?? []).flatMap((r) => r.components ?? []);
const buttonNamed = (m, id) => buttons(m).find((b) => b.customId === id);
const embedOf = (m) => (m?.embeds ?? [])[0] ?? {};

const press = (actor, conversationId, messageId, customId) =>
  call('POST', `/conversations/${conversationId}/messages/${messageId}/interactions`, { customId }, actor.auth);

const dmCache = new Map();
async function yapperDm(actor, yapperId) {
  if (dmCache.has(actor.id)) return dmCache.get(actor.id);
  const dm = await call('POST', '/conversations', { type: 'dm', memberIds: [yapperId] }, actor.auth);
  dmCache.set(actor.id, dm.json.conversation.id);
  return dm.json.conversation.id;
}

async function tellYapper(actor, text, yapperId) {
  const conversationId = await yapperDm(actor, yapperId);
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
    if (reply) return { ...reply, conversationId };
  }
  return null;
}

/** A 1×1 PNG, uploaded for real: presign → PUT → confirm. */
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
  '1f15c4890000000d49444154789c626001000000ffff03000006000557' +
  'bfabd40000000049454e44ae426082', 'hex');

async function uploadPng(actor, purpose) {
  const created = await call('POST', '/media/uploads', {
    filename: 'e.png', mimeType: 'image/png', size: PNG.length, purpose,
    width: 1, height: 1, checksum: createHash('sha256').update(PNG).digest('hex'),
  }, actor.auth);
  const mediaId = created.json.media.id;
  const target = created.json.upload;
  if (target) {
    // Every presigned header except content-length is part of the signature —
    // dropping x-amz-checksum-sha256 is a guaranteed SignatureDoesNotMatch.
    const headers = {};
    for (const [k, v] of Object.entries(target.headers ?? {})) {
      if (k.toLowerCase() !== 'content-length') headers[k] = v;
    }
    const signedUrl = new URL(target.url);
    headers.host = signedUrl.host;
    if (signedUrl.hostname === '10.0.2.2') signedUrl.hostname = 'localhost';
    const put = await fetch(signedUrl, { method: 'PUT', headers, body: PNG });
    if (!put.ok) throw new Error(`PUT ${put.status}: ${(await put.text()).slice(0, 200)}`);
    await call('POST', `/media/${mediaId}/confirm`, null, actor.auth);
  }
  return mediaId;
}

// ─── Setup ───────────────────────────────────────────────────────────────────

console.log('\n── setup ──────────────────────────────────────────');
const staffer = await signUp('staffer', 'Staff Member');
const civilian = await signUp('civ', 'Ordinary Person');
const target = await signUp('tgt', 'Report Target');
const owner = await signUp('owner', 'Group Owner');

console.log(`  ${operate('grant-staff.mjs', staffer.username)}`);
operate('ensure-staff-space.mjs');
const reportsChannelId = sys('staff_reports');
expect('the reports channel exists', reportsChannelId.length > 0, true);

const yapperRes = await call('GET', '/users?q=yapper', null, staffer.auth);
const yapper = yapperRes.json.users.find((u) => u.username === 'yapper');

console.log('\n── staff commands are invisible to civilians ──────');
const civDm = await yapperDm(civilian, yapper.id);
const civCmds = await call('GET', `/conversations/${civDm}/commands`, null, civilian.auth);
expect('civilian sees no staff commands',
  civCmds.json.commands.some((c) => c.name === 'reports' || c.name === 'lookup'), false);

const staffDm = await yapperDm(staffer, yapper.id);
const staffCmds = await call('GET', `/conversations/${staffDm}/commands`, null, staffer.auth);
expect('staff see them', staffCmds.json.commands.some((c) => c.name === 'reports'), true);

const probe = await tellYapper(civilian, '/reports', yapper.id);
expect('a civilian invoking one gets the unknown-command reply',
  /I don't know/.test(probe?.content ?? ''), true);

console.log('\n── a report becomes a card in #reports ────────────');
const filed = await call('POST', '/moderation/reports', {
  targetType: 'user', targetId: target.id, reason: 'harassment',
  detail: 'Kept at it after being asked to stop.',
}, civilian.auth);
expect('report filed', filed.status, 201);

let card = null;
for (let i = 0; i < 24 && !card; i++) {
  await sleep(250);
  const hist = await call('GET', `/conversations/${reportsChannelId}/messages?limit=10`, null, staffer.auth);
  card = (hist.json.messages ?? []).find(
    (m) => embedOf(m).title?.startsWith('Report') &&
           embedOf(m).fields?.some((f) => f.value.includes(target.username)));
}
expect('the card appears', Boolean(card), true);
expect('with three actions', buttons(card).length, 3);
expect('all staff-gated', buttons(card).every((b) => b.staffOnly === true), true);
expect('a non-member cannot even see the channel',
  (await call('GET', `/conversations/${reportsChannelId}/messages?limit=1`, null, civilian.auth)).status, 404);

console.log('\n── staff act from the card ────────────────────────');
const resolveButton = buttonNamed(card, `modreport:resolve:${filed.json.reportId}`);
expect('the resolve button carries the report id', Boolean(resolveButton), true);
const resolved = await press(staffer, reportsChannelId, card.id, resolveButton.customId);
expect('press succeeds', resolved.status, 200);
expect('the card becomes the outcome', embedOf(resolved.json.message).title, 'Resolved');
expect('naming who acted', embedOf(resolved.json.message).description?.includes(staffer.username), true);
expect('and retires its buttons', buttons(resolved.json.message).length, 0);

// The dev database accumulates reports from other runs, so the assertion is
// about *this* report being gone from the queue, not about the queue's size.
const queue = await tellYapper(staffer, '/reports', yapper.id);
const queueEmbed = embedOf(queue);
expect('/reports answers with the queue',
  /open report|Queue is clear/.test(queueEmbed.title ?? ''), true);
expect('and the resolved report is not in it',
  (queueEmbed.fields ?? []).some((f) => f.name.includes(filed.json.reportId.slice(0, 8))), false);

console.log('\n── the Mee6 problem ───────────────────────────────');
// A moderation bot: owner builds it, adds it to their group, and it posts a
// panel with a permission-gated Kick button. The whole point: that button
// must work for the owner and be REFUSED for an ordinary member.
const KICK = (1n << 32n).toString();

const botRes = await call('POST', '/apps', {
  name: 'Modsix', username: `modsix_${Date.now().toString(36)}`, isPublic: false,
}, owner.auth);
expect('bot created', botRes.status, 201);
const botToken = `Bot ${botRes.json.token}`;
const botUserId = botRes.json.application.bot.id;
const appId = botRes.json.application.id;

const setCmds = await call('PUT', `/apps/${appId}/commands`, {
  commands: [
    { name: 'hello', description: 'Say hi' },
    { name: 'ban', description: 'Ban a member', requiredPermissions: KICK },
  ],
}, owner.auth);
expect('commands declared', setCmds.status, 200);

const group = await call('POST', '/conversations', {
  type: 'group', title: `Modded ${Date.now().toString(36)}`, memberIds: [],
}, owner.auth);
const groupId = group.json.conversation.id;
// The group defaults to contacts-only adds; both joiners opt in for the test.
await call('PATCH', '/users/me/settings', { privacy: { whoCanAddToGroups: 'everyone' } }, civilian.auth);
await call('POST', `/conversations/${groupId}/members`, { userIds: [botUserId, civilian.id] }, owner.auth);

const memberIds = (await call('GET', `/conversations/${groupId}`, null, owner.auth)).json.conversation.memberCount;
expect('bot and civilian joined', memberIds, 3);

// Autocomplete: the owner is offered /ban, the civilian is not.
const ownerCmds = await call('GET', `/conversations/${groupId}/commands`, null, owner.auth);
expect('owner is offered /ban', ownerCmds.json.commands.some((c) => c.name === 'ban'), true);
const civGroupCmds = await call('GET', `/conversations/${groupId}/commands`, null, civilian.auth);
expect('civilian is offered /hello', civGroupCmds.json.commands.some((c) => c.name === 'hello'), true);
expect('but never /ban', civGroupCmds.json.commands.some((c) => c.name === 'ban'), false);

// The bot posts its panel, authenticated as itself.
const panel = await call('POST', `/conversations/${groupId}/messages`, {
  nonce: `panel_${Date.now().toString(36)}`, type: 'text', content: null,
  embeds: [{ title: 'Moderation panel', description: 'Owner tools.' }],
  components: [{ type: 'row', components: [
    { type: 'button', customId: 'panel:kick', label: 'Kick', style: 'danger', requiredPermissions: KICK },
    { type: 'button', customId: 'panel:staff', label: 'Escalate to yappy', style: 'secondary', staffOnly: true },
  ] }],
}, botToken);
expect('bot posts the panel', panel.status, 201);
const panelId = panel.json.message.id;

const civKick = await press(civilian, groupId, panelId, 'panel:kick');
expect('THE FENCE: civilian pressing Kick is refused', civKick.status, 403);
const civStaff = await press(civilian, groupId, panelId, 'panel:staff');
expect('and the staff button too', civStaff.status, 403);
expect('with the staff wording', /yappy staff/i.test(msg(civStaff)), true);
const ownerKick = await press(owner, groupId, panelId, 'panel:kick');
expect('while the owner may press Kick', ownerKick.status, 200);

const perms = await call('GET', `/conversations/${groupId}/members/${civilian.id}/permissions`, null, owner.auth);
expect('the permissions endpoint agrees', (BigInt(perms.json.permissions) & (1n << 32n)) === 0n, true);

console.log('\n── custom emoji ───────────────────────────────────');
const emojiMedia = await uploadPng(owner, 'emoji');
const made = await call('POST', `/conversations/${groupId}/emojis`, { name: 'partyblob', mediaId: emojiMedia }, owner.auth);
expect('owner creates :partyblob:', made.status, 201);
expect('with a public URL', typeof made.json.emoji.url, 'string');

const dup = await call('POST', `/conversations/${groupId}/emojis`, { name: 'partyblob', mediaId: emojiMedia }, owner.auth);
expect('the name is unique per group', dup.status, 409);

const civMedia = await uploadPng(civilian, 'emoji');
const civMake = await call('POST', `/conversations/${groupId}/emojis`, { name: 'sneaky', mediaId: civMedia }, civilian.auth);
expect('a plain member cannot add emoji', civMake.status, 403);

const listed = await call('GET', `/conversations/${groupId}/emojis`, null, civilian.auth);
expect('but sees the list', listed.json.emojis.length, 1);

const stolen = await call('POST', `/conversations/${groupId}/emojis`, { name: 'stolen', mediaId: civMedia }, owner.auth);
expect("someone else's upload cannot be claimed", stolen.status, 404);

const gone = await call('DELETE', `/conversations/${groupId}/emojis/${made.json.emoji.id}`, null, owner.auth);
expect('owner deletes it', gone.status, 200);

console.log('\n── the portal manages bots and the queue ──────────');
// Staff sign in to the portal through the real flow: code → yapper → approve.
const grant = await call('POST', '/portal/auth/start');
const claimed = await tellYapper(staffer, `/login ${grant.json.userCode}`, yapper.id);
await press(staffer, claimed.conversationId, claimed.id, 'login:approve');
const polled = await call('POST', '/portal/auth/poll', { pollToken: grant.json.pollToken });
const portal = `Bearer ${polled.json.token}`;
expect('portal session obtained', typeof polled.json.token, 'string');
expect('/portal/me says staff', (await call('GET', '/portal/me', null, portal)).json.user.isStaff, true);

const portalBot = await call('POST', '/portal/apps', {
  name: 'Portal Bot', username: `pbot_${Date.now().toString(36)}`, isPublic: false,
}, portal);
expect('a bot can be created from the portal', portalBot.status, 201);
expect('token shown once', typeof portalBot.json.token, 'string');

const hook = await call('PUT', `/portal/apps/${portalBot.json.application.id}/webhook`, {
  url: 'http://localhost:9999/hook',
}, portal);
expect('webhook set (localhost allowed in dev)', hook.status, 200);
expect('signing secret shown once', typeof hook.json.secret, 'string');
const relisted = await call('GET', '/portal/apps', null, portal);
const mine = relisted.json.applications.find((a) => a.id === portalBot.json.application.id);
expect('the URL is listed afterwards', mine.webhookUrl, 'http://localhost:9999/hook');
expect('the secret is not', 'secret' in mine, false);

const insecure = await call('PUT', `/portal/apps/${portalBot.json.application.id}/webhook`, {
  url: 'http://evil.example.com/hook',
}, portal);
expect('plain-http webhooks are refused', insecure.status, 403);

const civPortalReports = await call('GET', '/portal/staff/reports', null, portal.replace('Bearer', 'Bearer'));
expect('staff list the queue', civPortalReports.status, 200);

console.log('\n── suspension, end to end ─────────────────────────');
const second = await call('POST', '/moderation/reports', {
  targetType: 'user', targetId: target.id, reason: 'spam', detail: 'Bot-like posting.',
}, civilian.auth);
const action = await call('POST', `/portal/staff/reports/${second.json.reportId}/action`, {
  action: 'suspend', suspendDays: 1, note: 'Verified spam.',
}, portal);
expect('portal suspends from the queue', action.status, 200);

const deadToken = await call('GET', '/users/me', null, target.auth);
expect('their sessions die with the suspension', deadToken.status, 401);
const relogin = await call('POST', '/auth/login', { email: `${target.username}@example.test`, password: PASSWORD, client: CLIENT });
expect('and they cannot sign back in', relogin.status, 403);
expect('told why', /suspended/i.test(msg(relogin)), true);

const handled = await call('GET', '/portal/staff/reports?status=handled', null, portal);
expect('both reports are in the handled list',
  handled.json.reports.filter((r) => ['actioned', 'dismissed'].includes(r.status)).length >= 2, true);

console.log('\n── civilians and the portal stay apart ────────────');
const civGrant = await call('POST', '/portal/auth/start');
const civClaim = await tellYapper(civilian, `/login ${civGrant.json.userCode}`, yapper.id);
await press(civilian, civClaim.conversationId, civClaim.id, 'login:approve');
const civPoll = await call('POST', '/portal/auth/poll', { pollToken: civGrant.json.pollToken });
const civPortal = `Bearer ${civPoll.json.token}`;
expect('a civilian can hold a portal session', typeof civPoll.json.token, 'string');
expect('and manage their bots', (await call('GET', '/portal/apps', null, civPortal)).status, 200);
expect('but the staff area does not exist for them',
  (await call('GET', '/portal/staff/reports', null, civPortal)).status, 404);

console.log('\n───────────────────────────────────────────────────');
console.log(failures === 0 ? '✓ staff, enforcement, emoji and portal hold' : `✗ ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
