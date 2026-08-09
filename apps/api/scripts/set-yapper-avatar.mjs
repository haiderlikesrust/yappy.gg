/**
 * Give yapper the app icon as its avatar.
 *
 *   node --env-file=../../.env scripts/set-yapper-avatar.mjs
 *
 * Idempotent: the object key is derived from the file's own hash, so running
 * it twice overwrites the same object and reuses the same media row.
 *
 * Kept as a script rather than folded into create-yapper because the icon is
 * a build artefact that changes on its own schedule — re-running this after a
 * rebrand should not mean recreating the bot.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import postgres from 'postgres';

const here = dirname(fileURLToPath(import.meta.url));
const ICON = join(here, '../../../web/icon.png');
const ICON_PX = 432;

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Run with --env-file=../../.env');
  process.exit(1);
}

const bytes = readFileSync(ICON);
const hash = createHash('sha256').update(bytes).digest('hex');
// Avatars live in the public bucket: they are shown to anyone who can see the
// bot, so a signed URL would be ceremony with no reader excluded.
const objectKey = `avatars/yapper-${hash.slice(0, 16)}.png`;

const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION ?? 'auto',
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
});

const sql = postgres(url, { max: 1 });

try {
  const [bot] = await sql`
    select id from users where username = 'yapper' and is_bot and deleted_at is null`;
  if (!bot) {
    console.error('yapper does not exist. Run create-yapper.mjs first.');
    process.exit(1);
  }

  await s3.send(
    new PutObjectCommand({
      Bucket: process.env.S3_BUCKET_PUBLIC,
      Key: objectKey,
      Body: bytes,
      ContentType: 'image/png',
      CacheControl: 'public, max-age=31536000, immutable',
    }),
  );

  const [existing] = await sql`
    select id from media where object_key = ${objectKey} limit 1`;

  const mediaId = existing?.id ?? randomUUID();
  if (!existing) {
    // `confirmed_at` matters: unconfirmed uploads are what the sweeper
    // collects, and an avatar swept out from under the bot would leave a
    // broken image with no obvious cause.
    await sql`
      insert into media (id, owner_id, purpose, status, bucket, object_key,
                         mime_type, size, width, height, checksum,
                         confirmed_at, ref_count)
      values (${mediaId}, ${bot.id}, 'avatar', 'ready',
              ${process.env.S3_BUCKET_PUBLIC}, ${objectKey},
              'image/png', ${bytes.length}, ${ICON_PX}, ${ICON_PX}, ${hash},
              now(), 1)`;
  }

  await sql`update users set avatar_media_id = ${mediaId} where id = ${bot.id}`;
  console.log(`yapper avatar set → ${objectKey}`);
} finally {
  await sql.end();
}
