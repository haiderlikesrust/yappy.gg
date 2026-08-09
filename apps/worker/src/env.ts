import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().min(1),
  DATABASE_MAX_POOL: z.coerce.number().int().default(10),

  PUBLIC_API_URL: z.string().url().default('http://localhost:3000'),
  S3_PUBLIC_BASE_URL: z.string().url(),

  // APNs — token-based auth (a .p8 key), not certificates.
  APNS_KEY_ID: z.string().default(''),
  APNS_TEAM_ID: z.string().default(''),
  APNS_PRIVATE_KEY: z.string().default(''),
  APNS_BUNDLE_ID: z.string().default('gg.yappy.app'),
  APNS_PRODUCTION: z.coerce.boolean().default(false),

  // FCM HTTP v1 — service-account credentials.
  FCM_PROJECT_ID: z.string().default(''),
  FCM_CLIENT_EMAIL: z.string().default(''),
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
