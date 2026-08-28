import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().min(1),
  DATABASE_MAX_POOL: z.coerce.number().int().default(10),

  PUBLIC_API_URL: z.string().url().default('http://localhost:3000'),
  S3_PUBLIC_BASE_URL: z.string().url(),

  /**
   * Object storage, for thumbnail generation. Optional with empty defaults —
   * unlike the API, the worker can do its job without S3 (pushes, crons,
   * webhooks all still run); it just skips thumbnails and says so once.
   * The same variables the API reads, so one .env serves both processes.
   */
  S3_ENDPOINT: z.string().default(''),
  S3_REGION: z.string().default('auto'),
  S3_ACCESS_KEY_ID: z.string().default(''),
  S3_SECRET_ACCESS_KEY: z.string().default(''),
  S3_FORCE_PATH_STYLE: z.coerce.boolean().default(false),

  // APNs — token-based auth (a .p8 key), not certificates.
  APNS_KEY_ID: z.string().default(''),
  APNS_TEAM_ID: z.string().default(''),
  APNS_PRIVATE_KEY: z.string().default(''),
  APNS_BUNDLE_ID: z.string().default('gg.yappy.app'),
  APNS_PRODUCTION: z.coerce.boolean().default(false),

  // FCM HTTP v1 — service-account credentials.
  FCM_PROJECT_ID: z.string().default(''),
  FCM_CLIENT_EMAIL: z.string().default(''),

  /**
   * Where verification and password-reset codes go out.
   *
   * `console` logs them, which is development. `smtp` is an ordinary
   * mailbox — the option most domains already have. `resend` is their HTTP
   * API, for anyone who would rather not keep a mailbox password here.
   */
  EMAIL_PROVIDER: z.enum(['console', 'smtp', 'resend']).default('console'),
  EMAIL_FROM: z.string().default(''),

  SMTP_HOST: z.string().default(''),
  /** 465 is TLS from the first byte; 587 upgrades with STARTTLS. */
  SMTP_PORT: z.coerce.number().int().default(465),
  /**
   * True for 465, false for 587.
   *
   * Not `z.coerce.boolean()`, which is `Boolean(string)` and therefore reads
   * "false" as true — a setting that silently does the opposite of what it
   * says, and whose symptom is a TLS handshake against a plaintext port.
   */
  SMTP_SECURE: z
    .string()
    .default('true')
    .transform((v) => !/^(false|0|no|off)$/i.test(v.trim())),
  SMTP_USER: z.string().default(''),
  SMTP_PASSWORD: z.string().default(''),

  RESEND_API_KEY: z.string().default(''),
  FCM_PRIVATE_KEY: z.string().default(''),

  LINK_PREVIEW_TIMEOUT_MS: z.coerce.number().int().default(5_000),
  LINK_PREVIEW_MAX_BYTES: z.coerce.number().int().default(512_000),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('✗ Invalid environment:');
  for (const issue of parsed.error.issues) console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  process.exit(1);
}

export const env = parsed.data;

/** Newlines survive .env round-tripping as literal backslash-n. */
export const normalizeKey = (key: string): string => key.replace(/\\n/g, '\n');
