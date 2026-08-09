import { createHmac } from 'node:crypto';
import { applications, eq, sql as raw, type Database } from '@yappy/db';
import type pino from 'pino';
import type { Logger } from 'pino';

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

  let res: Response;
  try {
    res = await fetch(application.webhookUrl, {
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
  } catch (err) {
    // A refused connection, a DNS failure or a timeout is a failure like any
    // other. Before this, only an HTTP error status was counted, so a webhook
    // whose host had gone away entirely looked healthy right up until someone
    // asked why their bot had stopped working.
    await recordFailure(db, job.applicationId);
    throw err;
  }

  if (!res.ok) {
    log.warn({ applicationId: job.applicationId, status: res.status }, 'webhook delivery failed');
    await recordFailure(db, job.applicationId);
    throw new Error(`webhook returned ${res.status}`);
  }

  await recordSuccess(db, job.applicationId);
}

export interface WebhookTestJob {
  applicationId: string;
  /** Who asked, and therefore who hears how it went. */
  requestedByUserId: string;
  /** Stable across retries of the *enqueue*, so the answer cannot double up. */
  dedupe: string;
}

/**
 * Send one signed test delivery, on request, and report the outcome back.
 *
 * Runs here rather than in the API for the reason every other outbound request
 * does: the endpoint belongs to someone else, and the process serving user
 * requests should not be the one holding open a socket to it. The cost is that
 * the answer arrives as a follow-up DM instead of as a synchronous reply,
 * which is the right trade — it also means the result comes back through
 * exactly the same delivery path a real event does, so a test that passes is
 * evidence about the real thing rather than about a special case.
 *
 * Never throws: this queue is enqueued with no retries, and a failed *test* is
 * a result to report, not a job to retry.
 */
export async function deliverWebhookTest(
  db: Database,
  log: Logger,
  enqueue: (name: string, data: Record<string, unknown>) => Promise<void>,
  job: WebhookTestJob,
): Promise<void> {
  const [application] = await db
    .select({
      name: applications.name,
      webhookUrl: applications.webhookUrl,
      webhookSecret: applications.webhookSecret,
      revokedAt: applications.revokedAt,
      ownerId: applications.ownerId,
    })
    .from(applications)
    .where(eq(applications.id, job.applicationId))
    .limit(1);

  // Re-checked here, not just where the test was requested: the owner could
  // have cleared the webhook or revoked the bot between asking and now.
  if (!application || application.revokedAt || application.ownerId !== job.requestedByUserId) return;

  const name = application.name;

  if (!application.webhookUrl || !application.webhookSecret) {
    await report(false, 'No webhook is set for this bot');
    return;
  }

  const body = JSON.stringify({
    type: 'webhook.test',
    data: { applicationId: job.applicationId, requestedBy: job.requestedByUserId },
    sentAt: new Date().toISOString(),
  });
  const signature = createHmac('sha256', application.webhookSecret).update(body).digest('hex');

  const startedAt = Date.now();
  try {
    const res = await fetch(application.webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-yappy-signature': signature,
        'user-agent': 'yappy-webhooks/1.0',
      },
      body,
      signal: AbortSignal.timeout(5_000),
    });
    const ms = Date.now() - startedAt;
    await report(res.ok, `HTTP ${res.status} in ${ms} ms`);
  } catch (err) {
    // The message, not the object: this is going into a chat card, and the
    // useful half of a fetch failure is "timed out" or "ECONNREFUSED".
    const reason = err instanceof Error ? err.message : 'could not connect';
    log.info({ applicationId: job.applicationId, reason }, 'webhook test failed');
    await report(false, reason.slice(0, 200));
  }

  async function report(ok: boolean, detail: string): Promise<void> {
    await enqueue('yapper.dm', {
      userId: job.requestedByUserId,
      kind: 'webhook_test_result',
      dedupe: job.dedupe,
      payload: { name, ok, detail },
    });
  }
}

async function recordFailure(db: Database, applicationId: string): Promise<void> {
  // Never allowed to mask the delivery failure it is recording.
  try {
    await db
      .update(applications)
      .set({
        webhookFailureCount: raw`${applications.webhookFailureCount} + 1`,
        webhookLastFailureAt: new Date(),
      })
      .where(eq(applications.id, applicationId));
  } catch {
    /* health bookkeeping is not worth failing a job over */
  }
}

/**
 * Note a success — but only when there is something to note.
 *
 * A busy bot receives every message in every conversation it is in, and an
 * unconditional `UPDATE` here would mean a row write per delivered event
 * purely to restamp a timestamp nobody reads at that resolution. The `WHERE`
 * makes the common case an index probe that matches nothing: the row is
 * touched when it is recovering from a failure, or when the last recorded
 * success has gone stale by an hour.
 */
async function recordSuccess(db: Database, applicationId: string): Promise<void> {
  try {
    await db.execute(raw`
      update applications
         set webhook_failure_count = 0,
             webhook_last_success_at = now()
       where id = ${applicationId}::uuid
         and (webhook_failure_count > 0
              or webhook_last_success_at is null
              or webhook_last_success_at < now() - interval '1 hour')
    `);
  } catch {
    /* as above */
  }
}
