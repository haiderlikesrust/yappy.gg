import { sql as raw, type Database } from '@yappy/db';
import { newId } from '@yappy/shared';
import type { Logger } from 'pino';

/**
 * Ring timeout.
 *
 * Scheduled when a call starts. A client-side timer is not sufficient: the
 * device that most needs the call to end cleanly is the one that crashed, went
 * out of coverage, or had the app killed by the OS mid-ring.
 *
 * This mirrors `endCall()` in the API rather than importing it — the worker
 * does not run Fastify. The two must stay in step; the shared contract is the
 * call state machine documented in docs/ARCHITECTURE.md §Calling.
 */
export async function handleRingTimeout(
  db: Database,
  log: Logger,
  job: { callId: string },
): Promise<void> {
  const rows = (await db.execute(
    raw`select id, conversation_id, initiator_id, mode, state, room_name, started_at, ring_expires_at
          from calls where id = ${job.callId}::uuid`,
  )) as unknown as Array<{
    id: string;
    conversation_id: string | null;
    initiator_id: string | null;
    mode: string;
    state: string;
    room_name: string;
    started_at: Date | null;
    ring_expires_at: Date | null;
  }>;

  const call = rows[0];
  if (!call) return;

  // Somebody answered — nothing to do. This is the common case and the reason
  // the job is cheap to schedule unconditionally.
  if (call.state !== 'ringing') return;
  if (call.ring_expires_at && new Date(call.ring_expires_at) > new Date()) return;

  await db.transaction(async (tx) => {
    await tx.execute(
      raw`update calls
             set state = 'ended', ended_at = now(), end_reason = 'timeout', duration_seconds = 0
           where id = ${job.callId}::uuid and state = 'ringing'`,
    );

    await tx.execute(
      raw`update call_participants
             set state = 'missed', left_at = now()
           where call_id = ${job.callId}::uuid and state in ('ringing', 'invited')`,
    );

    await tx.execute(
      raw`update call_participants
             set state = 'left', left_at = now()
           where call_id = ${job.callId}::uuid and state = 'joined'`,
    );

    if (call.conversation_id) {
      const seqRows = (await tx.execute(
        raw`select allocate_message_seq(${call.conversation_id}::uuid) as seq`,
      )) as unknown as Array<{ seq: string | number }>;

      const messageId = newId();
      await tx.execute(
        raw`insert into messages (id, conversation_id, seq, sender_id, type, call_summary, created_at, updated_at)
            values (
              ${messageId}::uuid,
              ${call.conversation_id}::uuid,
              ${Number(seqRows[0]!.seq)},
              ${call.initiator_id}::uuid,
              'call',
              ${JSON.stringify({
                callId: call.id,
                mode: call.mode,
                outcome: 'missed',
                durationSeconds: 0,
                participantIds: [],
              })}::jsonb,
              now(), now()
            )`,
      );

      await tx.execute(
        raw`update conversations
               set last_message_id = ${messageId}::uuid,
                   last_message_at = now(),
                   last_message_preview = '📞 Missed call'
             where id = ${call.conversation_id}::uuid`,
      );
    }
  });

  // Notify participants so ringing UI stops even on devices that never got the
  // decline event.
  const participants = (await db.execute(
    raw`select user_id from call_participants where call_id = ${job.callId}::uuid`,
  )) as unknown as Array<{ user_id: string }>;

  const payload = JSON.stringify({
    v: 1,
    t: 'call.end',
    d: { callId: job.callId, state: 'ended', endReason: 'timeout', durationSeconds: 0 },
  });

  for (const p of participants) {
    await db.execute(raw`select pg_notify(${'u_' + p.user_id.replace(/-/g, '')}, ${payload})`);
  }
  if (call.conversation_id) {
    await db.execute(
      raw`select pg_notify(${'c_' + call.conversation_id.replace(/-/g, '')}, ${payload})`,
    );
  }

  log.info({ callId: job.callId }, 'call timed out unanswered');
}

/**
 * Reconcile against the SFU.
 *
 * Rooms can outlive our record of them (a node died mid-hangup) and our record
 * can outlive the room (LiveKit garbage-collected an empty room). Neither is
 * catastrophic on its own, but an "active" call that nobody is in shows a live
 * call banner in the conversation forever.
 */
export async function reconcileStaleCalls(db: Database, log: Logger): Promise<void> {
  const stale = (await db.execute(
    raw`update calls
           set state = 'ended', ended_at = now(), end_reason = 'failed'
         where state <> 'ended'
           and created_at < now() - interval '6 hours'
        returning id`,
  )) as unknown as Array<{ id: string }>;

  if (stale.length > 0) log.warn({ count: stale.length }, 'force-ended stale calls');

  // A call marked active with nobody joined for five minutes is over.
  const empty = (await db.execute(
    raw`update calls c
           set state = 'ended', ended_at = now(), end_reason = 'hangup',
               duration_seconds = coalesce(extract(epoch from (now() - c.started_at))::int, 0)
         where c.state = 'active'
           and c.started_at < now() - interval '5 minutes'
           and not exists (
             select 1 from call_participants p
              where p.call_id = c.id and p.state = 'joined'
           )
        returning c.id`,
  )) as unknown as Array<{ id: string }>;

  if (empty.length > 0) log.info({ count: empty.length }, 'ended empty calls');
}
