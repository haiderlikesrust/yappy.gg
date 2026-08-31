/**
 * Does the SQL agree with the TypeScript?
 *
 * `conversation_permissions()` in sql/0003_functions.sql is a second
 * implementation of `effectivePermissions()` from @yappy/shared. Two
 * implementations of one security decision will drift, and the direction of
 * the drift decides whether a private channel leaks or an admin gets locked
 * out of their own space. Neither is a thing to find out in production.
 *
 * So this asks the database and the TypeScript the same question about the
 * same inputs and fails on any disagreement. Two passes:
 *
 *   1. Synthetic — a space built here on purpose, with every shape that makes
 *      the composition interesting: a lowered base, a role overwrite that
 *      allows one role back in, a per-member deny, a per-member allow, a
 *      restricted member, a moderator, an admin, an owner. This is the pass
 *      that matters, because a dev database contains none of these.
 *   2. Differential — every (conversation, member) pair that already exists,
 *      compared row for row. Cheap, and it catches anything the synthetic
 *      cases did not think of.
 *
 * Destructive only in that it creates and then deletes its own fixture space.
 *
 *   pnpm --filter @yappy/db visibility-parity
 */
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import {
  DEFAULT_CONVERSATION_PERMISSIONS,
  Permission,
  ROLE_PERMISSIONS,
  effectivePermissions,
  has,
  newId,
} from '@yappy/shared';

const url =
  process.env.DATABASE_URL ??
  (await readFile(new URL('../../../.env', import.meta.url), 'utf8')).match(
    /DATABASE_URL=(.+)/,
  )?.[1]?.trim();

if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const sql = postgres(url, { max: 1, onnotice: () => {} });

let failures = 0;
let checked = 0;
const fail = (what, detail) => {
  failures += 1;
  console.log(`  FAIL  ${what}`);
  if (detail) console.log(`        ${detail}`);
};

/** The TypeScript answer, from the same inputs loadMemberContext feeds it. */
function tsPermissions(row) {
  return effectivePermissions({
    conversationType: row.type,
    basePermissions: row.base_permissions === null ? undefined : BigInt(row.base_permissions),
    role: row.role,
    rolePermissions: BigInt(row.role_perms),
    roleAllow: BigInt(row.role_allow),
    roleDeny: BigInt(row.role_deny),
    allow: BigInt(row.m_allow),
    deny: BigInt(row.m_deny),
    // Mute never touches VIEW_CONVERSATION, and the SQL omits it by design.
    mutedUntil: null,
  });
}

/**
 * The inputs `loadMemberContext` would gather, for every member of a
 * conversation's scope at once. Deliberately assembled with plain joins rather
 * than by calling the function under test — comparing a function to itself
 * proves nothing.
 */
const INPUTS = (conversationId) => sql`
  with ch as (
    select c.id, c.type::text as type, c.parent_id,
           coalesce(c.parent_id, c.id) as scope_id,
           c.base_permissions
      from conversations c
     where c.id = ${conversationId} and c.deleted_at is null
  )
  select a.user_id,
         ch.type,
         ch.base_permissions::text as base_permissions,
         a.role::text as role,
         coalesce((
           select bit_or(r.permissions) from member_roles mr
             join conversation_roles r on r.id = mr.role_id
            where mr.conversation_id = ch.scope_id and mr.user_id = a.user_id
         ), 0)::text as role_perms,
         coalesce((
           select bit_or(o.allow) from conversation_role_overwrites o
             join member_roles mr on mr.role_id = o.role_id
            where o.conversation_id = ch.id
              and mr.conversation_id = ch.scope_id and mr.user_id = a.user_id
         ), 0)::text as role_allow,
         coalesce((
           select bit_or(o.deny) from conversation_role_overwrites o
             join member_roles mr on mr.role_id = o.role_id
            where o.conversation_id = ch.id
              and mr.conversation_id = ch.scope_id and mr.user_id = a.user_id
         ), 0)::text as role_deny,
         (coalesce(cm.allow, 0) | case when ch.parent_id is not null then a.allow else 0 end)::text as m_allow,
         (coalesce(cm.deny , 0) | case when ch.parent_id is not null then a.deny  else 0 end)::text as m_deny
    from ch
    join conversation_members a
      on a.conversation_id = ch.scope_id and a.left_at is null
    left join conversation_members cm
      on cm.conversation_id = ch.id and cm.user_id = a.user_id
`;

