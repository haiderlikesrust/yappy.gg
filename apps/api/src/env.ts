import { z } from 'zod';

/**
 * Fail fast on boot rather than at 3am on the one code path that reads a
 * missing variable. Anything with a production-unsafe default is checked
 * explicitly below.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  API_PORT: z.coerce.number().int().default(3000),
  HOST: z.string().default('0.0.0.0'),

  PUBLIC_API_URL: z.string().url().default('http://localhost:3000'),
  PUBLIC_GATEWAY_URL: z.string().default('ws://localhost:3001'),
  PUBLIC_WEB_URL: z.string().url().default('http://localhost:5173'),
  CORS_ORIGINS: z.string().default(''),

  DATABASE_URL: z.string().min(1),
  DATABASE_MAX_POOL: z.coerce.number().int().default(20),

  JWT_SECRET: z.string().min(32),
  JWT_ISSUER: z.string().default('yappy.gg'),
  ACCESS_TOKEN_TTL: z.coerce.number().int().default(900),
  REFRESH_TOKEN_TTL: z.coerce.number().int().default(5_184_000),
  OTP_TTL: z.coerce.number().int().default(300),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().default(5),

  APPLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_IDS: z.string().default(''),

  S3_ENDPOINT: z.string().optional(),
  /**
   * The endpoint clients should be sent to, when it differs from the one this
   * process uses. Presigned URLs sign the Host header, so the URL has to be
   * built against the name the *client* will resolve — a server on an internal
   * address cannot simply hand out its own hostname. Defaults to S3_ENDPOINT.
   */
  S3_PUBLIC_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('auto'),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_BUCKET_MEDIA: z.string().min(1),
  S3_BUCKET_PUBLIC: z.string().min(1),
  S3_FORCE_PATH_STYLE: z.coerce.boolean().default(false),
  S3_PUBLIC_BASE_URL: z.string().url(),
  MEDIA_MAX_UPLOAD_BYTES: z.coerce.number().int().default(104_857_600),

  LIVEKIT_URL: z.string().min(1),
  LIVEKIT_API_KEY: z.string().min(1),
  LIVEKIT_API_SECRET: z.string().min(1),
  CALL_RING_TIMEOUT_SECONDS: z.coerce.number().int().default(45),
  CALL_MAX_PARTICIPANTS: z.coerce.number().int().default(32),

  GIF_PROVIDER: z.enum(['tenor', 'giphy']).default('tenor'),
  TENOR_API_KEY: z.string().default(''),
  GIPHY_API_KEY: z.string().default(''),

  SMS_PROVIDER: z.enum(['console', 'twilio']).default('console'),
  TWILIO_ACCOUNT_SID: z.string().default(''),
  TWILIO_AUTH_TOKEN: z.string().default(''),
  TWILIO_FROM: z.string().default(''),
  EMAIL_PROVIDER: z.enum(['console', 'resend']).default('console'),
  RESEND_API_KEY: z.string().default(''),
  EMAIL_FROM: z.string().default('no-reply@yappy.gg'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error('✗ Invalid environment:');
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;

export const isProd = env.NODE_ENV === 'production';

if (isProd) {
  const unsafe: string[] = [];
  if (env.JWT_SECRET.includes('dev_only')) unsafe.push('JWT_SECRET is still the development value');
  if (env.LIVEKIT_API_SECRET.includes('change_me')) unsafe.push('LIVEKIT_API_SECRET is still the default');
  if (env.SMS_PROVIDER === 'console') unsafe.push('SMS_PROVIDER=console will print login codes to stdout');
  if (unsafe.length) {
    console.error('✗ Refusing to start in production:');
    for (const u of unsafe) console.error(`  ${u}`);
    process.exit(1);
  }
}

export const corsOrigins = env.CORS_ORIGINS.split(',')
  .map((s) => s.trim())
  .filter(Boolean);
