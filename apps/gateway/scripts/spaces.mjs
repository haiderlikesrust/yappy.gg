/**
 * Named roles, and turning a group into a space.
 *
 * The upgrade is the part worth testing hard: it rewrites the conversation a
 * group's entire history hangs off, in one transaction, while people are
 * members of it. The checks below are mostly about what must survive —
 * messages, their order, read cursors, roles, invites, membership — because a
 * migration that loses any of those is worse than not having the feature.
 *
 *   WORKER_LOG=… node scripts/spaces.mjs
 */
import { readFileSync } from 'node:fs';

const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
const API = 'http://localhost:3000/v1';
const LOG = process.env.WORKER_LOG;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const ok = (label, extra = '') => console.log(`  ok   ${label}${extra ? ' — ' + extra : ''}`);
const bad = (label, detail) => { failures++; console.log(`  FAIL ${label} — ${detail}`); };
const expect = (label, actual, wanted) =>
  actual === wanted ? ok(label, String(actual)) : bad(label, `expected ${wanted}, got ${actual}`);

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
  for (let i = 0; i < 25 && !code; i++) { await sleep(400); code = latestCode(phone); }
  if (!code) throw new Error(`no OTP for ${phone}`);

  const verified = await call('POST', '/auth/otp/verify', {
    phone, code, client: { platform: 'web', version: '1.0.0' },
  });
  if (verified.status !== 200) throw new Error(`${phone}: ${JSON.stringify(verified.json)}`);
  const auth = `Bearer ${verified.json.accessToken}`;
  if (verified.json.needsOnboarding) {
    await call('POST', '/auth/complete-profile', { username, displayName }, auth);
  }
  const me = await call('GET', '/users/me', null, auth);
  return { auth, id: me.json.user.id, username };
}

const P = {
  VIEW: 1n << 0n,
  SEND: 1n << 2n,
  PIN: 1n << 14n,
  KICK: 1n << 32n,
  BAN: 1n << 33n,
  MANAGE_ROLES: 1n << 35n,
  ADMINISTRATOR: 1n << 62n,
};

const stamp = String(Date.now()).slice(-7);

console.log('\n── accounts ───────────────────────────────────────');
const owner = await signUp(`+1571${stamp}`, `own_${stamp}`, 'Owner');
const mod = await signUp(`+1572${stamp}`, `mod_${stamp}`, 'Mod');
const plain = await signUp(`+1573${stamp}`, `plain_${stamp}`, 'Plain');
ok('three accounts');

for (const u of [mod, plain]) {
  await call('PATCH', '/users/me/settings', { privacy: { whoCanAddToGroups: 'everyone' } }, u.auth);
}

const created = await call('POST', '/conversations', {
  type: 'group', title: `Crew ${stamp}`, memberIds: [mod.id, plain.id],
}, owner.auth);
const group = created.json.conversation.id;
expect('group created with 3 members', created.json.conversation.memberCount, 3);

console.log('\n── named roles ────────────────────────────────────');
const roleRes = await call('POST', `/conversations/${group}/roles`, {
  name: 'Release captain',
  color: '#22C55E',
  permissions: (P.PIN | P.KICK).toString(),
  position: 10,
  isHoisted: true,
}, owner.auth);
expect('owner creates a role', roleRes.status, 201);
const captain = roleRes.json.role?.id;

const dupe = await call('POST', `/conversations/${group}/roles`, { name: 'release CAPTAIN' }, owner.auth);
expect('duplicate name rejected case-insensitively', dupe.status, 409);

const byPlain = await call('POST', `/conversations/${group}/roles`, { name: 'Nope' }, plain.auth);
expect('a plain member cannot create roles', byPlain.status, 403);

// Escalation: an admin without ADMINISTRATOR must not be able to mint it.
await call('PATCH', `/conversations/${group}/members/${mod.id}`, { role: 'admin' }, owner.auth);
const escalate = await call('POST', `/conversations/${group}/roles`, {
  name: 'Sneaky', permissions: P.ADMINISTRATOR.toString(),
}, mod.auth);
expect('admin cannot mint ADMINISTRATOR', escalate.status, 403);