/** Compare SQL and TS for one conversation. */
async function compare(conversationId, label) {
  const [inputs, fromSql, viewers] = await Promise.all([
    INPUTS(conversationId),
    sql`select user_id, permissions::text as permissions from conversation_permissions(${conversationId})`,
    sql`select user_id from conversation_viewers(${conversationId})`,
  ]);

  const sqlByUser = new Map(fromSql.map((r) => [r.user_id, BigInt(r.permissions)]));
  const viewerSet = new Set(viewers.map((r) => r.user_id));

  if (sqlByUser.size !== inputs.length) {
    fail(`${label}: roster size`, `sql returned ${sqlByUser.size}, expected ${inputs.length}`);
  }

  for (const row of inputs) {
    checked += 1;
    const expected = tsPermissions(row);
    const actual = sqlByUser.get(row.user_id);
    if (actual === undefined) {
      fail(`${label}: ${row.user_id} missing from conversation_permissions()`);
      continue;
    }
    if (actual !== expected) {
      fail(
        `${label}: permissions differ for ${row.user_id} (role=${row.role})`,
        `ts=${expected} sql=${actual} xor=${(actual ^ expected).toString(2)}`,
      );
    }
    // The decision the fan-outs actually make.
    const expectedView = has(expected, Permission.VIEW_CONVERSATION);
    const actualView = viewerSet.has(row.user_id);
    if (expectedView !== actualView) {
      fail(
        `${label}: VIEW differs for ${row.user_id} (role=${row.role})`,
        `ts=${expectedView} sql=${actualView}`,
      );
    }
  }
}

// ─── Pass 1: synthetic ───────────────────────────────────────────────────────

console.log('\nSynthetic space — every shape that makes composition interesting\n');

const fixture = await sql.begin(async (tx) => {
  // Ids are UUIDv7 minted in app code, not database defaults.
  const mk = async (username) => {
    const id = newId();
    await tx`
      insert into users (id, username, display_name, email)
      values (${id}, ${username}, ${username}, ${`${username}@parity.invalid`})`;
    return id;
  };

  const owner = await mk(`par_owner_${Date.now()}`);
  const admin = await mk(`par_admin_${Date.now()}`);
  const mod = await mk(`par_mod_${Date.now()}`);
  const plain = await mk(`par_plain_${Date.now()}`);
  const denied = await mk(`par_denied_${Date.now()}`);
  const allowed = await mk(`par_allowed_${Date.now()}`);
  const restricted = await mk(`par_restricted_${Date.now()}`);
  const roleHolder = await mk(`par_rolehold_${Date.now()}`);

  const space = { id: newId() };
  await tx`
    insert into conversations (id, type, title, owner_id)
    values (${space.id}, 'space', 'parity space', ${owner})`;

  // A channel locked to nothing, then opened back up to one named role — the
  // exact shape apps/webapp/src/ui/group/ChannelAccess.tsx writes.
  const channel = { id: newId() };
  await tx`
    insert into conversations (id, type, title, owner_id, parent_id, base_permissions)
    values (${channel.id}, 'channel', 'locked', ${owner}, ${space.id}, 0)`;

  const members = [
    [owner, 'owner'],
    [admin, 'admin'],
    [mod, 'moderator'],
    [plain, 'member'],
    [denied, 'member'],
    [allowed, 'member'],
    [restricted, 'restricted'],
    [roleHolder, 'member'],
  ];
  for (const [id, role] of members) {
    await tx`insert into conversation_members (conversation_id, user_id, role)
             values (${space.id}, ${id}, ${role})`;
  }

  const named = { id: newId() };
  await tx`
    insert into conversation_roles (id, conversation_id, name, permissions, position)
    values (${named.id}, ${space.id}, 'Premium', 0, 1)`;
  await tx`insert into member_roles (conversation_id, user_id, role_id)
           values (${space.id}, ${roleHolder}, ${named.id})`;

  // The role is let back into the locked channel.
  const view = (Permission.VIEW_CONVERSATION | Permission.READ_HISTORY).toString();
  await tx`insert into conversation_role_overwrites (conversation_id, role_id, allow, deny)
           values (${channel.id}, ${named.id}, ${view}, 0)`;

  // A per-member deny that strips VIEW in this channel only, and a per-member
  // allow that grants it — the two narrowest statements, which must win.
  await tx`insert into conversation_members (conversation_id, user_id, role, deny)
           values (${channel.id}, ${denied}, 'member', ${Permission.VIEW_CONVERSATION.toString()})`;
  await tx`insert into conversation_members (conversation_id, user_id, role, allow)
           values (${channel.id}, ${allowed}, 'member', ${view})`;

  return { space: space.id, channel: channel.id, users: members.map(([id]) => id) };
});

