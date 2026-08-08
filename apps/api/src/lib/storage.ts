import { randomBytes } from 'node:crypto';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../env.js';

/**
 * Object storage.
 *
 * Uploads are **presigned direct-to-S3**, never proxied through this process.
 * A 100 MB video going through Node would occupy a worker for the duration of
 * the upload and multiply egress cost; the client PUTs straight to the bucket
 * and then confirms.
 *
 * MinIO locally, R2 or S3 in production — identical code path, so the local
 * environment actually exercises the presign flow rather than a shortcut.
 */

const ALLOWED_MIME: Record<string, { ext: string; maxBytes: number }> = {
  'image/jpeg': { ext: 'jpg', maxBytes: 25_000_000 },
  'image/png': { ext: 'png', maxBytes: 25_000_000 },
  'image/webp': { ext: 'webp', maxBytes: 25_000_000 },
  'image/gif': { ext: 'gif', maxBytes: 50_000_000 },
  'image/heic': { ext: 'heic', maxBytes: 40_000_000 },
  'video/mp4': { ext: 'mp4', maxBytes: 500_000_000 },
  'video/quicktime': { ext: 'mov', maxBytes: 500_000_000 },
  'video/webm': { ext: 'webm', maxBytes: 500_000_000 },
  'audio/mpeg': { ext: 'mp3', maxBytes: 50_000_000 },
  'audio/mp4': { ext: 'm4a', maxBytes: 50_000_000 },
  'audio/aac': { ext: 'aac', maxBytes: 50_000_000 },
  'audio/ogg': { ext: 'ogg', maxBytes: 50_000_000 },
  // Voice notes: Opus in an ogg/webm container.
  'audio/opus': { ext: 'opus', maxBytes: 25_000_000 },
  'audio/webm': { ext: 'weba', maxBytes: 25_000_000 },
  'application/pdf': { ext: 'pdf', maxBytes: 100_000_000 },
  'application/zip': { ext: 'zip', maxBytes: 200_000_000 },
  'text/plain': { ext: 'txt', maxBytes: 10_000_000 },
  'application/octet-stream': { ext: 'bin', maxBytes: 200_000_000 },
};

export interface PresignResult {
  uploadUrl: string;
  objectKey: string;
  bucket: string;
  /** Headers the client MUST send with the PUT, or the signature will not match. */
  headers: Record<string, string>;
  expiresIn: number;
}

export class Storage {
  private readonly client: S3Client;
  /**
   * A second client that differs only in endpoint, used solely to build
   * presigned URLs. SigV4 signs the Host header, so a URL signed against the
   * endpoint *we* talk to is invalid for a client that reaches the bucket by a
   * different name — an emulator, a phone on the LAN, or in production an
   * internal VPC endpoint versus the public one.
   */
  private readonly presigner: S3Client;

  constructor() {
    const credentials = {
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    };

    this.client = new S3Client({
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      credentials,
    });

    this.presigner = env.S3_PUBLIC_ENDPOINT
      ? new S3Client({
          region: env.S3_REGION,
          endpoint: env.S3_PUBLIC_ENDPOINT,
          forcePathStyle: env.S3_FORCE_PATH_STYLE,
          credentials,
        })
      : this.client;
  }

  static validate(mimeType: string, size: number): { ok: true; ext: string } | { ok: false; reason: string } {
    const rule = ALLOWED_MIME[mimeType];
    if (!rule) return { ok: false, reason: `Unsupported type: ${mimeType}` };
    if (size > Math.min(rule.maxBytes, env.MEDIA_MAX_UPLOAD_BYTES)) {
      return { ok: false, reason: 'File is too large' };
    }
    return { ok: true, ext: rule.ext };
  }

  /**
   * Keys are sharded by date and randomised. Sequential or guessable keys turn
   * a public bucket into an enumerable archive of everyone's photos.
   */
  static buildKey(purpose: string, ownerId: string, ext: string): string {
    const now = new Date();
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(now.getUTCDate()).padStart(2, '0');
    const rand = randomBytes(16).toString('hex');
    return `${purpose}/${yyyy}/${mm}/${dd}/${ownerId.slice(0, 8)}/${rand}.${ext}`;
  }

  /** Avatars and stickers are public; message attachments are not. */
  static bucketFor(purpose: string): string {
    return purpose === 'avatar' || purpose === 'conversation_avatar' || purpose === 'sticker' || purpose === 'banner'
      ? env.S3_BUCKET_PUBLIC
      : env.S3_BUCKET_MEDIA;
  }

  async presignUpload(params: {
    purpose: string;
    ownerId: string;
    mimeType: string;
    size: number;
    checksum?: string | null;
  }): Promise<PresignResult> {
    const validated = Storage.validate(params.mimeType, params.size);
    if (!validated.ok) throw new Error(validated.reason);

    const bucket = Storage.bucketFor(params.purpose);
    const objectKey = Storage.buildKey(params.purpose, params.ownerId, validated.ext);

    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: objectKey,
      ContentType: params.mimeType,
      ContentLength: params.size,
      // Binding the length and type into the signature stops a client from
      // presigning a 1 KB avatar and uploading a 2 GB file.
      ...(params.checksum ? { ChecksumSHA256: Buffer.from(params.checksum, 'hex').toString('base64') } : {}),
    });

    const uploadUrl = await getSignedUrl(this.presigner, command, { expiresIn: 900 });

    return {
      uploadUrl,
      objectKey,
      bucket,
      headers: {
        'Content-Type': params.mimeType,
        'Content-Length': String(params.size),
        ...(params.checksum
          ? { 'x-amz-checksum-sha256': Buffer.from(params.checksum, 'hex').toString('base64') }
          : {}),
      },
      expiresIn: 900,
    };
  }

  /**
   * Stream an object back out.
   *
   * Downloads of *private* media are proxied (see the `/media/:id/content`
   * route) because access has to be authorised per viewer, and a bucket cannot
   * evaluate "is this person in that conversation". Uploads stay presigned —
   * that is the expensive direction. In production this route is the seam where
   * a signed-CDN URL replaces the proxy.
   */
  async getObject(
    bucket: string,
    key: string,
  ): Promise<{ body: NodeJS.ReadableStream; contentType: string; contentLength?: number } | null> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!res.Body) return null;
      return {
        body: res.Body as NodeJS.ReadableStream,
        contentType: res.ContentType ?? 'application/octet-stream',
        contentLength: res.ContentLength,
      };
    } catch {
      return null;
    }
  }

  /** Verify the object actually landed, and that its size matches the claim. */
  async head(bucket: string, key: string): Promise<{ size: number; mimeType: string } | null> {
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return { size: res.ContentLength ?? 0, mimeType: res.ContentType ?? 'application/octet-stream' };
    } catch {
      return null;
    }
  }

  async delete(bucket: string, key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })).catch(() => {});
  }
}