const overreach = await call('POST', `/conversations/${group}/roles`, {
  name: 'Banhammer', permissions: P.BAN.toString(),
}, mod.auth);
// An admin *does* hold BAN_MEMBERS, so this one is legitimate.
expect('admin can grant what they hold', overreach.status, 201);

console.log('\n── assignment ─────────────────────────────────────');
const beforePin = await call('POST', `/conversations/${group}/messages`, {
  nonce: `pinme_${stamp}`, type: 'text', content: 'pin this',
}, owner.auth);
const pinTarget = beforePin.json.message.id;

const cannotPin = await call('PUT', `/conversations/${group}/pins/${pinTarget}`, null, plain.auth);
expect('plain member cannot pin', cannotPin.status, 403);

const assigned = await call('PUT', `/conversations/${group}/members/${plain.id}/roles`, {
  roleIds: [captain],
}, owner.auth);
expect('role assigned', assigned.status, 200);

const canPinNow = await call('PUT', `/conversations/${group}/pins/${pinTarget}`, null, plain.auth);
expect('the role grants pinning', canPinNow.status, 200);

// The point of the design: a capability is not authority over people.
const cannotKickAdmin = await call('DELETE', `/conversations/${group}/members/${mod.id}`, null, plain.auth);
expect('KICK from a role still cannot kick an admin', cannotKickAdmin.status, 403);

const members = await call('GET', `/conversations/${group}/members`, null, owner.auth);
const plainRow = members.json.members.find((m) => m.user.id === plain.id);
expect('role shows on the member', plainRow?.roles?.[0]?.name, 'Release captain');
expect('and colours their name', plainRow?.roleColor, '#22C55E');

const hist = await call('GET', `/conversations/${group}/messages?limit=20`, null, owner.auth);
const anyFromPlain = hist.json.messages.find((m) => m.senderId === plain.id);
if (anyFromPlain) expect('sender colour in history', anyFromPlain.senderRoleColor, '#22C55E');
else ok('no message from the role holder yet — colour checked on the member list');

const cleared = await call('PUT', `/conversations/${group}/members/${plain.id}/roles`, { roleIds: [] }, owner.auth);
expect('roles cleared', cleared.status, 200);
const afterClear = await call('PUT', `/conversations/${group}/pins/${pinTarget}`, null, plain.auth);
expect('capability withdrawn with the role', afterClear.status, 403);
await call('PUT', `/conversations/${group}/members/${plain.id}/roles`, { roleIds: [captain] }, owner.auth);

console.log('\n── before the upgrade ─────────────────────────────');
for (let i = 0; i < 3; i++) {
  await call('POST', `/conversations/${group}/messages`, {
    nonce: `pre_${stamp}_${i}`, type: 'text', content: `message ${i}`,
  }, mod.auth);
}
const invite = await call('POST', `/conversations/${group}/invites`, { maxUses: 0 }, owner.auth);
const inviteCode = invite.json.invite?.code;

const preHistory = await call('GET', `/conversations/${group}/messages?limit=50`, null, owner.auth);
const preCount = preHistory.json.messages.length;
const preSeqs = preHistory.json.messages.map((m) => m.seq).join(',');
ok('history before', `${preCount} messages, seqs [${preSeqs}]`);

await call('POST', `/conversations/${group}/read`, { seq: 2 }, plain.auth);
const preList = await call('GET', '/conversations', null, plain.auth);
const preSelf = preList.json.conversations.find((c) => c.id === group)?.self;
ok('read cursor before', `lastReadSeq=${preSelf?.lastReadSeq}`);

console.log('\n── upgrade to a space ─────────────────────────────');
const byNonOwner = await call('POST', `/conversations/${group}/upgrade-to-space`, {}, mod.auth);
expect('only the owner may upgrade', byNonOwner.status, 403);

