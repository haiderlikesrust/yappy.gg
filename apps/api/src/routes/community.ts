import {
  Permission,
  newId,
  notFound,
  forbidden,
  AppError,
  ErrorCode,
  sendMessageBody,
} from "@yappy/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requirePermission } from "../lib/access.js";

const uuid = z.string().uuid();
const date = z.string().datetime({ offset: true });
const future = date.refine(
  (s) =>
    Date.parse(s) > Date.now() + 30_000 &&
    Date.parse(s) < Date.now() + 366 * 86400_000,
  "Choose a time at least 30 seconds ahead and within the next year.",
);
const eventBody = z
  .object({
    id: uuid,
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2000).default(""),
    location: z.string().trim().max(200).default(""),
    startsAt: future,
    endsAt: date.nullish(),
  })
  .strict()
  .refine(
    (v) => !v.endsAt || Date.parse(v.endsAt) > Date.parse(v.startsAt),
    "End must be after start.",
  );
const profileBody = z
  .object({
    tags: z
      .array(
        z
          .string()
          .trim()
          .toLowerCase()
          .regex(/^[\p{L}\p{N} -]{1,24}$/u),
      )
      .max(5)
      .default([]),
    language: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/)
      .or(z.literal(""))
      .default(""),
    welcome: z.string().trim().max(2000).default(""),
    rules: z.string().trim().max(3000).default(""),
    startChannelId: uuid.nullable().default(null),
  })
  .strict();
type EventRow = {
  id: string;
  conversation_id: string;
  creator_id: string;
  title: string;
  description: string;
  location: string;
  starts_at: Date;
  ends_at: Date | null;
  cancelled_at: Date | null;
  updated_at: Date;
  conversation_title?: string;
  response?: string | null;
  remind?: boolean;
  going?: number;
  maybe?: number;
  declined?: number;
  can_manage?: boolean;
};
const eventDto = (e: EventRow) => ({
  id: e.id,
  conversationId: e.conversation_id,
  creatorId: e.creator_id,
  title: e.title,
  description: e.description,
  location: e.location,
  startsAt: new Date(e.starts_at).toISOString(),
  endsAt: e.ends_at ? new Date(e.ends_at).toISOString() : null,
  cancelledAt: e.cancelled_at ? new Date(e.cancelled_at).toISOString() : null,
  updatedAt: new Date(e.updated_at).toISOString(),
  conversationTitle: e.conversation_title ?? "",
  response: e.response ?? null,
  remind: e.remind ?? false,
  canManage: e.can_manage ?? false,
  going: Number(e.going ?? 0),
  maybe: Number(e.maybe ?? 0),
  declined: Number(e.declined ?? 0),
});

