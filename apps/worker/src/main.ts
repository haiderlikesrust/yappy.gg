import PgBoss from 'pg-boss';
import pino from 'pino';
import { createDb } from '@yappy/db';
import { CAMPFIRE_WARNING_SECONDS, QUEUES } from '@yappy/shared';
import { env } from './env.js';
import { ApnsClient } from './lib/apns.js';
import { FcmClient } from './lib/fcm.js';
import { handleRingTimeout, reconcileStaleCalls } from './jobs/calls.js';
import { fetchLinkPreview } from './jobs/links.js';
import { tendGroupPets } from './jobs/pets.js';
import { fanOutAnnouncement } from './jobs/announce.js';
import { backfillThumbnails, processMedia, quarantineMedia } from './jobs/media.js';
import {
  closeExpiredPolls,
  expireInvitesAndBans,
  purgeAccount,
  releaseUnusedMedia,
  sendScheduledMessages,
  sweepCampfires,
  sweepLiveLocations,
  sweepEphemeral,
  sweepExpiredCustomStatus,
  sweepExpiredMessages,
  sweepOrphanUploads,
  sweepPresence,
} from './jobs/maintenance.js';
import { deliverPending, handleCallPush, handleMessageFanout, handleReactionPush } from './jobs/push.js';
import { deliverBotEvent, deliverWebhookTest } from './jobs/botwebhook.js';
import {
  ageingTokens,
  agingReports,
  birthdayWishes,
  earlyClaimOffers,
  failingWebhooks,
  reportSpikes,
  staffDigest,
  triageReport,
} from './jobs/yapper.js';

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

  /**
   * Deliver what was just queued, now, instead of waiting for the cron.
   *
   * Fan-out writes rows to `push_outbox` and stops. Until this existed the only
   * thing that ever delivered them was `cron.push_drain`, which pg-boss can run
   * at most once a minute — so a notification took anywhere from a second to a
   * full minute to arrive, averaging thirty. WhatsApp and Telegram hand the
   * notification to APNs in the same breath as accepting the message, and this
   * is what closes that gap: the outbox keeps every durability property it had,
   * it just no longer waits for a timer to notice it.
   *
   * Never allowed to fail the job that queued it. The rows are committed by the
   * time this runs, so a delivery failure here is not a fan-out failure — and
   * throwing would retry the fan-out, not the delivery. The cron remains as the
   * safety net that picks up anything this misses.
   */
  const drainNow = async (what: string) => {
    try {
      await deliverPending(pushDeps, 200);
    } catch (err) {
      log.warn({ err, what }, 'immediate push drain failed; cron will retry');
    }
  };

  await boss.work<{ messageId: string; conversationId: string; senderId: string; seq: number; silent: boolean; mentionIds: string[] }>(
    'push.fanout',
    { batchSize: 10 },
    async (jobs) => {
      for (const job of jobs) await handleMessageFanout(pushDeps, job.data);
      // Once per batch rather than once per message: ten messages arriving
      // together should cost one drain, not ten.
      await drainNow('message');
    },
  );

  await boss.work<Parameters<typeof handleCallPush>[1]>('push.call', async (jobs) => {
    for (const job of jobs) await handleCallPush(pushDeps, job.data);
    // A ring that arrives after the caller has given up is not a ring. This is
    // the one push where a minute of latency makes the feature pointless.
    await drainNow('call');
  });

  await boss.work<{ messageId: string; actorId: string; emoji: string }>('push.reaction', async (jobs) => {
    for (const job of jobs) await handleReactionPush(pushDeps, job.data);
    await drainNow('reaction');
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
      for (const job of jobs) await fetchLinkPreview(db, log, job.data, enqueue);
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

  await boss.work<import('./jobs/botwebhook.js').WebhookTestJob>(
    'bot.webhook_test',
    async (jobs) => {
      // No retry on this queue (set at enqueue): a test reports what happened
      // on the attempt the owner asked for. Retrying it five times with
      // backoff would answer a question about the fourth minute instead.
      for (const job of jobs) await deliverWebhookTest(db, log, enqueue, job.data);
    },
  );

  await boss.work<import('./jobs/announce.js').BroadcastJob>('yapper.broadcast', async (jobs) => {
    // One at a time and never batched: this is the highest-consequence job in
    // the system, and interleaving two broadcasts' paging would make the logs
    // useless for the one question that gets asked afterwards — who got what.
    for (const job of jobs) await fanOutAnnouncement(db, log, job.data, enqueue);
  });

  await boss.work<{ reportId: string; reason: string }>('moderation.triage', async (jobs) => {
    // Still the hook an automated classifier would slot into. What it does
    // today is escalate the two categories that must not wait for someone to
    // glance at the channel — the loud log is kept, and joined by a message
    // in a place people actually read.
    for (const job of jobs) await triageReport(db, log, enqueue, job.data);
  });

  // ── Cron ──────────────────────────────────────────────────────────────────
  // `singletonKey` keeps a job from running on two worker replicas at once.

  await boss.schedule('cron.push_drain', '* * * * *');
  await boss.schedule('cron.sweep_fast', '* * * * *');
  await boss.schedule('cron.sweep_slow', '*/15 * * * *');
  await boss.schedule('cron.hourly', '0 * * * *');
  // Morning UTC, so the digest is waiting rather than arriving mid-shift.
  await boss.schedule('cron.daily', '0 8 * * *');

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
    // Every minute, because a zombie call blocks new rings in its
    // conversation for exactly as long as this waits.
    await reconcileStaleCalls(db, log);
    // Also every minute: a campfire that says it ends at 9:00 and is still
    // there at 9:14 is not a campfire, it is a bug people can see.
    await sweepCampfires(db, log, CAMPFIRE_WARNING_SECONDS);
    // Also every minute, and for a sharper reason than the rest: a live
    // location that has expired but still says "live" is somebody's position
    // being shown to a group past the point they agreed to.
    await sweepLiveLocations(db, log);
  });

  await boss.work('cron.sweep_slow', async () => {
    await sweepEphemeral(db, log);
    await expireInvitesAndBans(db, log);
    await sweepExpiredCustomStatus(db, log);
    await backfillThumbnails(db, log, enqueue);
  });

  await boss.work('cron.hourly', async () => {
    await sweepOrphanUploads(db, log);
    await releaseUnusedMedia(db, log);
    // What yapper has noticed since the last pass. Each of these only enqueues
    // — the API does the talking — and each dedupes on a stable key, so
    // running them hourly does not mean saying anything hourly.
    await agingReports(db, log, enqueue);
    await reportSpikes(db, log, enqueue);
    await failingWebhooks(db, log, enqueue);
    await earlyClaimOffers(db, log, enqueue);
  });

  await boss.work('cron.daily', async () => {
    await staffDigest(db, log, enqueue);
    await ageingTokens(db, log, enqueue);
    await birthdayWishes(db, log, enqueue);
    await tendGroupPets(db, log);
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