const upgraded = await call('POST', `/conversations/${group}/upgrade-to-space`, {
  firstChannelTitle: 'general',
}, owner.auth);
expect('upgraded', upgraded.status, 200);
expect('the group is now a space', upgraded.json.space?.type, 'space');
expect('same id — links still resolve', upgraded.json.space?.id, group);
const channel = upgraded.json.channel?.id;
expect('channel created', upgraded.json.channel?.type, 'channel');
expect('channel points at the space', upgraded.json.channel?.parentId, group);

const again = await call('POST', `/conversations/${group}/upgrade-to-space`, {}, owner.auth);
expect('upgrading twice is refused', again.status, 409);

console.log('\n── what survived ──────────────────────────────────');
const postHistory = await call('GET', `/conversations/${channel}/messages?limit=50`, null, owner.auth);
// The system message announcing the move is expected on top of the originals.
const moved = postHistory.json.messages.filter((m) => m.type !== 'system');
const preNonSystem = preHistory.json.messages.filter((m) => m.type !== 'system');
expect('every message moved', moved.length, preNonSystem.length);
expect(
  'in the same order, with the same seqs',
  moved.map((m) => m.seq).join(','),
  preNonSystem.map((m) => m.seq).join(','),
);

const spaceHistory = await call('GET', `/conversations/${group}/messages?limit=50`, null, owner.auth);
expect('the space itself has no timeline', spaceHistory.json.messages?.length, 0);

const channels = await call('GET', `/conversations/${group}/channels`, null, owner.auth);
expect('one channel listed', channels.json.channels?.length, 1);
expect('named as asked', channels.json.channels?.[0]?.title, 'general');

const postList = await call('GET', '/conversations', null, plain.auth);
const listed = postList.json.conversations.find((c) => c.id === group);
expect('the space is still on the home list', listed?.type, 'space');
expect('the channel is not', postList.json.conversations.some((c) => c.id === channel), false);

const channelSelf = await call('GET', `/conversations/${channel}`, null, plain.auth);
expect('read cursor followed the history', channelSelf.json.conversation?.self?.lastReadSeq, 2);

const rolesAfter = await call('GET', `/conversations/${group}/roles`, null, owner.auth);
expect('roles survived on the space', rolesAfter.json.roles?.some((r) => r.id === captain), true);

const pins = await call('GET', `/conversations/${channel}/pins`, null, owner.auth);
expect('pins followed the messages', pins.json.pins?.length >= 1, true);

const invitesAfter = await call('GET', `/conversations/${group}/invites`, null, owner.auth);
expect('the invite still points at the space', invitesAfter.json.invites?.some((i) => i.code === inviteCode), true);

console.log('\n── roles reach into channels ──────────────────────');
// `plain` holds Release captain on the *space* and has never opened the
// channel: no member row exists there. Inheritance is the only thing that can
// make this work.
const pinInChannel = await call('POST', `/conversations/${channel}/messages`, {
  nonce: `chan_${stamp}`, type: 'text', content: 'hello channel',
}, plain.auth);
expect('a space member can post in a channel they never opened', pinInChannel.status, 201);

const pinIt = await call('PUT', `/conversations/${channel}/pins/${pinInChannel.json.message.id}`, null, plain.auth);
expect('their space role grants pinning there too', pinIt.status, 200);

const outsider = await call('GET', `/conversations/${channel}/messages`, null, undefined);
expect('anonymous is rejected', outsider.status, 401);

console.log('\n── new channels ───────────────────────────────────');
const second = await call('POST', `/conversations/${group}/channels`, {
  title: 'announcements', isAnnouncement: true, position: 1,
}, owner.auth);
expect('announcement channel created', second.status, 201);
const annId = second.json.channel?.id;

const plainPost = await call('POST', `/conversations/${annId}/messages`, {
  nonce: `ann_${stamp}`, type: 'text', content: 'should not send',
}, plain.auth);
expect('ordinary members cannot post in an announcement channel', plainPost.status, 403);

