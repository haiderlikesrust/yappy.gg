import { createHash } from 'node:crypto';
import { sql as raw, type Database } from '@yappy/db';
import type { Logger } from 'pino';

/**
 * Staff announcements, fanned out.
 *
 * This is the "decide who" half of the split described on `yapper.dm`: the
 * worker pages the user table and enqueues one DM job per person, and the API
 * does the actual saying. Nothing here posts a message.
 *
 * Three properties matter, and all three come from the shared `broadcastId`:
 *
 *  1. **Idempotent, per recipient.** The key each job carries is derived from
 *     the broadcast id *and* the person it is for, so a job that dies at row
 *     4,000 of 10,000 and is retried resolves the first 4,000 to the messages
 *     that already exist and sends only the remainder.
 *
 *     It used to be the broadcast id alone, on the reasoning that one key for
 *     the whole send is what makes a retry a no-op. It is — for everybody.
 *     Message idempotency is scoped to `(sender_id, nonce)` and yapper sends
 *     every one of these, so the second recipient's send resolved to the first
 *     recipient's message and posted nothing. Every announcement ever sent
 *     reached exactly one account, reported success, and logged nothing.
 *  2. **Resumable in order.** Paging by `id` rather than `offset` means a retry
 *     re-walks the same sequence even as accounts are created underneath it;
 *     `offset` would skip people every time the table grew mid-send.
 *  3. **Bounded.** One page at a time, enqueued and forgotten. The heavy work
 *     is spread across the `yapper.dm` consumers rather than held in memory
 *     here.
 *
 * The eligibility rules deliberately stop at "is this an account a human could
 * read". Whether they *want* it — the announcements preference, a block on
 * yapper — is `deliverYapperDm`'s call, and duplicating it here would be a
 * second copy of a rule that must not drift.
 */

const PAGE = 500;

/**
 * One stable key per (broadcast, recipient).
 *
 * Hashed rather than concatenated because the downstream nonce is
 * `yapper_announcement_<key>` against a 64-character limit, and two uuids
 * spelled out is 93. Deterministic, so a retry produces the same key and
 * resolves to the message already sent; 24 base64url characters is 144 bits,
 * which is not going to collide across recipients of one announcement.
 */
function recipientKey(broadcastId: string, userId: string): string {
  return createHash('sha256').update(`${broadcastId}:${userId}`).digest('base64url').slice(0, 24);
}

export interface BroadcastJob {
  broadcastId: string;
  audience: 'staff' | 'everyone';
  actorId: string;
  title: string;
  body: string;
  footer: string | null;
}

export async function fanOutAnnouncement(
  db: Database,
  log: Logger,
  job: BroadcastJob,
  enqueue: (queue: string, data: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  const staffOnly = job.audience === 'staff';
  let cursor: string | null = null;
  let sent = 0;

  for (;;) {
    const rows = (await db.execute(
      raw`select u.id
            from users u
           where u.deleted_at is null
             and u.is_bot = false
             ${staffOnly ? raw`and u.is_staff = true` : raw`and (u.suspended_until is null or u.suspended_until < now())`}
             ${cursor ? raw`and u.id > ${cursor}::uuid` : raw``}
           order by u.id
           limit ${PAGE}`,
    )) as unknown as Array<{ id: string }>;

    if (rows.length === 0) break;

    for (const row of rows) {
      await enqueue('yapper.dm', {
        userId: row.id,
        kind: 'announcement',
        dedupe: recipientKey(job.broadcastId, row.id),
        payload: { title: job.title, body: job.body, footer: job.footer },
      });
    }

    sent += rows.length;
    cursor = rows.at(-1)?.id ?? null;
    if (rows.length < PAGE) break;
  }

  log.info(
    { broadcastId: job.broadcastId, audience: job.audience, actorId: job.actorId, recipients: sent },
    'announcement fanned out',
  );
}
