import { AppError, Event, sendMessageBody } from "@yappy/shared";
import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";

/** The database row, not a potentially stale queue payload, owns delivery. */
export async function deliverScheduled(
  app: FastifyInstance,
  scheduledId: string,
) {
  let failedUser: string | undefined;
  await app.sql.begin(async (tx) => {
    const [row] =
      await tx`select * from scheduled_messages where id=${scheduledId}::uuid
      and sent_message_id is null and sent_at is null and cancelled_at is null and failed_at is null and send_at<=now() for update`;
    if (!row) return;
    try {
      const input = sendMessageBody.parse({
        ...row.payload,
        nonce: `scheduled:${row.id}`,
      });
      const { message } = await app.messages.send(
        row.sender_id,
        row.conversation_id,
        input,
      );
      await tx`update scheduled_messages set sent_message_id=${message.id}::uuid,sent_at=now(),updated_at=now() where id=${row.id}::uuid`;
    } catch (err) {
      // Temporary failures retry. Rejected sends remain visible for their owner
      // to inspect and cancel; never silently send them after access changes.
      if (!(err instanceof AppError) || err.status >= 500 || err.status === 429)
        throw err;
      const body =
        "Open Scheduled in Catch up to review this message. " + err.message;
      await tx`update scheduled_messages set failed_at=now(),failure=${err.message},updated_at=now() where id=${row.id}::uuid`;
      await tx`insert into notifications(id,user_id,kind,target_type,target_id,data)
        values (${row.id}::uuid,${row.sender_id}::uuid,'scheduled_failed','conversation',${row.conversation_id}::uuid,
          ${JSON.stringify({ title: "Scheduled message wasn’t sent", body, scheduledId: row.id })}) on conflict(id) do nothing`;
      failedUser = row.sender_id;
    }
  });
  if (failedUser) await nudge(app, failedUser);
}

function quietNow(
  quiet: {
    enabled?: boolean;
    start: string;
    end: string;
    timezone: string;
  } | null,
): boolean {
  if (!quiet?.enabled) return false;
  try {
    const local = new Intl.DateTimeFormat("en-GB", {
      timeZone: quiet.timezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date());
    return quiet.start <= quiet.end
      ? local >= quiet.start && local < quiet.end
      : local >= quiet.start || local < quiet.end;
  } catch {
    return false;
  }
}

export async function deliverReminder(
  app: FastifyInstance,
  reminderId: string,
) {
  let recipient: string | undefined;
  // Lock the event first, matching edit/cancel/RSVP lock order. This also
  // prevents an event being cancelled halfway through reminder delivery.
  const [target] =
    await app.sql`select event_id from community_reminders where id=${reminderId}::uuid`;
  await app.sql.begin(async (tx) => {
    if (target?.event_id)
      await tx`select id from community_events where id=${target.event_id}::uuid for update`;
    const [r] =
      await tx`select * from community_reminders where id=${reminderId}::uuid
      and due_at<=now() and delivered_at is null and cancelled_at is null for update`;
    if (!r) return;
    const [context] =
      await tx`select c.title as conversation_title,u.notifications,
      m.seq,m.is_encrypted,m.content,e.title as event_title,e.starts_at,
      (u.deleted_at is null and (u.suspended_until is null or u.suspended_until<=now())
        and c.deleted_at is null and can_view_conversation(c.id,u.id)
        and (r.message_id is null or can_read_message(r.message_id,u.id))
        and (r.event_id is null or (e.cancelled_at is null and e.starts_at>now()))) as allowed
      from community_reminders r join conversations c on c.id=r.conversation_id join users u on u.id=r.user_id
      left join messages m on m.id=r.message_id left join community_events e on e.id=r.event_id where r.id=${r.id}::uuid`;
    if (!context?.allowed) {
      await tx`update community_reminders set cancelled_at=now() where id=${r.id}::uuid`;
      return;
    }
    const title = r.event_id ? "Event starting soon" : "Your message reminder";
    const body = r.event_id
      ? context.event_title
      : context.is_encrypted
        ? "Encrypted message"
        : String(
            context.content || "Open the conversation to see this message.",
          ).slice(0, 180);
    const data = {
      title,
      body,
      conversationId: r.conversation_id,
      conversationTitle: context.conversation_title,
      ...(r.message_id
        ? { messageId: r.message_id, seq: Number(context.seq) }
        : { eventId: r.event_id, startsAt: context.starts_at }),
    };
    await tx`insert into notifications(id,user_id,kind,target_type,target_id,data)
      values (${r.id}::uuid,${r.user_id}::uuid,${r.event_id ? "event_reminder" : "message_reminder"},'conversation',${r.conversation_id}::uuid,${JSON.stringify(data)}) on conflict(id) do nothing`;
    const prefs = context.notifications ?? {};
    if (!quietNow(prefs.quietHours))
      await tx`insert into push_outbox(id,user_id,kind,collapse_key,dedupe_key,title,body,data,sound,expires_at)
      values (${r.id}::uuid,${r.user_id}::uuid,'system',${"reminder:" + r.id},${"reminder:" + r.id},${title},
        ${prefs.showPreview === false ? "Open yappy to view your reminder." : body},
        ${JSON.stringify({ type: "reminder", conversationId: r.conversation_id, ...(r.message_id ? { messageId: r.message_id, seq: Number(context.seq) } : { eventId: r.event_id }) })},
        ${prefs.sound ?? "default"},now()+interval '1 hour') on conflict do nothing`;
    await tx`update community_reminders set delivered_at=now() where id=${r.id}::uuid`;
    recipient = r.user_id;
  });
  if (recipient) await nudge(app, recipient);
}

async function nudge(app: FastifyInstance, userId: string) {
  try {
    await app.events.toUser(userId, Event.NotificationCreate, {});
  } catch (err) {
    app.log.warn({ err }, "community notification gateway nudge failed");
  }
}

export const communityJobsPlugin = fp(
  async (app) => {
    await app.boss.work<{ scheduledId: string }>(
      "message.scheduled_send",
      { batchSize: 5 },
      async (jobs) => {
        for (const job of jobs)
          await deliverScheduled(app, job.data.scheduledId);
      },
    );
    await app.boss.work<{ reminderId: string }>(
      "community.reminder",
      { batchSize: 10 },
      async (jobs) => {
        for (const job of jobs) await deliverReminder(app, job.data.reminderId);
      },
    );
  },
  { name: "community-jobs" },
);