await compare(fixture.space, 'space');
await compare(fixture.channel, 'locked channel');

// The properties the whole change exists to guarantee, stated plainly.
const viewers = new Set(
  (await sql`select user_id from conversation_viewers(${fixture.channel})`).map((r) => r.user_id),
);
const [ownerId, adminId, modId, plainId, deniedId, allowedId, restrictedId, roleHolderId] =
  fixture.users;

const expect = (name, cond) => {
  checked += 1;
  if (!cond) fail(name);
};
const syntheticBase = failures;
expect('owner sees the locked channel', viewers.has(ownerId));
expect('administrator sees it despite base 0', viewers.has(adminId));
/*
 * A moderator sees it too, and that surprised me enough to write it down.
 *
 * `base_permissions = 0` does not hide a channel from the staff ladder:
 * ROLE_PERMISSIONS.moderator is MODERATOR, which is built on BASE_MEMBER,
 * which carries VIEW_CONVERSATION — and permissions.ts:225 ORs the ladder in
 * on top of the base. Lowering the base only takes rights away from plain
 * members, exactly as the comment at permissions.ts:227 says it should.
 *
 * So "locked channel" means locked to members, not locked to staff. To hide
 * one from moderators you need a role overwrite that denies them, and the
 * only actor a channel overwrite can never lock out is an administrator
 * (permissions.ts:230, and the deliberate ordering it documents).
 */
expect('moderator sees it: the ladder carries VIEW past a zeroed base', viewers.has(modId));
expect('plain member does NOT see it', !viewers.has(plainId));
expect('role holder sees it via the overwrite', viewers.has(roleHolderId));
expect('per-member allow sees it', viewers.has(allowedId));
expect('per-member deny does not see it', !viewers.has(deniedId));
/*
 * A restricted member sees it as well, and this one is a genuine oddity in the
 * model rather than a surprise in the reading: permissions.ts:214 returns
 * `RESTRICTED | allow` without ever consulting the base or the channel's
 * overwrites, and RESTRICTED carries VIEW_CONVERSATION. Mirrored rather than
 * corrected — the fan-outs must agree with what REST enforces, and changing
 * what REST enforces is a separate decision.
 */
expect('restricted member sees it (mirrors permissions.ts:214)', viewers.has(restrictedId));

console.log(
  `  ${failures === syntheticBase ? 'ok  ' : 'FAIL'}  synthetic space (${checked} assertions)`,
);

await sql`delete from conversations where id in (${fixture.channel}, ${fixture.space})`;
await sql`delete from users where id = any(${fixture.users})`;

// ─── Pass 2: differential over everything already here ───────────────────────

console.log('\nDifferential — every conversation already in this database\n');

const all = await sql`
  select id, type::text as type from conversations where deleted_at is null order by id`;
const before = failures;
for (const c of all) await compare(c.id, `${c.type} ${c.id.slice(0, 8)}`);
console.log(
  `  ${failures === before ? 'ok  ' : 'FAIL'}  ${all.length} conversations, ${checked} pairs total`,
);

// ─── Constants ───────────────────────────────────────────────────────────────

console.log('\nConstants — SQL literals against @yappy/shared\n');
const constantsBase = failures;
const constants = Object.fromEntries(
  (await sql`select name, value::text as value from permission_constants()`).map((r) => [
    r.name,
    BigInt(r.value),
  ]),
);
const expectConst = (name, want) => {
  checked += 1;
  if (constants[name] !== want) fail(`constant ${name}`, `sql=${constants[name]} ts=${want}`);
};
expectConst('ADMINISTRATOR', Permission.ADMINISTRATOR);
expectConst('VIEW_CONVERSATION', Permission.VIEW_CONVERSATION);
for (const [role, value] of Object.entries(ROLE_PERMISSIONS)) expectConst(`role.${role}`, value);
for (const [type, value] of Object.entries(DEFAULT_CONVERSATION_PERMISSIONS)) {
  expectConst(`base.${type}`, value);
}
console.log(`  ${failures === constantsBase ? 'ok  ' : 'FAIL'}  constants`);

await sql.end({ timeout: 5 });

console.log(
  failures === 0
    ? `\n✓ SQL and TypeScript agree — ${checked} checks\n`
    : `\n✗ ${failures} disagreement(s) across ${checked} checks\n`,
);
process.exit(failures === 0 ? 0 : 1);