export async function communityRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticateOnboarded);
  // Raw postgres.js reads share Drizzle's timestamp parser (strings). Keep
  // the public wire format identical to endpoints using Drizzle models.
  app.addHook("preSerialization", async (_req, _reply, payload) => {
    const normalize = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(normalize);
      if (v && typeof v === "object")
        return Object.fromEntries(
          Object.entries(v).map(([key, value]) => [
            key,
            /At$/.test(key) &&
            (typeof value === "string" || value instanceof Date)
              ? new Date(value).toISOString()
              : normalize(value),
          ]),
        );
      return v;
    };
    return normalize(payload);
  });
  const visibleMessage = async (id: string, userId: string) => {
    const [row] = await app.sql<
      { id: string; conversation_id: string; seq: number }[]
    >`
      select id, conversation_id, seq from messages where id = ${id}::uuid and can_read_message(id, ${userId}::uuid)`;
    if (!row) throw notFound("Message");
    return row;
  };

  app.get("/catch-up", async (req) => {
    const user = req.user.id;
    const items = await app.sql`
      with activity as (
        select case when mm.message_id is not null then 'mention' else 'reply' end as kind,
          m.id::text as id, c.id as "conversationId", c.title as "conversationTitle", m.id as "messageId", m.seq::float8 as seq,
          coalesce(u.display_name, u.username, 'Someone') as title,
          case when m.is_encrypted then 'Encrypted message' else coalesce(left(m.content, 300), 'Sent an attachment') end as body,
          m.created_at as "createdAt"
        from messages m join conversations c on c.id = m.conversation_id
        left join message_mentions mm on mm.message_id = m.id and mm.user_id = ${user}::uuid
        left join messages parent on parent.id = coalesce(m.reply_to_id, m.thread_root_id)
        left join users u on u.id = m.sender_id
        left join conversation_members cm on cm.conversation_id = c.id and cm.user_id = ${user}::uuid and cm.left_at is null
        where (mm.message_id is not null or parent.sender_id = ${user}::uuid)
          and m.sender_id is distinct from ${user}::uuid and m.seq > coalesce(cm.last_read_seq, 0)
          and can_read_message(m.id, ${user}::uuid)
        union all
        select 'pin', 'pin:' || p.message_id, c.id, c.title, m.id, m.seq::float8, 'New pinned message',
          case when m.is_encrypted then 'Encrypted message' else coalesce(left(m.content, 300), 'Pinned attachment') end,
          p.pinned_at
        from pinned_messages p join messages m on m.id = p.message_id join conversations c on c.id = p.conversation_id
        left join conversation_members cm on cm.conversation_id = c.id and cm.user_id = ${user}::uuid and cm.left_at is null
        where p.pinned_at > coalesce(cm.last_read_at, now() - interval '7 days') and can_read_message(m.id, ${user}::uuid)
        union all
        select 'update', 'notice:' || n.id, c.id, c.title, null::uuid, null::float8,
          coalesce(n.data->>'title', 'Group update'), coalesce(n.data->>'body', replace(n.kind, '_', ' ')), n.created_at
        from notifications n join conversations c on c.id = n.target_id
        where n.user_id = ${user}::uuid and n.read_at is null and n.target_type = 'conversation'
          and can_view_conversation(c.id, ${user}::uuid) and c.deleted_at is null
      ) select * from activity order by "createdAt" desc limit 60`;
    const rooms = await app.sql`
      select c.id as "conversationId", coalesce(c.title, u.display_name, u.username, 'Conversation') as title,
        greatest(c.message_seq - cm.last_read_seq, 0)::int as "unreadCount", c.last_message_at as "createdAt"
      from conversation_members cm join conversations c on c.id = cm.conversation_id
      left join users u on c.type = 'dm' and u.id = (select other.user_id from conversation_members other where other.conversation_id = c.id and other.user_id <> ${user}::uuid and other.left_at is null limit 1)
      where cm.user_id = ${user}::uuid and cm.left_at is null and not cm.is_archived and not cm.is_hidden
        and c.type <> 'space' and c.deleted_at is null and c.message_seq > cm.last_read_seq
        and can_view_conversation(c.id, ${user}::uuid)
      order by c.last_message_at desc nulls last limit 30`;
    return { items, rooms };
  });

  app.get("/events", async (req) => {
    const { conversationId } = z
      .object({ conversationId: uuid.optional() })
      .parse(req.query);
    if (conversationId)
      await requirePermission(
        app.db,
        conversationId,
        req.user.id,
        Permission.VIEW_CONVERSATION,
      );
    const rows = await app.sql<EventRow[]>`
      select e.*, c.title as conversation_title, r.response, r.remind,
        exists(select 1 from conversation_permissions(c.id) p where p.user_id=${req.user.id}::uuid and ((p.permissions & 68719476736)<>0 or (p.permissions & 4611686018427387904)<>0)) as can_manage,
        (select count(*)::int from community_event_responses rr where rr.event_id=e.id and rr.response='going') as going,
        (select count(*)::int from community_event_responses rr where rr.event_id=e.id and rr.response='maybe') as maybe,
        (select count(*)::int from community_event_responses rr where rr.event_id=e.id and rr.response='declined') as declined
      from community_events e join conversations c on c.id=e.conversation_id
      left join community_event_responses r on r.event_id=e.id and r.user_id=${req.user.id}::uuid
      where c.deleted_at is null and can_view_conversation(c.id, ${req.user.id}::uuid)
        and (${conversationId ?? null}::uuid is null or c.id=${conversationId ?? null}::uuid)
        and coalesce(e.ends_at, e.starts_at + interval '1 day') > now() - interval '1 day'
      order by e.starts_at limit 100`;
    return { events: rows.map(eventDto) };
  });
  app.post("/groups/:id/events", async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const ctx = await requirePermission(
      app.db,
      id,
      req.user.id,
      Permission.MANAGE_CONVERSATION,
    );
    if (ctx.conversation.type === "dm")
      throw forbidden("Events belong to groups.");
    const body = eventBody.parse(req.body);
    await app.limiter.consume(`user:${req.user.id}`, "message.save");
    const [row] = await app.sql<
      EventRow[]
    >`insert into community_events(id, conversation_id, creator_id, title, description, location, starts_at, ends_at)
      values (${body.id}::uuid, ${id}::uuid, ${req.user.id}::uuid, ${body.title}, ${body.description}, ${body.location}, ${body.startsAt}::timestamptz, ${body.endsAt ?? null}::timestamptz)
      on conflict(id) do update set id=excluded.id where community_events.creator_id=excluded.creator_id and community_events.conversation_id=excluded.conversation_id returning *`;
    if (!row) throw forbidden("That request ID belongs to another event.");
    return reply.code(201).send({ event: eventDto(row) });
  });
  app.patch("/events/:id", async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z
      .object({
        title: z.string().trim().min(1).max(120),
        description: z.string().trim().max(2000),
        location: z.string().trim().max(200),
        startsAt: future,
        endsAt: date.nullable(),
      })
      .strict()
      .parse(req.body);
    if (body.endsAt && Date.parse(body.endsAt) <= Date.parse(body.startsAt))
      throw new AppError(
        400,
        ErrorCode.ValidationFailed,
        "End must be after start.",
      );
    const [event] = await app.sql<
      EventRow[]
    >`select * from community_events where id=${id}::uuid`;
    if (!event) throw notFound("Event");
    await requirePermission(
      app.db,
      event.conversation_id,
      req.user.id,
      Permission.MANAGE_CONVERSATION,
    );
    const result = await app.sql.begin(async (tx) => {
      const [previous] = await tx<
        EventRow[]
      >`select * from community_events where id=${id}::uuid and cancelled_at is null for update`;
      if (!previous) throw notFound("Active event");
      const startChanged =
        new Date(previous.starts_at).getTime() !== Date.parse(body.startsAt);
      const endChanged =
        (previous.ends_at ? new Date(previous.ends_at).getTime() : null) !==
        (body.endsAt ? Date.parse(body.endsAt) : null);
      if (
        !startChanged &&
        !endChanged &&
        previous.title === body.title &&
        previous.description === body.description &&
        previous.location === body.location
      )
        return previous;
      const [row] = await tx<
        EventRow[]
      >`update community_events set title=${body.title}, description=${body.description}, location=${body.location}, starts_at=${body.startsAt}::timestamptz, ends_at=${body.endsAt}::timestamptz, updated_at=now() where id=${id}::uuid and cancelled_at is null returning *`;
      if (!row) throw notFound("Active event");
      // Editing the description, or retrying an edit after a network error,
      // must not repeat a reminder that was already delivered.
      if (startChanged) {
        await tx`update community_reminders set cancelled_at=now() where event_id=${id}::uuid and delivered_at is null and cancelled_at is null`;
        await tx`insert into community_reminders(id,user_id,conversation_id,event_id,due_at)
        select gen_random_uuid(),user_id,${event.conversation_id}::uuid,${id}::uuid,greatest(now(),${body.startsAt}::timestamptz-interval '15 minutes')
        from community_event_responses where event_id=${id}::uuid and remind=true and response <> 'declined'`;
      }
      return row;
    });
    return { event: eventDto(result) };
  });
  app.delete("/events/:id", async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const [event] = await app.sql<
      EventRow[]
    >`select * from community_events where id=${id}::uuid`;
    if (!event) throw notFound("Event");
    await requirePermission(
      app.db,
      event.conversation_id,
      req.user.id,
      Permission.MANAGE_CONVERSATION,
    );
    await app.sql.begin(async (tx) => {
      await tx`update community_events set cancelled_at=now(),updated_at=now() where id=${id}::uuid and cancelled_at is null`;
      await tx`update community_reminders set cancelled_at=now() where event_id=${id}::uuid and delivered_at is null and cancelled_at is null`;
    });
    return { ok: true };
  });
  app.put("/events/:id/rsvp", async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z
      .object({
        response: z.enum(["going", "maybe", "declined"]),
        remind: z.boolean().default(false),
      })
      .strict()
      .parse(req.body);
    const [event] = await app.sql<
      EventRow[]
    >`select * from community_events where id=${id}::uuid`;
    if (!event) throw notFound("Event");
    await requirePermission(
      app.db,
      event.conversation_id,
      req.user.id,
      Permission.VIEW_CONVERSATION,
    );
    await app.sql.begin(async (tx) => {
      const [active] =
        await tx`select id from community_events where id=${id}::uuid and cancelled_at is null and starts_at>now() for update`;
      if (!active) throw notFound("Upcoming event");
      const remind = body.remind && body.response !== "declined";
      const [previous] =
        await tx`select response,remind from community_event_responses where event_id=${id}::uuid and user_id=${req.user.id}::uuid`;
      if (previous?.response === body.response && previous.remind === remind)
        return;
      await tx`insert into community_event_responses(event_id,user_id,response,remind) values (${id}::uuid,${req.user.id}::uuid,${body.response},${remind})
        on conflict(event_id,user_id) do update set response=excluded.response,remind=excluded.remind,updated_at=now()`;
      if (previous?.remind === remind) return;
      await tx`update community_reminders set cancelled_at=now() where event_id=${id}::uuid and user_id=${req.user.id}::uuid and delivered_at is null and cancelled_at is null`;
      if (remind)
        await tx`insert into community_reminders(id,user_id,conversation_id,event_id,due_at)
        select ${newId()}::uuid,${req.user.id}::uuid,conversation_id,id,greatest(now(),starts_at-interval '15 minutes') from community_events where id=${id}::uuid`;
    });
    return { ok: true };
  });

  app.get("/reminders", async (req) => ({
    reminders: await app.sql`
    select r.id,r.conversation_id as "conversationId",r.message_id as "messageId",m.seq::float8 as seq,r.event_id as "eventId",r.due_at as "dueAt",
      coalesce(e.title, case when m.is_encrypted then 'Encrypted message' else left(m.content,180) end,'Message reminder') as title,c.title as "conversationTitle"
    from community_reminders r join conversations c on c.id=r.conversation_id
    left join messages m on m.id=r.message_id left join community_events e on e.id=r.event_id
    where r.user_id=${req.user.id}::uuid and r.cancelled_at is null and r.delivered_at is null
      and can_view_conversation(c.id,${req.user.id}::uuid) and (r.message_id is null or can_read_message(r.message_id,${req.user.id}::uuid))
    order by r.due_at limit 100`,
  }));
  app.post("/reminders", async (req, reply) => {
    const body = z
      .object({ id: uuid, messageId: uuid, dueAt: future })
      .strict()
      .parse(req.body);
    const msg = await visibleMessage(body.messageId, req.user.id);
    await app.limiter.consume(`user:${req.user.id}`, "message.save");
    const [row] =
      await app.sql`insert into community_reminders(id,user_id,conversation_id,message_id,due_at)
      values (${body.id}::uuid,${req.user.id}::uuid,${msg.conversation_id}::uuid,${msg.id}::uuid,${body.dueAt}::timestamptz)
      on conflict(id) do update set id=excluded.id where community_reminders.user_id=excluded.user_id returning id`;
    if (!row) throw forbidden("That request ID is unavailable.");
    return reply.code(201).send({ id: row.id });
  });
  app.delete("/reminders/:id", async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const rows =
      await app.sql`update community_reminders set cancelled_at=now() where id=${id}::uuid and user_id=${req.user.id}::uuid and delivered_at is null returning id`;
    if (!rows.length) throw notFound("Pending reminder");
    return { ok: true };
  });

  app.get("/scheduled", async (req) => ({
    messages: await app.sql`
    select s.id,s.conversation_id as "conversationId",c.title as "conversationTitle",s.payload->>'content' as content,
      s.send_at as "sendAt",s.failed_at as "failedAt",s.failure
    from scheduled_messages s join conversations c on c.id=s.conversation_id
    where s.sender_id=${req.user.id}::uuid and s.sent_message_id is null and s.sent_at is null and s.cancelled_at is null
    order by s.send_at limit 100`,
  }));
  app.post("/scheduled", async (req, reply) => {
    const body = z
      .object({
        id: uuid,
        conversationId: uuid,
        content: z.string().trim().min(1).max(4000),
        sendAt: future,
      })
      .strict()
      .parse(req.body);
    const ctx = await requirePermission(
      app.db,
      body.conversationId,
      req.user.id,
      Permission.SEND_MESSAGES,
    );
    if (ctx.conversation.type === "space" || ctx.conversation.isForum)
      throw forbidden("Choose a regular text conversation.");
    await app.limiter.consume(`user:${req.user.id}`, "message.save");
    const payload = sendMessageBody.parse({
      nonce: `scheduled:${body.id}`,
      type: "text",
      content: body.content,
    });
    const [row] =
      await app.sql`insert into scheduled_messages(id,sender_id,conversation_id,payload,send_at)
      values (${body.id}::uuid,${req.user.id}::uuid,${body.conversationId}::uuid,${JSON.stringify(payload)},${body.sendAt}::timestamptz)
      on conflict(id) do update set id=excluded.id where scheduled_messages.sender_id=excluded.sender_id returning id`;
    if (!row) throw forbidden("That request ID is unavailable.");
    return reply.code(201).send({ id: row.id });
  });
  app.delete("/scheduled/:id", async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const rows =
      await app.sql`update scheduled_messages set cancelled_at=now(),updated_at=now() where id=${id}::uuid and sender_id=${req.user.id}::uuid and sent_message_id is null and sent_at is null returning id`;
    if (!rows.length) throw notFound("Pending scheduled message");
    return { ok: true };
  });

  app.get("/collections", async (req) => ({
    collections: await app.sql`
    select c.id,c.name,count(d.message_id)::int as count from saved_collections c
    left join saved_item_details d on d.collection_id=c.id and d.user_id=c.user_id and can_read_message(d.message_id,${req.user.id}::uuid)
    where c.user_id=${req.user.id}::uuid group by c.id order by c.created_at`,
  }));
  app.post("/collections", async (req, reply) => {
    const body = z
      .object({ id: uuid, name: z.string().trim().min(1).max(40) })
      .strict()
      .parse(req.body);
    await app.limiter.consume(`user:${req.user.id}`, "message.save");
    const [row] =
      await app.sql`insert into saved_collections(id,user_id,name) values (${body.id}::uuid,${req.user.id}::uuid,${body.name})
      on conflict(id) do update set id=excluded.id where saved_collections.user_id=excluded.user_id returning id,name`;
    if (!row) throw forbidden("That request ID is unavailable.");
    return reply.code(201).send({ collection: row });
  });
  app.patch("/collections/:id", async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { name } = z
      .object({ name: z.string().trim().min(1).max(40) })
      .strict()
      .parse(req.body);
    const [row] =
      await app.sql`update saved_collections set name=${name} where id=${id}::uuid and user_id=${req.user.id}::uuid returning id,name`;
    if (!row) throw notFound("Collection");
    return { collection: row };
  });
  app.delete("/collections/:id", async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const rows =
      await app.sql`delete from saved_collections where id=${id}::uuid and user_id=${req.user.id}::uuid returning id`;
    if (!rows.length) throw notFound("Collection");
    return { ok: true };
  });
  app.get("/saved", async (req) => {
    const { collectionId, q } = z
      .object({
        collectionId: uuid.optional(),
        q: z.string().max(100).default(""),
      })
      .parse(req.query);
    const items = await app.sql`
      select m.id as "messageId",m.conversation_id as "conversationId",m.seq::float8 as seq,c.title as "conversationTitle",
        case when m.is_encrypted then 'Encrypted message' else coalesce(left(m.content,600),'Saved attachment') end as content,
        coalesce(u.display_name,u.username,'Someone') as sender,s.saved_at as "savedAt",d.collection_id as "collectionId",coalesce(d.note,'') as note
      from saved_messages s join messages m on m.id=s.message_id join conversations c on c.id=m.conversation_id
      left join users u on u.id=m.sender_id left join saved_item_details d on d.user_id=s.user_id and d.message_id=s.message_id
      where s.user_id=${req.user.id}::uuid and can_read_message(m.id,${req.user.id}::uuid)
        and (${collectionId ?? null}::uuid is null or d.collection_id=${collectionId ?? null}::uuid)
        and (${q}='' or (not m.is_encrypted and m.content ilike ${"%" + q + "%"}) or d.note ilike ${"%" + q + "%"} or c.title ilike ${"%" + q + "%"})
      order by s.saved_at desc limit 100`;
    return { items };
  });
  app.get("/saved/:id", async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    await visibleMessage(id, req.user.id);
    const [item] =
      await app.sql`select collection_id as "collectionId", note from saved_item_details where user_id=${req.user.id}::uuid and message_id=${id}::uuid`;
    return { collectionId: item?.collectionId ?? null, note: item?.note ?? "" };
  });
  app.put("/saved/:id", async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z
      .object({
        collectionId: uuid.nullable(),
        note: z.string().max(2000).default(""),
      })
      .strict()
      .parse(req.body);
    await visibleMessage(id, req.user.id);
    await app.sql.begin(async (tx) => {
      if (body.collectionId) {
        const [own] =
          await tx`select id from saved_collections where id=${body.collectionId}::uuid and user_id=${req.user.id}::uuid for share`;
        if (!own) throw notFound("Collection");
      }
      await tx`insert into saved_messages(user_id,message_id) values (${req.user.id}::uuid,${id}::uuid) on conflict do nothing`;
      await tx`insert into saved_item_details(user_id,message_id,collection_id,note) values (${req.user.id}::uuid,${id}::uuid,${body.collectionId}::uuid,${body.note})
        on conflict(user_id,message_id) do update set collection_id=excluded.collection_id,note=excluded.note,updated_at=now()`;
    });
    return { ok: true };
  });

  app.get("/groups/:id/welcome", async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const ctx = await requirePermission(
      app.db,
      id,
      req.user.id,
      Permission.VIEW_CONVERSATION,
    );
    const [read] =
      await app.sql`select read_at from community_welcome_reads where user_id=${req.user.id}::uuid and conversation_id=${id}::uuid`;
    const profile = {
      ...((
        ctx.conversation.settings as {
          community?: Record<string, unknown>;
        } | null
      )?.community ?? {}),
    };
    if (typeof profile.startChannelId === "string") {
      const [channel] =
        await app.sql`select id from conversations where id=${profile.startChannelId}::uuid and parent_id=${id}::uuid and deleted_at is null and can_view_conversation(id,${req.user.id}::uuid)`;
      if (!channel) profile.startChannelId = null;
    }
    const channels =
      await app.sql`select id,title from conversations where parent_id=${id}::uuid and deleted_at is null and can_view_conversation(id,${req.user.id}::uuid) order by title`;
    return {
      profile,
      channels,
      seen: Boolean(read),
      canManage:
        (ctx.permissions &
          (Permission.MANAGE_CONVERSATION | Permission.ADMINISTRATOR)) !==
        0n,
    };
  });
  app.put("/groups/:id/welcome", async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const ctx = await requirePermission(
      app.db,
      id,
      req.user.id,
      Permission.MANAGE_CONVERSATION,
    );
    if (ctx.conversation.type === "dm")
      throw forbidden("Welcome pages belong to groups.");
    const body = profileBody.parse(req.body);
    if (body.startChannelId) {
      const [channel] =
        await app.sql`select id from conversations where id=${body.startChannelId}::uuid and parent_id=${id}::uuid and deleted_at is null`;
      if (!channel) throw notFound("Starting channel");
      await requirePermission(
        app.db,
        body.startChannelId,
        req.user.id,
        Permission.VIEW_CONVERSATION,
      );
    }
    await app.sql`update conversations set settings=jsonb_set(coalesce(settings,'{}'),'{community}',${JSON.stringify({ ...body, tags: [...new Set(body.tags)] })}),updated_at=now() where id=${id}::uuid`;
    return { profile: body };
  });
  app.post("/groups/:id/welcome/read", async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    await requirePermission(
      app.db,
      id,
      req.user.id,
      Permission.VIEW_CONVERSATION,
    );
    await app.sql`insert into community_welcome_reads(user_id,conversation_id) values (${req.user.id}::uuid,${id}::uuid) on conflict do nothing`;
    return { ok: true };
  });
}
