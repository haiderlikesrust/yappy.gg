/**
 * A custom emoji on a group you are already in, for looking at.
 *
 * Points at an image already in storage rather than uploading one — this is
 * for eyeballing the picker and the inline rendering, not for exercising the
 * upload path.
 *
 *   pnpm --filter @yappy/db seed-emoji            # first space you own
 *   YAPPY_SPACE=<id> pnpm --filter @yappy/db seed-emoji
 */
import postgres from 'postgres';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Run via pnpm, which loads .env.');
  process.exit(1);
}
const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });

const target =
  process.env.YAPPY_SPACE ??
  (
    await sql`
      select c.id from conversations c
        join users u on u.id = c.owner_id
       where c.type in ('space', 'group')
         and c.deleted_at is null
         and u.email = 'webclient.test@yappy.gg'
       order by c.created_at desc
       limit 1`
  )[0]?.id;

if (!target) {
  console.error('No space or group found to put an emoji on.');
  process.exit(1);
}

/*
 * Any image that is already in the bucket. An avatar is a good pick: it is
 * square, it is small, and it is certainly there — the point is to have
 * something that renders, not something that looks like a parrot.
 */
const [image] = await sql`
  select id, object_key from media
   where deleted_at is null and object_key like 'avatar/%'
   order by created_at desc limit 1`;
if (!image) {
  console.error('No media rows to point an emoji at.');
  process.exit(1);
}

for (const name of ['party_parrot', 'shipit']) {
  await sql`
    insert into custom_emojis (id, conversation_id, media_id, name, animated)
    values (gen_random_uuid(), ${target}::uuid, ${image.id}::uuid, ${name}, false)
    on conflict do nothing`;
}

const rows = await sql`
  select name from custom_emojis
   where conversation_id = ${target}::uuid and deleted_at is null
   order by name`;

console.log(`conversation ${target}`);
console.log(`emoji: ${rows.map((r) => `:${r.name}:`).join(' ')}`);
console.log('type one into the composer there and send it');

await sql.end();
