import { createHmac } from 'node:crypto';
import { applications, eq, type Database } from '@yappy/db';
import type pino from 'pino';

export interface BotEventJob {
  applicationId: string;
  type: string;
  data: unknown;
}

/**
 * Deliver one event to a bot's webhook.
 *
 * The signature is HMAC-SHA256 of the exact raw body, hex, in
 * `X-Yappy-Signature`. Bots MUST verify it before trusting anything in the
 * payload — a webhook URL leaks eventually (logs, config repos, screen
 * shares), and an unverified endpoint then accepts fabricated "the admin
 * pressed approve" events from anyone.
 *
 * Failures throw, which hands the retry to pg-boss (5 attempts, exponential
 * backoff — set at enqueue time). The webhook config is re-read per attempt,
 * so rotating a leaked URL takes effect on the next retry, not the next
 * event.
 */
export async function deliverBotEvent(
  db: Database,
  log: pino.Logger,
  job: BotEventJob,
): Promise<void> {
  const [application] = await db
    .select({
      webhookUrl: applications.webhookUrl,
      webhookSecret: applications.webhookSecret,
      revokedAt: applications.revokedAt,
    })
    .from(applications)
    .where(eq(applications.id, job.applicationId))
    .limit(1);

  // Cleared, rotated away, or the bot is gone: the event dies quietly. This
  // is the correct outcome, not an error — the owner said stop.
  if (!application?.webhookUrl || !application.webhookSecret || application.revokedAt) return;

  const body = JSON.stringify({
    type: job.type,
    data: job.data,
    sentAt: new Date().toISOString(),
  });

  const signature = createHmac('sha256', application.webhookSecret).update(body).digest('hex');

  const res = await fetch(application.webhookUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-yappy-signature': signature,
      'user-agent': 'yappy-webhooks/1.0',
    },
    body,
    // A webhook that takes longer than this is down as far as we care; the
    // retry will find out if it recovered.
    signal: AbortSignal.timeout(5_000),
  });

  if (!res.ok) {
    log.warn({ applicationId: job.applicationId, status: res.status }, 'webhook delivery failed');
    throw new Error(`webhook returned ${res.status}`);
  }
}
