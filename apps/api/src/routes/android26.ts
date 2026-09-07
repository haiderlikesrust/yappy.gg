import { and, eq, inArray, messages } from "@yappy/db";
import {
  AppError,
  ErrorCode,
  Permission,
  forbidden,
  notFound,
} from "@yappy/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requirePermission } from "../lib/access.js";

const uuid = z.string().uuid();
const paramsId = (params: unknown) => z.object({ id: uuid }).parse(params).id;

export async function android26Routes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticateOnboarded);

  app.get("/folders", async (req) => ({
    folders: await app.sql`
    select f.id,f.name,coalesce(array_agg(i.conversation_id) filter (
      where i.conversation_id is not null and can_view_conversation(i.conversation_id,${req.user.id}::uuid)), '{}') as "conversationIds"
    from chat_folders f left join chat_folder_items i on i.folder_id=f.id
    where f.user_id=${req.user.id}::uuid group by f.id order by f.created_at,f.id`,
  }));

  app.put("/folders/:id", async (req) => {
    const id = paramsId(req.params);
    const body = z
      .object({
        name: z.string().trim().min(1).max(40),
        conversationIds: z.array(uuid).max(200),
      })
      .parse(req.body);
    const ids = [...new Set(body.conversationIds)];
    for (const conversationId of ids)
      await requirePermission(
        app.db,
        conversationId,
        req.user.id,
        Permission.READ_HISTORY,
      );
    await app.sql.begin(async (tx) => {
      // Serialize the per-user limit, including concurrent creates.
      await tx`select id from users where id=${req.user.id}::uuid for update`;
      const existing =
        await tx`select id from chat_folders where id=${id}::uuid and user_id=${req.user.id}::uuid`;
      const [count] =
        await tx`select count(*)::int as n from chat_folders where user_id=${req.user.id}::uuid`;
      if (!existing.length && count!.n >= 20)
        throw forbidden("You can create up to 20 folders.");
      const rows =
        await tx`insert into chat_folders(id,user_id,name) values (${id}::uuid,${req.user.id}::uuid,${body.name})
        on conflict(id) do update set name=excluded.name where chat_folders.user_id=excluded.user_id returning id`;
      if (!rows.length) throw notFound("Folder");
      await tx`delete from chat_folder_items where folder_id=${id}::uuid`;
      for (const conversationId of ids)
        await tx`insert into chat_folder_items(folder_id,conversation_id) values (${id}::uuid,${conversationId}::uuid)`;
    });
    return { ok: true };
  });
  app.delete("/folders/:id", async (req) => {
    const rows =
      await app.sql`delete from chat_folders where id=${paramsId(req.params)}::uuid and user_id=${req.user.id}::uuid returning id`;
    if (!rows.length) throw notFound("Folder");
    return { ok: true };
  });

  app.get("/conversations/:id/gallery", async (req) => {
    const id = paramsId(req.params);
    await requirePermission(app.db, id, req.user.id, Permission.READ_HISTORY);
    const { kind, before } = z
      .object({
        kind: z.enum(["photos", "videos", "files", "links"]).default("photos"),
        before: z.coerce.number().int().positive().optional(),
      })
      .parse(req.query);
    const rows = await app.sql<{ id: string }[]>`select m.id from messages m
      where m.conversation_id=${id}::uuid and can_read_message(m.id,${req.user.id}::uuid)
      and (${before ?? null}::bigint is null or m.seq < ${before ?? null}::bigint)
      and (case when ${kind}='links' then m.content ~* 'https?://' else exists (
        select 1 from message_attachments a join media md on md.id=a.media_id where a.message_id=m.id and md.deleted_at is null
        and (case when ${kind}='photos' then md.mime_type like 'image/%'
          when ${kind}='videos' then md.mime_type like 'video/%'
          else md.mime_type not like 'image/%' and md.mime_type not like 'video/%' end)) end)
      order by m.seq desc limit 40`;
    const found = rows.length
      ? await app.db
          .select()
          .from(messages)
          .where(
            inArray(
              messages.id,
              rows.map((r) => r.id),
            ),
          )
      : [];
    const byId = new Map(found.map((m) => [m.id, m]));
    return {
      messages: await app.messages.hydrateMany(
        rows.map((r) => byId.get(r.id)!).filter(Boolean),
        req.user.id,
      ),
      hasMore: rows.length === 40,
    };
  });

  app.get("/conversations/:id/walls", async (req) => {
    const id = paramsId(req.params);
    await requirePermission(app.db, id, req.user.id, Permission.READ_HISTORY);
    return {
      walls: await app.sql`select w.id,w.title,w.creator_id as "creatorId",
      count(i.message_id) filter(where can_read_message(i.message_id,${req.user.id}::uuid))::int as count
      from photo_walls w left join photo_wall_items i on i.wall_id=w.id where w.conversation_id=${id}::uuid
      group by w.id order by w.created_at desc,w.id`,
    };
  });
  app.put("/conversations/:id/walls/:wallId", async (req) => {
    const { id, wallId } = z
      .object({ id: uuid, wallId: uuid })
      .parse(req.params);
    const { title } = z
      .object({ title: z.string().trim().min(1).max(80) })
      .parse(req.body);
    const ctx = await requirePermission(
      app.db,
      id,
      req.user.id,
      Permission.SEND_MESSAGES,
    );
    if (ctx.conversation.type === "dm")
      throw forbidden("Shared albums belong to groups.");
    const rows =
      await app.sql`insert into photo_walls(id,conversation_id,creator_id,title)
      values (${wallId}::uuid,${id}::uuid,${req.user.id}::uuid,${title}) on conflict(id) do update set title=excluded.title
      where photo_walls.creator_id=excluded.creator_id and photo_walls.conversation_id=excluded.conversation_id returning id`;
    if (!rows.length) throw notFound("Album");
    return { ok: true };
  });
  const wallFor = async (id: string, user: string) => {
    const [wall] =
      await app.sql`select * from photo_walls where id=${id}::uuid`;
    if (!wall) throw notFound("Album");
    const ctx = await requirePermission(
      app.db,
      wall.conversation_id,
      user,
      Permission.READ_HISTORY,
    );
    return { wall, ctx };
  };
  app.get("/walls/:id", async (req) => {
    const id = paramsId(req.params);
    const { wall } = await wallFor(id, req.user.id);
    const { before } = z
      .object({ before: z.coerce.number().int().positive().optional() })
      .parse(req.query);
    const rows = await app.sql<
      { id: string }[]
    >`select m.id from photo_wall_items i join messages m on m.id=i.message_id
      where i.wall_id=${id}::uuid and can_read_message(m.id,${req.user.id}::uuid)
      and (${before ?? null}::bigint is null or m.seq<${before ?? null}::bigint) order by m.seq desc limit 40`;
    const found = rows.length
      ? await app.db
          .select()
          .from(messages)
          .where(
            inArray(
              messages.id,
              rows.map((r) => r.id),
            ),
          )
      : [];
    const byId = new Map(found.map((m) => [m.id, m]));
    return {
      title: wall.title,
      messages: await app.messages.hydrateMany(
        rows.map((r) => byId.get(r.id)!).filter(Boolean),
        req.user.id,
      ),
      hasMore: rows.length === 40,
    };
  });
  app.put("/walls/:id/items/:messageId", async (req) => {
    const { id, messageId } = z
      .object({ id: uuid, messageId: uuid })
      .parse(req.params);
    const { wall } = await wallFor(id, req.user.id);
    await requirePermission(
      app.db,
      wall.conversation_id,
      req.user.id,
      Permission.SEND_MESSAGES,
    );
    const rows =
      await app.sql`insert into photo_wall_items(wall_id,message_id,contributor_id)
      select ${id}::uuid,m.id,${req.user.id}::uuid from messages m where m.id=${messageId}::uuid
      and m.conversation_id=${wall.conversation_id}::uuid and can_read_message(m.id,${req.user.id}::uuid)
      and exists(select 1 from message_attachments a join media md on md.id=a.media_id where a.message_id=m.id
        and (md.mime_type like 'image/%' or md.mime_type like 'video/%'))
      on conflict(wall_id,message_id) do update set message_id=excluded.message_id returning message_id`;
    if (!rows.length) throw notFound("Photo or video");
    return { ok: true };
  });
  app.delete("/walls/:id/items/:messageId", async (req) => {
    const { id, messageId } = z
      .object({ id: uuid, messageId: uuid })
      .parse(req.params);
    const { wall } = await wallFor(id, req.user.id);
    const rows =
      await app.sql`delete from photo_wall_items where wall_id=${id}::uuid and message_id=${messageId}::uuid
      and (contributor_id=${req.user.id}::uuid or ${wall.creator_id}::uuid=${req.user.id}::uuid) returning message_id`;
    if (!rows.length) throw notFound("Album item");
    return { ok: true };
  });
  app.delete("/walls/:id", async (req) => {
    const id = paramsId(req.params);
    await wallFor(id, req.user.id);
    const rows =
      await app.sql`delete from photo_walls where id=${id}::uuid and creator_id=${req.user.id}::uuid returning id`;
    if (!rows.length) throw notFound("Album");
    return { ok: true };
  });

  // The endpoint is administrator-configured; callers never supply a URL.
  const transcribing = new Set<string>();
  app.post("/messages/:id/transcript", async (req) => {
    z.object({ consent: z.literal(true) }).parse(req.body);
    const id = paramsId(req.params);
    const [row] =
      await app.sql`select md.* from messages m join message_attachments a on a.message_id=m.id
      join media md on md.id=a.media_id where m.id=${id}::uuid and can_read_message(m.id,${req.user.id}::uuid)
      and m.is_encrypted=false and md.deleted_at is null and md.mime_type like 'audio/%' order by a.position limit 1`;
    if (!row) throw notFound("Voice note");
    const base = process.env.TRANSCRIPTION_BASE_URL;
    if (!base)
      throw new AppError(
        503,
        ErrorCode.Internal,
        "Voice transcription is not available yet.",
      );
    if (Number(row.size) > 25_000_000 || Number(row.duration_ms) > 600_000)
      throw forbidden(
        "Transcription supports voice notes up to 10 minutes and 25 MB.",
      );
    await app.limiter.consume(`transcript:${req.user.id}`, "media.upload");
    if (transcribing.has(req.user.id) || transcribing.size >= 2)
      throw new AppError(
        429,
        ErrorCode.RateLimited,
        "Transcription is busy. Please try again shortly.",
      );
    transcribing.add(req.user.id);
    try {
      const object = await app.storage.getObject(row.bucket, row.object_key);
      if (!object) throw notFound("Audio");
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of object.body as AsyncIterable<Buffer>) {
        size += chunk.length;
        if (size > 25_000_000) throw forbidden("Audio is too large.");
        chunks.push(chunk);
      }
      const form = new FormData();
      form.append(
        "file",
        new Blob([new Uint8Array(Buffer.concat(chunks))], {
          type: row.mime_type,
        }),
        row.filename ?? "voice.m4a",
      );
      form.append(
        "model",
        process.env.TRANSCRIPTION_MODEL ?? "Systran/faster-whisper-small",
      );
      const response = await fetch(
        `${base.replace(/\/$/, "")}/audio/transcriptions`,
        {
          method: "POST",
          body: form,
          headers: process.env.TRANSCRIPTION_API_KEY
            ? { Authorization: `Bearer ${process.env.TRANSCRIPTION_API_KEY}` }
            : {},
          signal: AbortSignal.timeout(120_000),
        },
      );
      if (!response.ok)
        throw new AppError(
          503,
          ErrorCode.Internal,
          "Couldn’t transcribe this voice note. Please try again.",
        );
      const result = z
        .object({ text: z.string().max(100_000) })
        .parse(await response.json());
      // Re-check after processing: membership can be revoked during a long job.
      const visible =
        await app.sql`select id from messages where id=${id}::uuid and can_read_message(id,${req.user.id}::uuid)`;
      if (!visible.length) throw notFound("Voice note");
      return { text: result.text };
    } finally {
      transcribing.delete(req.user.id);
    }
  });
}
