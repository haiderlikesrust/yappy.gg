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
  //
  // Chunked, and each conversation on its own footing: a NOTIFY payload is
  // capped at 8000 bytes, so a busy group's backlog of a few hundred expired
  // ids in one payload raised — after the tombstones had already committed —
  // and took every conversation after it in the batch down with it, none of
  // which got their event.
  for (const conversationId of new Set(rows.map((r) => r.conversation_id))) {
    const ids = rows.filter((r) => r.conversation_id === conversationId).map((r) => r.id);
    try {
      for (let i = 0; i < ids.length; i += 100) {
        const messageIds = ids.slice(i, i + 100);
        await db.execute(
          raw`select pg_notify(
                ${'c_' + conversationId.replace(/-/g, '')},
                ${JSON.stringify({ v: 1, t: 'message.bulk_delete', d: { conversationId, messageIds } })}
              )`,
        );
      }
    } catch (err) {
      log.warn({ err, conversationId }, 'expired-message notify failed; clients refetch');
    }
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

/**
 * Custom statuses that were set with an end time.
 *
 * `custom_status_expires_at` has been written since the column existed and read
 * by nothing, so "clear it in an hour" quietly meant "forever". Clearing it
 * without telling anyone would leave every connected client showing the stale
 * text until a refetch, so each cleared user gets a `presence.update` on their
 * own topic — the same envelope shape `PgBus.publish` produces.
 */
export async function sweepExpiredCustomStatus(db: Database, log: Logger): Promise<void> {
  const rows = (await db.execute(
    raw`update users
           set custom_status = null,
               custom_status_expires_at = null
         where custom_status_expires_at is not null
           and custom_status_expires_at < now()
        returning id, presence_status`,
  )) as unknown as Array<{ id: string; presence_status: string }>;

  if (rows.length === 0) return;

  for (const row of rows) {
    await db.execute(
      raw`select pg_notify(
            ${'u_' + row.id.replace(/-/g, '')},
            ${JSON.stringify({
              v: 1,
              t: 'presence.update',
              d: { userId: row.id, status: row.presence_status, customStatus: null },
            })}
          )`,
    );
  }

  log.info({ count: rows.length }, 'cleared expired custom statuses');
}

/**
 * Live locations that have run out.
 *
 * The sharer's phone is supposed to stop on its own, and mostly does. It also
 * gets killed by the OS, runs out of battery, loses signal in a tunnel and
 * never comes back, or is simply put in a drawer — and every one of those
 * leaves a share that says "live" forever if nothing else retires it. Of all
 * the state in this app, a stale one of these is the one that actually costs
 * somebody something.
 *
 * So expiry is the server's job and this is the thing that does it. Idempotent
 * through `ended_at`, which is also what the read path filters on, so a client
 * that never receives the event still stops drawing the dot.
 */
export async function sweepLiveLocations(db: Database, log: Logger): Promise<void> {
  const rows = (await db.execute(
    raw`update live_locations
           set ended_at = now()
         where ended_at is null
           and expires_at < now()
        returning message_id, conversation_id, user_id`,
  )) as unknown as Array<{ message_id: string; conversation_id: string; user_id: string }>;

  if (rows.length === 0) return;

  for (const row of rows) {
    await db.execute(
      raw`select pg_notify(
            ${'c_' + row.conversation_id.replace(/-/g, '')},
            ${JSON.stringify({
              v: 1,
              t: 'location.end',
              d: {
                conversationId: row.conversation_id,
                messageId: row.message_id,
                userId: row.user_id,
              },
            })}
          )`,
    );
  }

  log.info({ count: rows.length }, 'ended expired live locations');
}

/**
 * Campfires: places that burn down.
 *
 * Two passes, both idempotent, because this runs every minute:
 *
 *  1. **Warn.** Anything inside the warning window that has not been warned yet
 *     gets one system message, and `ends_warned_at` is what stops it repeating
 *     — the other sweepers get idempotency free from the state they change
 *     (`deleted_at`, `closed_at`), and a warning has nothing of its own to flip.
 *  2. **Burn.** Soft-delete, exactly like the owner pressing delete. Never a
 *     real `DELETE`: `messages.conversation_id` cascades, so a hard delete
 *     would take the history out from under anyone still reading it, and the
 *     tombstone is what lets clients close the screen gracefully.
 */
export async function sweepCampfires(
  db: Database,
  log: Logger,
  warningSeconds: number,
): Promise<void> {
  const warned = (await db.execute(
    raw`with due as (
          select id, ends_at from conversations
           where ends_at is not null
             and ends_warned_at is null
             and deleted_at is null
             and ends_at > now()
             and ends_at < now() + make_interval(secs => ${warningSeconds})
           limit 200
        )
        update conversations c
           set ends_warned_at = now()
          from due
         where c.id = due.id
        returning c.id, c.ends_at`,
  )) as unknown as Array<{ id: string; ends_at: Date }>;

  for (const row of warned) {
    const endsAt = new Date(row.ends_at).toISOString();
    const inserted = (await db.execute(
      raw`with s as (select allocate_message_seq(${row.id}::uuid) as seq)
          insert into messages (id, conversation_id, seq, sender_id, type, system)
          select gen_random_uuid(), ${row.id}::uuid, s.seq, null, 'system',
                 ${JSON.stringify({ event: 'campfire_ending', value: endsAt })}::jsonb
            from s
          returning id, seq, created_at`,
    )) as unknown as Array<{ id: string; seq: number; created_at: Date }>;

    const message = inserted[0];
    if (!message) continue;

    await db.execute(
      raw`update conversations
             set last_message_id = ${message.id}::uuid,
                 last_message_at = now(),
                 last_message_preview = 'This campfire is ending soon'
           where id = ${row.id}::uuid`,
    );

    // Shaped like the API's own message payload so both clients decode it with
    // the serialiser they already have. Everything a system message does not
    // carry is sent explicitly rather than omitted, because a missing array is
    // a decode failure on one of them and a silent empty on the other.
    await db.execute(
      raw`select pg_notify(
            ${'c_' + row.id.replace(/-/g, '')},
            ${JSON.stringify({
              v: 1,
              t: 'message.create',
              d: {
                id: message.id,
                conversationId: row.id,
                seq: Number(message.seq),
                type: 'system',
                content: null,
                entities: null,
                sender: null,
                senderId: null,
                replyTo: null,
                attachments: [],
                embeds: [],
                components: [],
                reactions: [],
                system: { event: 'campfire_ending', value: endsAt },
                createdAt: new Date(message.created_at).toISOString(),
              },
            })}
          )`,
    );
  }

  const burned = (await db.execute(
    raw`with due as (
          select id from conversations
           where ends_at is not null
             and ends_at < now()
             and deleted_at is null
           limit 200
        )
        update conversations c
           set deleted_at = now()
          from due
         where c.id = due.id
        returning c.id`,
  )) as unknown as Array<{ id: string }>;

  for (const row of burned) {
    await db.execute(
      raw`select pg_notify(
            ${'c_' + row.id.replace(/-/g, '')},
            ${JSON.stringify({
              v: 1,
              t: 'conversation.delete',
              d: { id: row.id, reason: 'expired' },
            })}
          )`,
    );
  }

  if (warned.length > 0 || burned.length > 0) {
    log.info({ warned: warned.length, burned: burned.length }, 'swept campfires');
  }
}

export async function sweepOrphanUploads(db: Database, log: Logger): Promise<void> {
  // Uploads that were presigned but never confirmed. The S3 object, if any, is
  // removed by a bucket lifecycle rule on the same prefix — doing it here would
  // mean an S3 call per row.
  const rows = (await db.execute(
    raw`delete from media
         where confirmed_at is null
           and created_at < now() - interval '2 hours'
           -- A sticker may reference an upload that was never confirmed
           -- (the route does not insist on it), and its foreign key is
           -- RESTRICT: one such row made this whole statement roll back, every
           -- hour, forever, and took the rest of the hourly cron with it.
           and not exists (select 1 from stickers s where s.media_id = media.id)
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
  // And the ones that expired before anyone delivered them — a worker outage
  // leaves a row per message with no sent_at, which nothing else ever
  // touched, sitting in the pending index the claim query walks every drain.
  await db.execute(
    raw`delete from push_outbox where sent_at is null and expires_at < now() - interval '1 day'`,
  );
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
