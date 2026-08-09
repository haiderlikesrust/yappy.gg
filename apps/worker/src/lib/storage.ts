import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { env } from '../env.js';

/**
 * Just enough S3 for the media job: read an original, write a derivative.
 *
 * The API owns presigning, buckets and lifecycle; this deliberately knows none
 * of that. It exists because thumbnailing has to happen *somewhere*, the API
 * process must not spend its request threads on image decoding, and the worker
 * already is the place where deferred work lives.
 */

const configured = Boolean(env.S3_ENDPOINT && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY);

let client: S3Client | null = null;

/** Null when the worker was started without S3 credentials. */
function s3(): S3Client | null {
  if (!configured) return null;
  client ??= new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    },
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
  });
  return client;
}

export const storageConfigured = configured;

export async function getObjectBytes(bucket: string, key: string): Promise<Buffer | null> {
  const c = s3();
  if (!c) return null;
  const result = await c.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const bytes = await result.Body?.transformToByteArray();
  return bytes ? Buffer.from(bytes) : null;
}

export async function putObject(
  bucket: string,
  key: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  const c = s3();
  if (!c) throw new Error('S3 is not configured');
  await c.send(
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
  );
}
