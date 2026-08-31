/**
 * Is a private channel actually private?
 *
 * The parity script proves the SQL agrees with the TypeScript. This proves the
 * thing that agreement was for: that the four fan-out queries which used to
 * substitute "member of the space" for "can see this channel" now ask the
 * right question. Each case below runs the *shipped predicate*, copied from
 * the file it lives in, against a fixture built to trip it.
 *
 * The four, and what each one leaked:
 *
 *   gateway IDENTIFY   apps/gateway/src/server.ts    live message contents
 *   gateway SUBSCRIBE  apps/gateway/src/server.ts    the same, on demand, by id
 *   push fan-out       apps/worker/src/jobs/push.ts  message text on a lock screen
 *   mention fan-out    apps/api/src/services/messages.ts  a badge, a push, and
 *   mention inbox      apps/api/src/routes/users.ts       a readable copy
 *
 *   pnpm --filter @yappy/db channel-privacy-check
 */
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { Permission, newId } from '@yappy/shared';

const url =
  process.env.DATABASE_URL ??
  (await readFile(new URL('../../../.env', import.meta.url), 'utf8')).match(
    /DATABASE_URL=(.+)/,
  )?.[1]?.trim();

const sql = postgres(url, { max: 1, onnotice: () => {} });

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

// ─── Fixture: a space, a locked channel, and one person shut out of it ───────

const ids = {
  owner: newId(),
  insider: newId(),
  outsider: newId(),
  space: newId(),
  channel: newId(),
  role: newId(),
  message: newId(),
};

await sql.begin(async (tx) => {
  for (const [who, id] of [
    ['owner', ids.owner],
    ['insider', ids.insider],
    ['outsider', ids.outsider],
  ]) {
    const name = `priv_${who}_${Date.now()}`;
    await tx`insert into users (id, username, display_name, email)
             values (${id}, ${name}, ${name}, ${`${name}@privacy.invalid`})`;
  }

  await tx`insert into conversations (id, type, title, owner_id)
           values (${ids.space}, 'space', 'privacy space', ${ids.owner})`;
  // base_permissions = 0 plus a role allowed back in: what ChannelAccess.tsx writes.
  await tx`insert into conversations (id, type, title, owner_id, parent_id, base_permissions)
           values (${ids.channel}, 'channel', 'tickets', ${ids.owner}, ${ids.space}, 0)`;

  for (const [id, role] of [
    [ids.owner, 'owner'],
    [ids.insider, 'member'],
    [ids.outsider, 'member'],
  ]) {
    await tx`insert into conversation_members (conversation_id, user_id, role)
             values (${ids.space}, ${id}, ${role})`;
  }

  await tx`insert into conversation_roles (id, conversation_id, name, permissions, position)
           values (${ids.role}, ${ids.space}, 'Support', 0, 1)`;
  await tx`insert into member_roles (conversation_id, user_id, role_id)
           values (${ids.space}, ${ids.insider}, ${ids.role})`;
  await tx`insert into conversation_role_overwrites (conversation_id, role_id, allow, deny)
           values (${ids.channel}, ${ids.role},
                   ${(Permission.VIEW_CONVERSATION | Permission.READ_HISTORY).toString()}, 0)`;

  await tx`update conversations set message_seq = 1 where id = ${ids.channel}`;
  await tx`insert into messages (id, conversation_id, sender_id, seq, type, content)
           values (${ids.message}, ${ids.channel}, ${ids.owner}, 1, 'text', 'ticket contents')`;
});

console.log('\nWho can see the locked channel\n');

const viewers = new Set(
  (await sql`select user_id from conversation_viewers(${ids.channel})`).map((r) => r.user_id),
);
check('owner can', viewers.has(ids.owner));
check('the role holder can', viewers.has(ids.insider));
check('the ordinary space member cannot', !viewers.has(ids.outsider));

// ─── The four fan-outs ───────────────────────────────────────────────────────

console.log('\nFan-out predicates, as shipped\n');

/** apps/gateway/src/server.ts — IDENTIFY. */
const identify = (userId) => sql`
  select c.id
    from conversations c
    join conversation_members m
      on m.conversation_id = coalesce(c.parent_id, c.id)
     and m.user_id = ${userId} and m.left_at is null
   where c.deleted_at is null
     and c.id = ${ids.channel}
     and (not conversation_is_gated(c.id) or can_view_conversation(c.id, ${userId}))`;

