import fp from 'fastify-plugin';
import {
  deliverYapperDm,
  deliverYapperStaff,
  type YapperDmJob,
  type YapperStaffJob,
} from '../lib/yapperNotify.js';
import { EARLY_CLAIM } from '@yappy/shared';
import { reserveSlot } from '../lib/earlyclaim.js';
import { env } from '../env.js';

/**
 * The one place the API consumes a queue instead of producing into it.
 *
 * Everywhere else the split is clean — the API serves requests, the worker
 * does deferred work — and this is the documented exception rather than an
 * erosion of it. Posting a message means allocating a gapless `seq` under the
 * conversation's row lock, publishing the realtime event and enqueuing push
 * fan-out; all of that is `MessageService`, and `MessageService` lives here.
 * The worker deliberately has no way to send a message, which is the same
 * reason `sendScheduledMessages` hands its due rows back rather than posting
 * them itself.
 *
 * So the division is: the worker decides *whether something is worth saying*
 * (it owns cron and the detection queries), and the API decides *how to say
 * it* and says it.
 *
 * Consuming from every API instance is fine and is the point: pg-boss locks a
 * job when it hands it out, so N instances polling share the work rather than
 * duplicating it. The batch sizes are small because these are conversational
 * messages, not fan-out — there is no burst to absorb.
 */
export const yapperJobsPlugin = fp(
  async (app) => {
    await app.boss.work<YapperDmJob>('yapper.dm', { batchSize: 5 }, async (jobs) => {
      for (const job of jobs) {
        // One bad recipient must not fail the batch and drag four unrelated
        // notices through a retry with it.
        try {
          await deliverYapperDm(app, job.data);
        } catch (err) {
          app.log.error({ err, kind: job.data?.kind }, 'yapper DM delivery failed');
        }
      }
    });

    await app.boss.work<YapperStaffJob>('yapper.staff', { batchSize: 5 }, async (jobs) => {
      for (const job of jobs) {
        try {
          await deliverYapperStaff(app, job.data);
        } catch (err) {
          app.log.error({ err, kind: job.data?.kind }, 'yapper staff post failed');
        }
      }
    });

    /**
     * Offer somebody a slot in the early-tester reward.
     *
     * The worker finds who qualifies; the decision to spend one of three
     * payments is made here, one at a time, because it is a decision about
     * money rather than a detection. `reserveSlot` returns null when the
     * treasury is spent or somebody else got there first — and then nothing is
     * said at all, which is the entire point. A person is only ever told they
     * have earned this once it is already theirs.
     */
    await app.boss.work<{ userId: string }>('yapper.claim_offer', { batchSize: 1 }, async (jobs) => {
      for (const job of jobs) {
        try {
          const reserved = await reserveSlot(app, job.data.userId);
          if (!reserved) continue;

          await app.enqueue('yapper.dm', {
            userId: job.data.userId,
            kind: 'early_claim',
            // The claim, not the moment — a retry must not offer twice.
            dedupe: `early_claim:${job.data.userId}`,
            payload: {
              amountUsd: EARLY_CLAIM.amountUsd,
              currency: EARLY_CLAIM.currency,
              url: `${env.PUBLIC_WEB_URL}/claim/early`,
              expiresAt: reserved.expiresAt.toUTCString(),
            },
          });
        } catch (err) {
          app.log.error({ err, userId: job.data?.userId }, 'claim offer failed');
        }
      }
    });

    app.log.info('yapper notification workers started');
  },
  // After `services`: both handlers post through app.messages.
  { name: 'yapper-jobs', dependencies: [] },
);
