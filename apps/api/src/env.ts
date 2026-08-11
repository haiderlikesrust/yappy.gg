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

  /**
   * Shared secret for the GitHub webhook behind the staff #gitlog channel.
   * Empty means the endpoint refuses everything, which is the right default:
   * an unauthenticated route that can post a message must be off until someone
   * deliberately turns it on.
   */
  GITHUB_WEBHOOK_SECRET: z.string().default(''),
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

// The one class of misconfiguration worth refusing to boot over: a secret
// that is still its committed placeholder. (The old SMS_PROVIDER=console check
// died with phone sign-in — there are no login codes to leak any more.)
if (isProd) {
  const unsafe: string[] = [];
  if (env.JWT_SECRET.includes('dev_only') || env.JWT_SECRET.includes('CHANGE_ME')) {
    unsafe.push('JWT_SECRET is still a placeholder');
  }
  if (env.LIVEKIT_API_SECRET.includes('change_me') || env.LIVEKIT_API_SECRET.includes('CHANGE_ME')) {
    unsafe.push('LIVEKIT_API_SECRET is still a placeholder');
  }
  if (env.S3_SECRET_ACCESS_KEY.includes('CHANGE_ME') || env.S3_SECRET_ACCESS_KEY === 'yappyyappy') {
    unsafe.push('S3_SECRET_ACCESS_KEY is still a placeholder');
  }
  if (unsafe.length) {
    console.error('✗ Refusing to start in production:');
    for (const u of unsafe) console.error(`  ${u}`);
    process.exit(1);
  }
}

/**
 * Browser origins allowed to call this API.
 *
 * An empty list still means "allow any" — that is the local-development
 * default and `app.ts` depends on it.
 *
 * Once a list *is* given, the site's own origin is folded in automatically
 * from `PUBLIC_WEB_URL` rather than being named a second time in
 * `CORS_ORIGINS`. Pages like `/bug` and `/claim` are part of this product and
 * are served from that exact host; making an operator repeat it is a step
 * somebody forgets, and the way it fails is nasty — the page loads perfectly,
 * looks completely fine, and every request it makes is refused by the browser
 * before it leaves.
 *
 * Other hosts still have to be listed. `www.` is a different origin to the
 * browser even when it redirects, so a deployment serving both needs both.
 */
export const corsOrigins = (() => {
  const listed = env.CORS_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (listed.length === 0) return listed;

  let own: string | null = null;
  try {
    own = new URL(env.PUBLIC_WEB_URL).origin;
  } catch {
    own = null;
  }

  return own && !listed.includes(own) ? [...listed, own] : listed;
})();
