/**
 * Badges and affiliations, end to end.
 *
 * The interesting half of this feature is the *negative* space — who cannot
 * grant what — so most of these checks assert a refusal. The specific things
 * that must hold:
 *
 *   · an unbadged group cannot affiliate anyone
 *   · you cannot claim an affiliation a group did not give you
 *   · revoking either half takes the mark away immediately, on the next read,
 *     with no background job and nothing left to go stale
 *
 * Run the stack first (`pnpm dev`), then:
 *   node scripts/badges.mjs
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const API = process.env.API_BASE ?? 'http://localhost:3000/v1';
const DB_DIR = fileURLToPath(new URL('../../../packages/db', import.meta.url));
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

const TEST_PASSWORD = 'correct-horse-battery-staple';

/**
 * The first argument is ignored. It used to be a phone number; sign-up is
 * email and password now, and the callers below still read more clearly with a
 * per-account discriminator in that position.
 */
async function signUp(_discriminator, username, displayName) {
  const res = await call('POST', '/auth/register', {
    email: `${username}@example.test`,
    password: TEST_PASSWORD,
    username,
    displayName,
    client: { platform: 'web', version: '1.0.0' },
  });
  if (res.status !== 201) throw new Error(`register ${username}: ${JSON.stringify(res.json)}`);
  return { auth: `Bearer ${res.json.accessToken}`, id: res.json.user.id, username };
}

/** Exercises the operator script itself rather than reaching into the database. */
const grant = (kind, needle, badge) =>
  execFileSync('node', ['--env-file=../../.env', 'scripts/grant-badge.mjs', kind, needle, badge], {
    cwd: DB_DIR,
    encoding: 'utf8',
  }).trim();

const stamp = String(Date.now()).slice(-7);

console.log('\n── accounts ───────────────────────────────────────');
const boss = await signUp(`+1555${stamp}`, `boss_${stamp}`, 'Org Owner');
const emp = await signUp(`+1556${stamp}`, `emp_${stamp}`, 'Employee');
const rando = await signUp(`+1557${stamp}`, `rando_${stamp}`, 'Outsider');
ok('three accounts', `${boss.username}, ${emp.username}, ${rando.username}`);

// New accounts default to `whoCanAddToGroups: contacts`, so a stranger cannot
// add them. Opting in here keeps the test about badges rather than privacy.
await call('PATCH', '/users/me/settings', { privacy: { whoCanAddToGroups: 'everyone' } }, emp.auth);

console.log('\n── a plain group cannot affiliate ──────────────────');
const created = await call('POST', '/conversations', {
  type: 'group', title: `Acme ${stamp}`, memberIds: [emp.id],
}, boss.auth);
if (created.status !== 201) bad('create group', JSON.stringify(created.json));
const acme = created.json.conversation.id;
ok('group created', acme);

const tooEarly = await call('PATCH', `/conversations/${acme}/members/${emp.id}`, { isAffiliate: true }, boss.auth);
expect('unbadged group is refused', tooEarly.status, 403);

console.log('\n── grant the group a badge ─────────────────────────');
console.log(`  ${grant('group', acme, 'partner')}`);
const afterBadge = await call('GET', `/conversations/${acme}`, null, boss.auth);
expect('group badge on the wire', afterBadge.json.conversation.badge, 'partner');

console.log('\n── only the group may affiliate ────────────────────');
const byMember = await call('PATCH', `/conversations/${acme}/members/${emp.id}`, { isAffiliate: true }, emp.auth);
expect('a plain member cannot affiliate', byMember.status, 403);

const granted = await call('PATCH', `/conversations/${acme}/members/${emp.id}`, { isAffiliate: true }, boss.auth);
expect('owner affiliates the member', granted.status, 200);

console.log('\n── only the affiliated may claim it ────────────────');
const claimed = await call('PATCH', '/users/me', { affiliationConversationId: acme }, rando.auth);
expect('an outsider cannot claim it', claimed.status, 403);

