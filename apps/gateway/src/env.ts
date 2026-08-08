import { hostname } from 'node:os';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  GATEWAY_PORT: z.coerce.number().int().default(3001),
  HOST: z.string().default('0.0.0.0'),

  DATABASE_URL: z.string().min(1),
  DATABASE_MAX_POOL: z.coerce.number().int().default(10),

  JWT_SECRET: z.string().min(32),
  JWT_ISSUER: z.string().default('yappy.gg'),

  /** How often a client must heartbeat. Below ~30s mobile radios never sleep. */
  HEARTBEAT_INTERVAL_MS: z.coerce.number().int().default(41_250),
  /** Grace before a silent socket is dropped. */
  HEARTBEAT_TIMEOUT_MS: z.coerce.number().int().default(15_000),
  /** How long a disconnected session stays resumable. */
  SESSION_RESUME_WINDOW_MS: z.coerce.number().int().default(120_000),

  MAX_CONNECTIONS_PER_USER: z.coerce.number().int().default(8),
  /** Client→server frames per second before the socket is closed. */
  MAX_FRAMES_PER_SECOND: z.coerce.number().int().default(30),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('✗ Invalid environment:');
  for (const issue of parsed.error.issues) console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  process.exit(1);
}

export const env = parsed.data;

/**
 * Stable per-process id. Presence rows are tagged with it so a restarting node
 * can sweep the rows its previous incarnation left behind — otherwise a crash
 * leaves users showing as online until their TTL expires.
 */
export const NODE_ID = `${hostname()}:${process.pid}:${Date.now().toString(36)}`;
