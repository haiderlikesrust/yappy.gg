/**
 * Grant or revoke an identity badge.
 *
 *   node scripts/grant-badge.mjs user  @ada           verified
 *   node scripts/grant-badge.mjs group "Backend crew" partner
 *   node scripts/grant-badge.mjs user  @ada           none
 *   node scripts/grant-badge.mjs list
 *
 * Deliberately a script and not an endpoint. A badge is the platform asserting
 * something about an account; the moment there is a self-service route for it,
 * somebody eventually wires it to a payment and the mark stops meaning
 * anything. When there is an admin console this becomes its one write.
 *
 * Run from packages/db:  node --env-file=../../.env scripts/grant-badge.mjs …
 */
import postgres from 'postgres';

const BADGES = ['verified', 'partner', 'staff'];
const [kind, needleRaw, badgeRaw] = process.argv.slice(2);

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set — run with --env-file=../../.env');
  process.exit(1);
}
const sql = postgres(url, { max: 1 });

const done = async (code = 0) => {
  await sql.end();
  process.exit(code);
};

if (kind === 'list') {
  const users = await sql`
    select username, display_name, badge from users
     where badge is not null and deleted_at is null order by badge, username`;
  const groups = await sql`
    select title, handle, badge from conversations
     where badge is not null and deleted_at is null order by badge, title`;

  console.log(`\npeople (${users.length})`);
  for (const u of users) console.log(`  ${u.badge.padEnd(9)} @${u.username ?? '—'}  ${u.display_name ?? ''}`);
  console.log(`\ngroups (${groups.length})`);
  for (const g of groups) console.log(`  ${g.badge.padEnd(9)} ${g.title ?? '—'}${g.handle ? `  @${g.handle}` : ''}`);
  console.log();
  await done();
}

if (!['user', 'group'].includes(kind) || !needleRaw || !badgeRaw) {
  console.error('usage: grant-badge.mjs <user|group> <@username|title> <verified|partner|staff|none>');
  console.error('       grant-badge.mjs list');
  await done(1);
}

const badge = badgeRaw === 'none' ? null : badgeRaw;
if (badge !== null && !BADGES.includes(badge)) {
  console.error(`unknown badge "${badgeRaw}" — one of ${BADGES.join(', ')} or none`);
  await done(1);
}

if (kind === 'user') {
  const needle = needleRaw.replace(/^@/, '');
  // `is_verified` is kept in step because existing filters read it; `badge` is
  // what gets rendered.
  const [row] = await sql`
    update users
       set badge = ${badge}, is_verified = ${badge !== null}
     where (username = ${needle} or id::text = ${needle}) and deleted_at is null
    returning id, username, display_name, badge`;

  if (!row) {
    console.error(`no user matched "${needleRaw}"`);
    await done(1);
  }
  console.log(`@${row.username}  ${row.display_name ?? ''} → ${row.badge ?? 'no badge'}`);
} else {
  const [row] = await sql`
    update conversations
       set badge = ${badge}
     where (title = ${needleRaw} or handle = ${needleRaw.replace(/^@/, '')} or id::text = ${needleRaw})
       and type in ('group', 'channel') and deleted_at is null
    returning id, title, badge`;

  if (!row) {
    console.error(`no group matched "${needleRaw}"`);
    await done(1);
  }
  console.log(`${row.title} → ${row.badge ?? 'no badge'}`);

  // Losing the badge takes the group's affiliates with it. Reads already check
  // this (see apps/api/src/lib/affiliation.ts), but leaving the flags set would
  // silently re-confer everything the moment the badge came back.
  if (badge === null) {
    const cleared = await sql`
      update conversation_members set is_affiliate = false
       where conversation_id = ${row.id} and is_affiliate returning user_id`;
    if (cleared.length) console.log(`  cleared ${cleared.length} affiliate flag(s)`);
  }
}

await done();