check('gateway IDENTIFY subscribes the insider', (await identify(ids.insider)).length === 1);
check(
  'gateway IDENTIFY does NOT subscribe the outsider',
  (await identify(ids.outsider)).length === 0,
  'live message contents would be delivered to them',
);

/** apps/worker/src/jobs/push.ts — recipient selection. */
const pushTargets = new Set(
  (
    await sql`
      select am.user_id
        from conversations c
        join conversation_members am
          on am.conversation_id = coalesce(c.parent_id, c.id)
         and am.left_at is null
         and (not conversation_is_gated(c.id) or can_view_conversation(c.id, am.user_id))
       where c.id = ${ids.channel}`
  ).map((r) => r.user_id),
);
check('push reaches the insider', pushTargets.has(ids.insider));
check(
  'push does NOT reach the outsider',
  !pushTargets.has(ids.outsider),
  'message text would appear on their lock screen',
);

/** apps/api/src/services/messages.ts — the @everyone fan-out. */
await sql`
  insert into message_mentions (message_id, user_id, conversation_id, seq, is_broadcast)
  select ${ids.message}, am.user_id, ${ids.channel}, 1, true
    from conversation_members am
   where am.conversation_id = ${ids.space}
     and am.left_at is null
     and am.user_id <> ${ids.owner}
     and (not conversation_is_gated(${ids.channel})
          or am.user_id in (select v.user_id from conversation_viewers(${ids.channel}) v))
  on conflict do nothing`;

const mentioned = new Set(
  (await sql`select user_id from message_mentions where message_id = ${ids.message}`).map(
    (r) => r.user_id,
  ),
);
check('@everyone writes a mention row for the insider', mentioned.has(ids.insider));
check(
  '@everyone writes NO mention row for the outsider',
  !mentioned.has(ids.outsider),
  'they would get a badge, a push, and the message body in their inbox',
);

// The badge follows the row, via the mentions_bump trigger.
const [badge] = await sql`
  select coalesce(sum(mention_count), 0)::int as n from conversation_members
   where user_id = ${ids.outsider} and conversation_id in (${ids.space}, ${ids.channel})`;
check('and no unread mention badge for the outsider', badge.n === 0, `badge=${badge.n}`);

/**
 * apps/api/src/routes/users.ts — the @ inbox, for a row that already exists.
 * Written directly, standing in for one persisted before the sender's access
 * was revoked: the read filter is what makes revocation take effect.
 */
await sql`
  insert into message_mentions (message_id, user_id, conversation_id, seq, is_broadcast)
  values (${ids.message}, ${ids.outsider}, ${ids.channel}, 1, false)
  on conflict do nothing`;

const inbox = async (userId) => sql`
  select mm.message_id
    from message_mentions mm
    join messages msg on msg.id = mm.message_id
    join conversations c on c.id = msg.conversation_id
    join conversation_members m
      on m.conversation_id = coalesce(c.parent_id, c.id)
     and m.user_id = ${userId} and m.left_at is null
   where mm.user_id = ${userId}
     and msg.deleted_at is null and c.deleted_at is null
     and (not conversation_is_gated(c.id) or can_view_conversation(c.id, ${userId}))`;

check(
  'the inbox hides a stale mention row from a revoked viewer',
  (await inbox(ids.outsider)).length === 0,
  'a mention row is a readable copy of the message',
);
check('the inbox still serves the insider', (await inbox(ids.insider)).length === 1);

// ─── Regression guard: an ordinary channel is untouched ──────────────────────

console.log('\nAn ordinary channel still behaves exactly as before\n');

const openChannel = newId();
await sql`insert into conversations (id, type, title, owner_id, parent_id)
          values (${openChannel}, 'channel', 'general', ${ids.owner}, ${ids.space})`;
const openViewers = new Set(
  (await sql`select user_id from conversation_viewers(${openChannel})`).map((r) => r.user_id),
);
check('not gated, so the fast path applies', !(await sql`select conversation_is_gated(${openChannel}) as g`)[0].g);
check('every space member sees it', [ids.owner, ids.insider, ids.outsider].every((id) => openViewers.has(id)));

// ─── Cleanup ─────────────────────────────────────────────────────────────────

await sql`delete from conversations where id in (${openChannel}, ${ids.channel}, ${ids.space})`;
await sql`delete from users where id = any(${[ids.owner, ids.insider, ids.outsider]})`;
await sql.end({ timeout: 5 });

console.log(failures === 0 ? '\n✓ private channels are private\n' : `\n✗ ${failures} failure(s)\n`);
process.exit(failures === 0 ? 0 : 1);