// Flagged by the group but not yet displayed: nothing should be visible.
const beforeOptIn = await call('GET', `/users/${emp.id}`, null, boss.auth);
expect('nothing shows until the member opts in', beforeOptIn.json.user.affiliation, null);

const optIn = await call('PATCH', '/users/me', { affiliationConversationId: acme }, emp.auth);
expect('member opts in', optIn.status, 200);
expect('own profile carries it', optIn.json.user.affiliation?.title, `Acme ${stamp}`);

console.log('\n── it rides along on messages ──────────────────────');
const sent = await call('POST', `/conversations/${acme}/messages`, {
  nonce: `badge_${stamp}`, type: 'text', content: 'speaking for the org',
}, emp.auth);
expect('message sent', sent.status, 201);

const history = await call('GET', `/conversations/${acme}/messages?limit=10`, null, boss.auth);
const mine = history.json.messages.find((m) => m.senderId === emp.id);
expect('sender affiliation in history', mine?.sender?.affiliation?.title, `Acme ${stamp}`);
expect('and it carries the group badge', mine?.sender?.affiliation?.badge, 'partner');

console.log('\n── a personal badge is separate ────────────────────');
console.log(`  ${grant('user', emp.username, 'verified')}`);
const withBadge = await call('GET', `/conversations/${acme}/messages?limit=10`, null, boss.auth);
const badged = withBadge.json.messages.find((m) => m.senderId === emp.id);
expect('sender badge in history', badged?.sender?.badge, 'verified');
expect('affiliation is still the group', badged?.sender?.affiliation?.badge, 'partner');

const searched = await call('GET', `/users?q=${emp.username}`, null, rando.auth);
expect('search shows the badge', searched.json.users[0]?.badge, 'verified');

console.log('\n── either side can withdraw ────────────────────────');
const revoked = await call('PATCH', `/conversations/${acme}/members/${emp.id}`, { isAffiliate: false }, boss.auth);
expect('group revokes', revoked.status, 200);

// The member's own column still points at Acme. The read-side membership check
// is the only thing standing between that stale pointer and a false badge.
const afterRevoke = await call('GET', `/users/${emp.id}`, null, boss.auth);
expect('affiliation gone on the next read', afterRevoke.json.user.affiliation, null);
expect('personal badge is untouched', afterRevoke.json.user.badge, 'verified');

await call('PATCH', `/conversations/${acme}/members/${emp.id}`, { isAffiliate: true }, boss.auth);
const restored = await call('GET', `/users/${emp.id}`, null, boss.auth);
expect('re-affiliating restores it', restored.json.user.affiliation?.badge, 'partner');

console.log('\n── the group losing its badge ends it ──────────────');
console.log(`  ${grant('group', acme, 'none').split('\n').join('\n  ')}`);
const afterStrip = await call('GET', `/users/${emp.id}`, null, boss.auth);
expect('affiliation gone with the group badge', afterStrip.json.user.affiliation, null);

// And the flags are cleared, so restoring the badge does not silently
// re-confer everything that was granted under it.
console.log(`  ${grant('group', acme, 'partner')}`);
const afterRestore = await call('GET', `/users/${emp.id}`, null, boss.auth);
expect('affiliates are not silently restored', afterRestore.json.user.affiliation, null);

console.log('\n── leaving the group ends it too ───────────────────');
await call('PATCH', `/conversations/${acme}/members/${emp.id}`, { isAffiliate: true }, boss.auth);
const beforeLeave = await call('GET', `/users/${emp.id}`, null, boss.auth);
expect('affiliated again', beforeLeave.json.user.affiliation?.badge, 'partner');

// Leaving is removing yourself — there is no separate endpoint.
const left = await call('DELETE', `/conversations/${acme}/members/${emp.id}`, null, emp.auth);
if (left.status !== 200) bad('leave', `${left.status} ${JSON.stringify(left.json)}`);
const afterLeave = await call('GET', `/users/${emp.id}`, null, boss.auth);
expect('affiliation gone after leaving', afterLeave.json.user.affiliation, null);

console.log('\n───────────────────────────────────────────────────');
console.log(failures === 0 ? '✓ badges and affiliations hold' : `✗ ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
