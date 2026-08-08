/**
 * Create the first-party yapper bot.
 *
 *   node --env-file=../../.env scripts/create-yapper.mjs
 *
 * Idempotent: running it twice will not create a second bot, and will not
 * rotate a token that something is already using.
 *
 * yapper is a user row like any other bot (see the `applications` comment for
 * why). What makes it first-party is only that the API dispatches its commands
 * in-process instead of over a webhook — there is no privileged flag here.
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Run with --env-file=../../.env');
  process.exit(1);
}

const sql = postgres(url, { max: 1 });

try {
  const [existing] = await sql`
    select id from users where username = 'yapper' and is_bot and deleted_at is null`;

  if (existing) {
    console.log(`yapper already exists (${existing.id})`);
    process.exit(0);
  }

  // The bot needs an owner. Any human will do for a self-hosted instance; the
  // oldest account is the closest thing to "the operator" without inventing a
  // separate notion of one.
  const [owner] = await sql`
    select id, username from users
     where not is_bot and deleted_at is null and username is not null
     order by created_at limit 1`;

  if (!owner) {
    console.error('No human account exists yet. Sign up first, then run this.');
    process.exit(1);
  }

  const botId = randomUUID();

  await sql.begin(async (tx) => {
    await tx`
      insert into users (id, username, display_name, bio, is_bot, is_verified, badge, privacy)
      values (
        ${botId}, 'yapper', 'yapper',
        'I handle developer-portal sign-ins. Say /help.',
        true, true, 'staff',
        ${sql.json({
          // Anyone must be able to open a DM with it, or the sign-in flow has
          // a chicken-and-egg problem for every new developer.
          whoCanDm: 'everyone',
          whoCanAddToGroups: 'nobody',
          whoCanSeeLastSeen: 'everyone',
          whoCanSeeAvatar: 'everyone',
          whoCanCall: 'nobody',
          readReceipts: false,
          typingIndicators: false,
          discoverableByPhone: false,
          discoverableByUsername: true,
        })}
      )`;

    // An application row so it appears wherever bots are listed. The token is
    // never used — commands arrive in-process — so a placeholder hash is
    // stored rather than a live credential nobody would rotate.
    await tx`
      insert into applications (id, owner_id, bot_user_id, name, description, token_hash, token_prefix)
      values (
        ${randomUUID()}, ${owner.id}, ${botId}, 'yapper',
        'First-party bot. Developer-portal sign-in.',
        ${'unused-first-party-' + randomUUID()}, 'yb_internal'
      )`;
  });

  console.log(`created yapper (${botId}), owned by @${owner.username}`);
} finally {
  await sql.end();
}
