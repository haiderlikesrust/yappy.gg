/**
 * The two rules that decide who can take a group away from its owner.
 *
 *   1. Rank is read from the space, never from a channel's stale copy of it.
 *   2. ADMINISTRATOR is the owner's to hand out, by every route that hands
 *      anything out.
 *
 * Both had a hole. A channel's `conversation_members.role` is copied once when
 * the row is materialised and never updated, so it drifts from the space's the
 * moment anybody is promoted or ownership moves — and a dozen call sites read
 * it to decide rank, including assertCanGrant's owner exemption. And the
 * invite-mint path exempted any administrator from its subset test, which was
 * then read as exemption from the ADMINISTRATOR rule itself.
 *
 *   pnpm --filter @yappy/api escalation-check
 */
import postgres from 'postgres';
import { readFile } from 'node:fs/promises';
import { Permission } from '@yappy/shared';

const API = 'http://localhost:3000/v1';
const url = (await readFile(new URL('../../../.env', import.meta.url), 'utf8')).match(
  /DATABASE_URL=(.+)/,
)[1].trim();
const sql = postgres(url, { max: 1, onnotice: () => {} });

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

const owner = await login('webclient.test@yappy.gg', 'esc owner');
const admin = await login('webclient.test2@yappy.gg', 'esc admin');

const made = await call(owner, 'POST', '/conversations', {
  type: 'space',
  title: `esc ${Date.now()}`,
});
const spaceId = made.body.conversation.id;
const invite = await call(owner, 'POST', `/conversations/${spaceId}/invites`, {});
await call(admin, 'POST', `/conversations/invites/${invite.body.invite?.code ?? invite.body.code}/join`, {});

const channel = await call(owner, 'POST', `/conversations/${spaceId}/channels`, {
  title: `stale-${Date.now()}`,
});
const channelId = channel.body.channel.id;

// ─── 1. A channel's copy of `role` must not decide rank ──────────────────────

console.log('\nRank comes from the space, not a channel snapshot\n');

// Give the second account a channel row while they are still a plain member,
// then promote them in the space. The channel row keeps saying "member".
await call(admin, 'GET', `/conversations/${channelId}/messages?limit=1`);
await sql`
  insert into conversation_members (conversation_id, user_id, role)
  values (${channelId}, ${admin.userId}, 'member')
  on conflict (conversation_id, user_id) do nothing`;
await call(owner, 'PATCH', `/conversations/${spaceId}/members/${admin.userId}`, { role: 'admin' });

const [drift] = await sql`
  select cm.role::text as channel_role, pm.role::text as space_role
    from conversation_members cm
    join conversation_members pm
      on pm.conversation_id = ${spaceId} and pm.user_id = cm.user_id
   where cm.conversation_id = ${channelId} and cm.user_id = ${admin.userId}`;
check('the channel row really has drifted', drift?.channel_role !== drift?.space_role,
  `channel=${drift?.channel_role} space=${drift?.space_role}`);

// An admin whose channel row still says "member" must be able to manage the
// channel. Before the fix, ctx.member.role read "member" here.
const overwrite = await call(admin, 'PUT', `/conversations/${channelId}/permissions/${(
  await call(owner, 'POST', `/conversations/${spaceId}/roles`, { name: `R${Date.now()}`, permissions: '0' })
).body.role.id}`, { allow: '0', deny: '0' });
check('a promoted admin can act in a channel whose row predates the promotion',
  overwrite.status < 300, `status ${overwrite.status}`);

// The dangerous direction: transfer ownership, then check the ex-owner has
// lost the assertCanGrant exemption inside a channel they had already opened.
await call(owner, 'GET', `/conversations/${channelId}/messages?limit=1`);
await call(owner, 'POST', `/conversations/${spaceId}/transfer`, { userId: admin.userId }).catch(() => {});
const [after] = await sql`
  select role::text as role from conversation_members
   where conversation_id = ${spaceId} and user_id = ${owner.userId}`;
if (after && after.role !== 'owner') {
  const grab = await call(owner, 'POST', `/conversations/${spaceId}/roles`, {
    name: `Grab${Date.now()}`,
    permissions: Permission.ADMINISTRATOR.toString(),
  });
  check('an ex-owner cannot mint an ADMINISTRATOR role', grab.status >= 400, `status ${grab.status}`);
} else {
  console.log('  --    ownership transfer unavailable here; ex-owner case not exercised');
}

// ─── 2. ADMINISTRATOR is the owner's alone, on every path ────────────────────

console.log('\nADMINISTRATOR cannot be handed out by a non-owner\n');

// `admin` is now the owner (or still an admin). Use whichever is not the owner
// to try to mint an invite carrying an ADMINISTRATOR role.
const [ownerRow] = await sql`
  select user_id from conversation_members
   where conversation_id = ${spaceId} and role = 'owner' limit 1`;
const nonOwner = ownerRow?.user_id === owner.userId ? admin : owner;
const realOwner = ownerRow?.user_id === owner.userId ? owner : admin;

const adminRole = await call(realOwner, 'POST', `/conversations/${spaceId}/roles`, {
  name: `Admin${Date.now()}`,
  permissions: Permission.ADMINISTRATOR.toString(),
});
if (adminRole.status < 300) {
  await call(realOwner, 'PATCH', `/conversations/${spaceId}/members/${nonOwner.userId}`, {
    role: 'admin',
  });
  const minted = await call(nonOwner, 'POST', `/conversations/${spaceId}/invites`, {
    roleId: adminRole.body.role.id,
  });
  check('a non-owner admin cannot mint an invite granting ADMINISTRATOR',
    minted.status >= 400, `status ${minted.status} — redemption re-checks nothing`);

  const byOwner = await call(realOwner, 'POST', `/conversations/${spaceId}/invites`, {
    roleId: adminRole.body.role.id,
  });
  check('the owner still can', byOwner.status < 300, `status ${byOwner.status}`);
} else {
  check('owner could create an ADMINISTRATOR role', false,
    JSON.stringify(adminRole.body).slice(0, 160));
}

await call(realOwner, 'DELETE', `/conversations/${spaceId}`);
await sql.end({ timeout: 5 });

console.log(failures === 0 ? '\n✓ rank and ADMINISTRATOR hold\n' : `\n✗ ${failures} failure(s)\n`);
process.exit(failures === 0 ? 0 : 1);