const ownerPost = await call('POST', `/conversations/${annId}/messages`, {
  nonce: `annok_${stamp}`, type: 'text', content: 'ship it',
}, owner.auth);
expect('the owner can', ownerPost.status, 201);

const nonMember = await signUp(`+1574${stamp}`, `out_${stamp}`, 'Outsider');
const peek = await call('GET', `/conversations/${channel}/messages`, null, nonMember.auth);
expect('a non-member of the space gets 404 on its channel', peek.status, 404);

const lastChannelGone = await call('DELETE', `/conversations/${group}/channels/${annId}`, null, owner.auth);
expect('a channel can be deleted', lastChannelGone.status, 200);
const deleteLast = await call('DELETE', `/conversations/${group}/channels/${channel}`, null, owner.auth);
expect('but not the last one', deleteLast.status, 409);

console.log('\n── per-channel notifications ──────────────────────');
// The announcement channel was deleted above, so make a second one: both of
// the sections below are about how two channels behave relative to each other.
const extra = await call('POST', `/conversations/${group}/channels`, { title: 'random' }, owner.auth);
expect('a second channel to compare against', extra.status, 201);

// `plain` has never opened #general in a way that would create a row for them
// on the space's setting, so this exercises the inherit-then-override path.
const beforePref = await call('GET', `/conversations/${group}/channels`, null, plain.auth);
const generalBefore = beforePref.json.channels.find((c) => c.id === channel);
expect('inherits the space setting by default', generalBefore?.notificationLevel, 'all');

await call('PATCH', `/conversations/${group}/state`, { notificationLevel: 'mentions' }, plain.auth);
const inherited = await call('GET', `/conversations/${group}/channels`, null, plain.auth);
expect(
  'changing the space changes every channel that has no override',
  inherited.json.channels.find((c) => c.id === channel)?.notificationLevel,
  'mentions',
);

const perChannel = await call('PATCH', `/conversations/${channel}/state`, { notificationLevel: 'none' }, plain.auth);
expect('a channel takes its own setting', perChannel.status, 200);
const overridden = await call('GET', `/conversations/${group}/channels`, null, plain.auth);
expect(
  'the override wins',
  overridden.json.channels.find((c) => c.id === channel)?.notificationLevel,
  'none',
);
// The whole point of the override being per-channel.
const sibling = overridden.json.channels.find((c) => c.id !== channel);
expect('siblings still inherit', sibling?.notificationLevel, 'mentions');

await call('PATCH', `/conversations/${group}/state`, { notificationLevel: 'all' }, plain.auth);

console.log('\n── reordering ─────────────────────────────────────');
const channelList = await call('GET', `/conversations/${group}/channels`, null, owner.auth);
const ids = channelList.json.channels.map((c) => c.id);
ok('current order', ids.length + ' channels');

const partial = await call('PUT', `/conversations/${group}/channels/order`, { channelIds: [ids[0]] }, owner.auth);
expect('a partial list is refused', partial.status, 422);

const byPlainOrder = await call('PUT', `/conversations/${group}/channels/order`, {
  channelIds: [...ids].reverse(),
}, plain.auth);
expect('an ordinary member cannot reorder', byPlainOrder.status, 403);

const reordered = await call('PUT', `/conversations/${group}/channels/order`, {
  channelIds: [...ids].reverse(),
}, owner.auth);
expect('owner reorders', reordered.status, 200);

const after = await call('GET', `/conversations/${group}/channels`, null, owner.auth);
expect(
  'the list comes back in the new order',
  after.json.channels.map((c) => c.id).join(','),
  [...ids].reverse().join(','),
);
expect('positions are dense from zero', after.json.channels.map((c) => c.position).join(','), '0,1');

console.log('\n───────────────────────────────────────────────────');
console.log(failures === 0 ? '✓ roles and spaces hold' : `✗ ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
