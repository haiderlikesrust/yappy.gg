/**
 * Creates the two buckets the app expects, mirroring what `minio-init` does in
 * docker-compose: a private bucket for message attachments and a public one for
 * avatars, banners and stickers.
 *
 *   node scripts/init-buckets.mjs
 */
import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketPolicyCommand,
  S3Client,
} from '@aws-sdk/client-s3';

const endpoint = process.env.S3_ENDPOINT ?? 'http://localhost:9000';
const media = process.env.S3_BUCKET_MEDIA ?? 'yappy-media';
const publicBucket = process.env.S3_BUCKET_PUBLIC ?? 'yappy-public';

const client = new S3Client({
  region: process.env.S3_REGION ?? 'auto',
  endpoint,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? 'yappy',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? 'yappy_dev_secret',
  },
});

async function ensure(bucket) {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    console.log(`exists   ${bucket}`);
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    console.log(`created  ${bucket}`);
  }
}

await ensure(media);
await ensure(publicBucket);

// Avatars and stickers are fetched by the client directly; attachments are not
// and must stay private — they are served through the API's authorised route.
await client.send(
  new PutBucketPolicyCommand({
    Bucket: publicBucket,
    Policy: JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: { AWS: ['*'] },
          Action: ['s3:GetObject'],
          Resource: [`arn:aws:s3:::${publicBucket}/*`],
        },
      ],
    }),
  }),
);
console.log(`policy   ${publicBucket} → anonymous read`);
console.log(`\n${media} stays private (served via /v1/media/:id/content)`);
