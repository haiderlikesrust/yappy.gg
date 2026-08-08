import { sql as raw, type Database } from '@yappy/db';
import type { Logger } from 'pino';

/**
 * Scheduled housekeeping.
 *
 * Every one of these exists because something in the system produces garbage
 * that nothing else cleans up. They are deliberately small, idempotent, and
 * bounded — a sweeper that tries to delete a million rows in one statement
 * takes locks long enough to stall the whole app.
 */

const BATCH = 5_000;

export async function sweepExpiredMessages(db: Database, log: Logger): Promise<void> {
  // Disappearing messages. Soft-deleted rather than removed so replies and
  // quote chains do not break — the tombstone is what the client renders.
  const rows = (await db.execute(
    raw`with due as (
          select id from messages
           where expires_at is not null
             and expires_at < now()
             and deleted_at is null
           limit ${BATCH}
        )
        update messages m
           set deleted_at = now()
          from due
         where m.id = due.id
        returning m.id, m.conversation_id`,
  )) as unknown as Array<{ id: string; conversation_id: string }>;

  if (rows.length === 0) return;

  // Tell connected clients so the bubble disappears without a refresh.
  for (const conversationId of new Set(rows.map((r) => r.conversation_id))) {
    const ids = rows.filter((r) => r.conversation_id === conversationId).map((r) => r.id);
    await db.execute(
      raw`select pg_notify(
            ${'c_' + conversationId.replace(/-/g, '')},
            ${JSON.stringify({ v: 1, t: 'message.bulk_delete', d: { conversationId, messageIds: ids } })}
          )`,
    );
  }

  log.info({ count: rows.length }, 'swept expired messages');
}

export async function sweepPresence(db: Database, log: Logger): Promise<void> {
  const rows = (await db.execute(raw`select sweep_presence() as removed`)) as unknown as Array<{
    removed: number;
  }>;
  const removed = rows[0]?.removed ?? 0;
  if (removed > 0) log.debug({ removed }, 'swept stale presence');
}

export async function sweepOrphanUploads(db: Database, log: Logger): Promise<void> {
  // Uploads that were presigned but never confirmed. The S3 object, if any, is
  // removed by a bucket lifecycle rule on the same prefix — doing it here would
  // mean an S3 call per row.
  const rows = (await db.execute(
    raw`delete from media
         where confirmed_at is null
           and created_at < now() - interval '2 hours'
         returning id`,
  )) as unknown as Array<{ id: string }>;

  if (rows.length > 0) log.info({ count: rows.length }, 'swept unconfirmed uploads');
}

export async function sweepEphemeral(db: Database, log: Logger): Promise<void> {
  await db.execute(raw`delete from bus_overflow where expires_at < now()`);
  await db.execute(raw`delete from event_log where expires_at < now()`);
  await db.execute(raw`delete from rate_limits where expires_at < now()`);
  await db.execute(raw`delete from otp_challenges where expires_at < now() - interval '1 day'`);
  // Sent pushes are kept a week for "why did I not get a notification" support.
  await db.execute(raw`delete from push_outbox where sent_at < now() - interval '7 days'`);
  await db.execute(raw`delete from call_events where created_at < now() - interval '1 day'`);
  await db.execute(raw`delete from link_previews where expires_at < now()`);
  log.debug('swept ephemeral tables');
}

export async function expireInvitesAndBans(db: Database, log: Logger): Promise<void> {
  await db.execute(
    raw`delete from conversation_bans where expires_at is not null and expires_at < now()`,
  );
  await db.execute(
    raw`update invites set revoked_at = now()
         where revoked_at is null and expires_at is not null and expires_at < now()`,
  );
  log.debug('expired invites and bans');
}

export async function closeExpiredPolls(db: Database, log: Logger): Promise<void> {
  const rows = (await db.execute(
    raw`update polls set closed_at = now()
         where closed_at is null and closes_at is not null and closes_at < now()
        returning id, message_id`,
  )) as unknown as Array<{ id: string; message_id: string }>;
  if (rows.length > 0) log.info({ count: rows.length }, 'closed expired polls');
}

export async function releaseUnusedMedia(db: Database, log: Logger): Promise<void> {
  // Media whose last reference went away. Soft-deleted here; the S3 object is
  // removed by a separate, slower job that can afford the API calls.
  const rows = (await db.execute(
    raw`update media
           set deleted_at = now()
         where ref_count = 0
           and deleted_at is null
           and purpose = 'attachment'
           and confirmed_at < now() - interval '7 days'
        returning id`,
  )) as unknown as Array<{ id: string }>;
  if (rows.length > 0) log.info({ count: rows.length }, 'released unreferenced media');
}

export async function sendScheduledMessages(
  db: Database,
  log: Logger,
  enqueue: (name: string, data: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  const due = (await db.execute(
    raw`select id, conversation_id, sender_id, payload
          from scheduled_messages
         where sent_message_id is null
           and cancelled_at is null
           and send_at <= now()
         order by send_at
         limit 100`,
  )) as unknown as Array<{
    id: string;
    conversation_id: string;
    sender_id: string;
    payload: Record<string, unknown>;
  }>;

  for (const row of due) {
    // Handed to a dedicated job rather than sent here: sending must go through
    // the same permission and rate-limit path as a live send, which lives in
    // the API service.
    await enqueue('message.scheduled_send', {
      scheduledId: row.id,
      conversationId: row.conversation_id,
      senderId: row.sender_id,
      payload: row.payload,
    });
  }

  if (due.length > 0) log.info({ count: due.length }, 'dispatched scheduled messages');
}

/**
 * Hard-delete an account after its grace period.
 *
 * Messages are kept but anonymised: purging them would punch holes in every
 * group conversation the account took part in, and other people's copies of a
 * shared conversation are not this user's to delete.
 */
export async function purgeAccount(db: Database, log: Logger, userId: string): Promise<void> {
  const rows = (await db.execute(
    raw`select id from users where id = ${userId}::uuid and deleted_at is not null
          and deleted_at < now() - interval '29 days'`,
  )) as unknown as Array<{ id: string }>;

  if (rows.length === 0) {
    log.info({ userId }, 'purge skipped — account restored or not yet due');
    return;
  }

  await db.execute(raw`delete from devices where user_id = ${userId}::uuid`);
  await db.execute(raw`delete from crypto_identities where user_id = ${userId}::uuid`);
  await db.execute(raw`delete from contacts where owner_id = ${userId}::uuid`);
  await db.execute(raw`delete from follows where follower_id = ${userId}::uuid or followee_id = ${userId}::uuid`);
  await db.execute(raw`delete from notifications where user_id = ${userId}::uuid`);
  await db.execute(raw`delete from message_reactions where user_id = ${userId}::uuid`);
  await db.execute(raw`update media set deleted_at = now() where owner_id = ${userId}::uuid`);
  await db.execute(raw`update messages set sender_id = null where sender_id = ${userId}::uuid`);

  log.info({ userId }, 'account purged');
}
