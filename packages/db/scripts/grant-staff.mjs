/**
 * Make someone yappy staff, or take it away.
 *
 *   node --env-file=../../.env scripts/grant-staff.mjs <username>
 *   node --env-file=../../.env scripts/grant-staff.mjs <username> --revoke
 *
 * Staff is three things at once, and this script keeps them in step:
 *   is_staff     — the authorisation the server checks
 *   badge        — the mark everyone sees
 *   membership   — a seat in the Yappy Staff space (if it exists yet)
 *
 * Deliberately a script and not an endpoint. The set of people who can mint
 * staff should be "whoever can run commands on the server", not "whoever is
 * already staff" — self-replicating admin is how one compromised account
 * becomes ten.
 */
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Run with --env-file=../../.env');
  process.exit(1);
}

const [, , username, flag] = process.argv;
const revoke = flag === '--revoke';

if (!username) {
  console.error('Usage: grant-staff.mjs <username> [--revoke]');
  process.exit(1);
}

const sql = postgres(url, { max: 1 });

try {
  const [user] = await sql`
    select id, username, is_bot from users
     where username = ${username} and deleted_at is null`;

  if (!user) {
    console.error(`No account named @${username}.`);
    process.exit(1);
  }
  if (user.is_bot) {
    // A bot with staff powers is a bot token away from being a staff account.
    console.error('Bots cannot be staff.');
    process.exit(1);
  }

  const [space] = await sql`
    select id from conversations where system_key = 'staff_space'`;

  await sql.begin(async (tx) => {
    if (revoke) {
      await tx`
        update users
           set is_staff = false,
               badge = case when badge = 'staff' then null else badge end
         where id = ${user.id}`;
      if (space) {
        await tx`
          update conversation_members set left_at = now()
           where conversation_id = ${space.id} and user_id = ${user.id} and left_at is null`;
      }
    } else {
      await tx`
        update users set is_staff = true, badge = 'staff' where id = ${user.id}`;
      if (space) {
        await tx`
          insert into conversation_members (conversation_id, user_id, role)
          values (${space.id}, ${user.id}, 'admin')
          on conflict (conversation_id, user_id) do update set left_at = null`;
      }
    }
  });

  console.log(
    revoke
      ? `@${username} is no longer staff${space ? ' and has left the staff space' : ''}.`
      : `@${username} is now staff${space ? ' and seated in the staff space' : ' (run ensure-staff-space.mjs to create the space)'}.`,
  );
} finally {
  await sql.end();
}
