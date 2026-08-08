import { newId } from '@yappy/shared';
import { createDb } from './index.js';
import {
  conversationMembers,
  conversations,
  follows,
  messages,
  users,
} from './schema/index.js';
import { sql } from 'drizzle-orm';

/**
 * Development seed.
 *
 * Creates a small cast of users who all follow each other (so the default
 * `contacts` privacy audiences pass), one group, one DM, and enough message
 * history to make the conversation list and the chat screen look real while
 * building the client.
 *
 * Safe to re-run: every insert is keyed on a stable id and conflicts are
 * ignored. It refuses to run against NODE_ENV=production.
 */

if (process.env.NODE_ENV === 'production') {
  console.error('✗ refusing to seed a production database');
  process.exit(1);
}

/**
 * No hardcoded fallback. A default connection string is convenient exactly once
 * and then quietly migrates or seeds whatever database happens to be listening
 * on localhost — including, on a developer's machine, the wrong one.
 */
function requireDatabaseUrl(): string {
  const value = process.env.DATABASE_URL;
  if (!value) {
    console.error('DATABASE_URL is not set. Run via pnpm (which loads .env) or export it.');
    process.exit(1);
  }
  return value;
}

const url = requireDatabaseUrl();
const { db, sql: client } = createDb({ url, max: 4 });

// Fixed ids so re-running updates rather than duplicates, and so the client can
// hard-code a login during development.
const PEOPLE = [
  { id: '00000000-0000-7000-8000-000000000001', username: 'ada', name: 'Ada Lovelace', phone: '+15550000001' },
  { id: '00000000-0000-7000-8000-000000000002', username: 'grace', name: 'Grace Hopper', phone: '+15550000002' },
  { id: '00000000-0000-7000-8000-000000000003', username: 'alan', name: 'Alan Turing', phone: '+15550000003' },
  { id: '00000000-0000-7000-8000-000000000004', username: 'katherine', name: 'Katherine Johnson', phone: '+15550000004' },
];

const GROUP_ID = '00000000-0000-7000-8000-00000000a001';
const DM_ID = '00000000-0000-7000-8000-00000000a002';

const GROUP_SCRIPT: Array<[number, string]> = [
  [0, 'morning all — standup in 10?'],
  [1, 'on my way, just finishing the migration'],
  [2, 'did we ever decide on the seq allocation? feels like the row lock could bite us'],
  [0, 'it only serialises writers in the same conversation. across conversations it is fully parallel'],
  [2, 'right, that is fine then'],
  [3, 'pushed the presence sweeper — it cleans up after a node that dies without closing sockets'],
  [1, 'nice. that was the one leaving people permanently "online"'],
  [0, 'shipping it 🚀'],
];

async function main() {
  console.log('→ users');
  for (const p of PEOPLE) {
    await db
      .insert(users)
      .values({
        id: p.id,
        username: p.username,
        displayName: p.name,
        phone: p.phone,
        phoneVerifiedAt: new Date(),
        bio: 'Seeded account for local development.',
        presenceStatus: 'offline',
      })
      .onConflictDoNothing();
  }

  console.log('→ follows (everyone mutual, so `contacts` audiences pass)');
  for (const a of PEOPLE) {
    for (const b of PEOPLE) {
      if (a.id === b.id) continue;
      await db.insert(follows).values({ followerId: a.id, followeeId: b.id }).onConflictDoNothing();
    }
  }

  console.log('→ group conversation');
  await db
    .insert(conversations)
    .values({
      id: GROUP_ID,
      type: 'group',
      title: 'Backend crew',
      description: 'Seeded group for local development',
      ownerId: PEOPLE[0]!.id,
      createdById: PEOPLE[0]!.id,
    })
    .onConflictDoNothing();

  for (const [i, p] of PEOPLE.entries()) {
    await db
      .insert(conversationMembers)
      .values({ conversationId: GROUP_ID, userId: p.id, role: i === 0 ? 'owner' : 'member' })
      .onConflictDoNothing();
  }

  console.log('→ direct message');
  const [a, b] = [PEOPLE[0]!, PEOPLE[1]!];
  const dmKey = a.id < b.id ? `${a.id}:${b.id}` : `${b.id}:${a.id}`;
  await db
    .insert(conversations)
    .values({ id: DM_ID, type: 'dm', dmKey, createdById: a.id })
    .onConflictDoNothing();
  for (const p of [a, b]) {
    await db
      .insert(conversationMembers)
      .values({ conversationId: DM_ID, userId: p.id })
      .onConflictDoNothing();
  }

  console.log('→ messages');
  // Skip if already seeded — `seq` is allocated by the database and re-running
  // would append a duplicate transcript.
  const existing = await db.execute(
    sql`select count(*)::int as n from messages where conversation_id = ${GROUP_ID}::uuid`,
  );
  const already = (existing as unknown as Array<{ n: number }>)[0]?.n ?? 0;

  if (already === 0) {
    const base = Date.now() - GROUP_SCRIPT.length * 90_000;
    for (const [i, [who, text]] of GROUP_SCRIPT.entries()) {
      const seqRow = (await db.execute(
        sql`select allocate_message_seq(${GROUP_ID}::uuid) as seq`,
      )) as unknown as Array<{ seq: string | number }>;
      const createdAt = new Date(base + i * 90_000);
      await db.insert(messages).values({
        id: newId(),
        conversationId: GROUP_ID,
        seq: Number(seqRow[0]!.seq),
        senderId: PEOPLE[who]!.id,
        type: 'text',
        content: text,
        createdAt,
        updatedAt: createdAt,
      });
    }

    const seqRow = (await db.execute(
      sql`select allocate_message_seq(${DM_ID}::uuid) as seq`,
    )) as unknown as Array<{ seq: string | number }>;
    await db.insert(messages).values({
      id: newId(),
      conversationId: DM_ID,
      seq: Number(seqRow[0]!.seq),
      senderId: b.id,
      type: 'text',
      content: 'hey — got a minute to look at the gateway resume path?',
    });

    // Refresh the denormalised list-screen fields the triggers do not own.
    await db.execute(sql`
      update conversations c
         set last_message_id = m.id,
             last_message_at = m.created_at,
             last_message_sender_id = m.sender_id,
             last_message_preview = left(m.content, 160)
        from (
          select distinct on (conversation_id) id, conversation_id, created_at, sender_id, content
            from messages order by conversation_id, seq desc
        ) m
       where c.id = m.conversation_id
    `);
  } else {
    console.log(`  (skipped — ${already} messages already present)`);
  }

  console.log('\n✓ seeded');
  console.log('  Sign in with any of these numbers; the code prints in the worker log:');
  for (const p of PEOPLE) console.log(`    ${p.phone}  @${p.username}`);
}

main()
  .catch((err) => {
    console.error('✗ seed failed');
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => client.end({ timeout: 5 }));
