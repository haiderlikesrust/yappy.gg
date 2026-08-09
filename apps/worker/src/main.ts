import PgBoss from 'pg-boss';
import pino from 'pino';
import { createDb } from '@yappy/db';
import { QUEUES } from '@yappy/shared';
import { env } from './env.js';
import { ApnsClient } from './lib/apns.js';
import { FcmClient } from './lib/fcm.js';
import { handleRingTimeout, reconcileStaleCalls } from './jobs/calls.js';
import { fetchLinkPreview } from './jobs/links.js';
import { processMedia, quarantineMedia } from './jobs/media.js';
import {
  closeExpiredPolls,
  expireInvitesAndBans,
  purgeAccount,
  releaseUnusedMedia,
  sendScheduledMessages,
  sweepEphemeral,
  sweepExpiredMessages,
  sweepOrphanUploads,
  sweepPresence,
} from './jobs/maintenance.js';
import { deliverPending, handleCallPush, handleMessageFanout, handleReactionPush } from './jobs/push.js';
import { deliverBotEvent } from './jobs/botwebhook.js';

/**
 * Background worker.
 *
 * Everything that must not happen inside a user-facing request lives here:
 * push fan-out, media processing, link scraping, sweepers, and the timers the
 * call state machine depends on.
 *
 * pg-boss provides the queue on top of the same Postgres — no Redis, no
 * separate broker to operate. It gives us retries with backoff, scheduled and
 * cron jobs, and singleton semantics, which covers everything needed here.
 */

const log = pino({
  level: env.LOG_LEVEL,
  ...(env.NODE_ENV === 'production'
    ? {}
    : { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } }),
});

const { db, sql } = createDb({ url: env.DATABASE_URL, max: env.DATABASE_MAX_POOL });

const boss = new PgBoss({
  connectionString: env.DATABASE_URL,
  schema: 'pgboss',
  max: env.DATABASE_MAX_POOL,
  // Poll a little more eagerly than the default: push latency is user-visible.
  pollingIntervalSeconds: 1,
});

boss.on('error', (err) => log.error({ err }, 'pg-boss error'));

const apns = new ApnsClient();
const fcm = new FcmClient();
const pushDeps = { db, apns, fcm, log };

const enqueue = async (name: string, data: Record<string, unknown>) => {
  await boss.send(name, data, { retryLimit: 5, retryBackoff: true });
};

async function main() {
  await boss.start();

  // pg-boss v10 will not accept a send, work or schedule for a queue it does
  // not know about. Creating them all up front is idempotent and removes the
  // start-order dependency between this process and the API.
  for (const queue of QUEUES) {
    await boss.createQueue(queue);
  }

  if (!apns.configured) log.warn('APNs is not configured — iOS pushes will not be delivered');
  if (!fcm.configured) log.warn('FCM is not configured — Android pushes will not be delivered');

  // ── Event-driven jobs ─────────────────────────────────────────────────────

  await boss.work<{ messageId: string; conversationId: string; senderId: string; seq: number; silent: boolean; mentionIds: string[] }>(
    'push.fanout',
    { batchSize: 10 },
    async (jobs) => {
      for (const job of jobs) await handleMessageFanout(pushDeps, job.data);
    },
  );

  await boss.work<{ callId: string; userIds: string[]; mode: string }>('push.call', async (jobs) => {
    for (const job of jobs) await handleCallPush(pushDeps, job.data);
  });

  await boss.work<{ messageId: string; actorId: string; emoji: string }>('push.reaction', async (jobs) => {
    for (const job of jobs) await handleReactionPush(pushDeps, job.data);
  });

  await boss.work<{ mediaId: string }>('media.process', async (jobs) => {
    for (const job of jobs) await processMedia({ db, log }, job.data);
  });

  await boss.work<{ mediaId: string; labels: Record<string, number> }>('media.quarantine', async (jobs) => {
    for (const job of jobs) await quarantineMedia({ db, log }, job.data);
  });

  await boss.work<{ messageId: string; conversationId: string; urls: string[] }>(
    'link.preview',
    { batchSize: 5 },
    async (jobs) => {
      for (const job of jobs) await fetchLinkPreview(db, log, job.data);
    },
  );

  await boss.work<import('./jobs/botwebhook.js').BotEventJob>('bot.event', async (jobs) => {
    // One at a time, and a throw surfaces to pg-boss for the retry/backoff
    // set at enqueue. Batching would tie unrelated bots' fates together.
    for (const job of jobs) await deliverBotEvent(db, log, job.data);
  });

  await boss.work<{ callId: string }>('call.ring_timeout', async (jobs) => {
    for (const job of jobs) await handleRingTimeout(db, log, job.data);
  });

  await boss.work<{ userId: string }>('account.purge', async (jobs) => {
    for (const job of jobs) await purgeAccount(db, log, job.data.userId);
  });

  await boss.work<{ reportId: string; reason: string }>('moderation.triage', async (jobs) => {
    for (const job of jobs) {
      // Hook for an automated classifier. Until one exists, high-severity
      // reports are simply logged loudly so they are not silently queued.
      if (job.data.reason === 'csam' || job.data.reason === 'self_harm') {
        log.error({ reportId: job.data.reportId, reason: job.data.reason }, 'HIGH PRIORITY REPORT');
      }
    }
  });

  // ── Cron ──────────────────────────────────────────────────────────────────
  // `singletonKey` keeps a job from running on two worker replicas at once.

  await boss.schedule('cron.push_drain', '* * * * *');
  await boss.schedule('cron.sweep_fast', '* * * * *');
  await boss.schedule('cron.sweep_slow', '*/15 * * * *');
  await boss.schedule('cron.hourly', '0 * * * *');

  await boss.work('cron.push_drain', async () => {
    // Drain in a loop so a burst does not wait a whole minute for the next tick.
    let total = 0;
    for (let i = 0; i < 10; i++) {
      const sent = await deliverPending(pushDeps, 200);
      total += sent;
      if (sent === 0) break;
    }
    if (total > 0) log.debug({ total }, 'push drained');
  });

  await boss.work('cron.sweep_fast', async () => {
    await sweepExpiredMessages(db, log);
    await sweepPresence(db, log);
    await closeExpiredPolls(db, log);
    await sendScheduledMessages(db, log, enqueue);
  });

  await boss.work('cron.sweep_slow', async () => {
    await sweepEphemeral(db, log);
    await expireInvitesAndBans(db, log);
    await reconcileStaleCalls(db, log);
  });

  await boss.work('cron.hourly', async () => {
    await sweepOrphanUploads(db, log);
    await releaseUnusedMedia(db, log);
  });

  log.info('worker ready');
}

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'worker shutting down');
  // Graceful: let in-flight jobs finish rather than leaving them to time out
  // and retry, which would double-send pushes.
  await boss.stop({ graceful: true, timeout: 20_000 }).catch(() => {});
  apns.close();
  await sql.end({ timeout: 5 }).catch(() => {});
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

main().catch((err) => {
  log.fatal({ err }, 'worker failed to start');
  process.exit(1);
});
