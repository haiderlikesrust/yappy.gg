/**
 * Create (or repair) the Yappy Staff space.
 *
 *   node --env-file=../../.env scripts/ensure-staff-space.mjs
 *
 * Builds the space the team lives in:
 *
 *   Yappy Staff            (space,   system_key = staff_space)
 *     #general             (channel, system_key = staff_general)
 *     #reports             (channel, system_key = staff_reports)
 *
 * and makes sure every `is_staff` account — plus yapper — is a member.
 * Idempotent: run it after every `grant-staff` if you like, or never again;
 * it converges on the same state.
 *
 * yapper is deliberately a member here and nowhere else. Its privacy settings
 * refuse every group add, so this direct insert is the single exception, made
 * at the database rather than through the API on purpose: the API path is for
 * users, and users must not be able to do this.
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
  const [yapper] = await sql`
    select id from users where username = 'yapper' and is_bot and deleted_at is null`;
  if (!yapper) {
    console.error('yapper does not exist yet — run create-yapper.mjs first.');
    process.exit(1);
  }

  const staff = await sql`
    select id, username from users where is_staff and deleted_at is null`;
  if (staff.length === 0) {
    console.error('Nobody is staff yet — run grant-staff.mjs <username> first.');
    process.exit(1);
  }

  // The first staff member owns the space. Ownership here is a formality —
  // every staff member gets the admin role below.
  const owner = staff[0];

  const ensureConversation = async (tx, key, values) => {
    const [existing] = await tx`
      select id from conversations where system_key = ${key}`;
    if (existing) return existing.id;
    const id = randomUUID();
    await tx`
      insert into conversations ${tx({ id, system_key: key, ...values })}`;
    console.log(`created ${key} (${id})`);
    return id;
  };

  await sql.begin(async (tx) => {
    const spaceId = await ensureConversation(tx, 'staff_space', {
      type: 'space',
      title: 'Yappy Staff',
      description: 'The team. Reports land in #reports.',
      owner_id: owner.id,
      created_by_id: owner.id,
    });

    await ensureConversation(tx, 'staff_general', {
      type: 'channel',
      parent_id: spaceId,
      title: 'general',
      position: 0,
      owner_id: owner.id,
      created_by_id: owner.id,
    });

    await ensureConversation(tx, 'staff_reports', {
      type: 'channel',
      parent_id: spaceId,
      title: 'reports',
      description: 'Every report, as a card, with the actions on it.',
      position: 1,
      owner_id: owner.id,
      created_by_id: owner.id,
    });

    // Membership converges: staff who are not members join, with the owner as
    // owner and everyone else admin. A member who lost staff keeps their seat
    // until grant-staff --revoke removes it — quietly unseating someone is a
    // human decision, not a sync artefact.
    for (const person of staff) {
      await tx`
        insert into conversation_members (conversation_id, user_id, role)
        values (${spaceId}, ${person.id}, ${person.id === owner.id ? 'owner' : 'admin'})
        on conflict (conversation_id, user_id)
        do update set left_at = null`;
    }

    await tx`
      insert into conversation_members (conversation_id, user_id, role)
      values (${spaceId}, ${yapper.id}, 'member')
      on conflict (conversation_id, user_id)
      do update set left_at = null`;
  });

  console.log(`staff space ready — ${staff.length} staff + yapper`);
  console.log('Restart the API if it was already running: it caches the channel ids.');
} finally {
  await sql.end();
}
