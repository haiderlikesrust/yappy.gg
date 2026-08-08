import { sql as raw } from '@yappy/db';
import { searchMessagesQuery } from '@yappy/shared';
import type { FastifyInstance } from 'fastify';

/**
 * Message search.
 *
 * Scoped to conversations the caller is a member of, enforced inside the query
 * rather than as a post-filter — a post-filter still lets result *counts* and
 * timing leak the existence of private content.
 *
 * `websearch_to_tsquery` rather than `plainto_tsquery`: it understands quoted
 * phrases and `-exclusion`, which is what people type into a search box.
 *
 * Postgres FTS is the right tool up to the low millions of messages. Past that,
 * mirror into OpenSearch — the shape of this endpoint does not change, only
 * what backs it.
 */
export async function searchRoutes(app: FastifyInstance) {
  app.get('/messages', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const query = searchMessagesQuery.parse(req.query);
    await app.limiter.consume(`user:${req.user.id}`, 'search');

    const rows = (await app.db.execute(
      raw`
      with scope as (
        select m.conversation_id, m.history_start_seq
          from conversation_members m
         where m.user_id = ${req.user.id}::uuid
           and m.left_at is null
           ${query.conversationId ? raw`and m.conversation_id = ${query.conversationId}::uuid` : raw``}
      ),
      q as (select websearch_to_tsquery('simple', ${query.q}) as tsq)
      select
        msg.id,
        msg.conversation_id,
        msg.seq,
        msg.sender_id,
        msg.type,
        msg.created_at,
        ts_headline('simple', msg.content, q.tsq,
                    'StartSel=<em>,StopSel=</em>,MaxWords=24,MinWords=8') as snippet,
        ts_rank(msg.search_vector, q.tsq) as rank
      from messages msg
      join scope s on s.conversation_id = msg.conversation_id
      cross join q
      where msg.search_vector @@ q.tsq
        and msg.deleted_at is null
        and msg.seq > s.history_start_seq
        ${query.fromUserId ? raw`and msg.sender_id = ${query.fromUserId}::uuid` : raw``}
        ${query.type ? raw`and msg.type = ${query.type}::message_type` : raw``}
        ${query.hasAttachment ? raw`and exists (select 1 from message_attachments a where a.message_id = msg.id)` : raw``}
        ${query.before ? raw`and msg.created_at < ${query.before}::timestamptz` : raw``}
        ${query.after ? raw`and msg.created_at > ${query.after}::timestamptz` : raw``}
        ${query.cursor ? raw`and msg.created_at < ${query.cursor}::timestamptz` : raw``}
      order by rank desc, msg.created_at desc
      limit ${query.limit}
    `,
    )) as unknown as Array<{
      id: string;
      conversation_id: string;
      seq: number;
      sender_id: string | null;
      type: string;
      created_at: Date;
      snippet: string;
      rank: number;
    }>;

    return reply.send({
      results: rows.map((r) => ({
        messageId: r.id,
        conversationId: r.conversation_id,
        // `seq` lets the client deep-link with ?around=<seq>, which is how
        // "jump to result" renders the message in context.
        seq: r.seq,
        senderId: r.sender_id,
        type: r.type,
        snippet: r.snippet,
        createdAt: new Date(r.created_at).toISOString(),
      })),
      nextCursor:
        rows.length === query.limit
          ? new Date(rows.at(-1)!.created_at).toISOString()
          : null,
    });
  });

  /** Unified search across conversations, people and messages, for one box. */
  app.get('/', { preHandler: app.authenticateOnboarded }, async (req, reply) => {
    const { q } = req.query as { q?: string };
    if (!q || q.trim().length === 0) {
      return reply.send({ conversations: [], users: [], messages: [] });
    }
    await app.limiter.consume(`user:${req.user.id}`, 'search');

    const term = q.trim();

    const [conversationRows, userRows] = await Promise.all([
      app.db.execute(
        raw`select c.id, c.type, c.title, c.member_count, m.object_key as avatar_key
              from conversation_members cm
              join conversations c on c.id = cm.conversation_id
              left join media m on m.id = c.avatar_media_id
             where cm.user_id = ${req.user.id}::uuid
               and cm.left_at is null
               and c.deleted_at is null
               and c.title ilike ${'%' + term + '%'}
             order by c.last_message_at desc nulls last
             limit 10`,
      ) as unknown as Promise<
        Array<{ id: string; type: string; title: string | null; member_count: number; avatar_key: string | null }>
      >,
      app.db.execute(
        raw`select u.id, u.username, u.display_name, u.is_verified, m.object_key as avatar_key
              from users u
              left join media m on m.id = u.avatar_media_id
             where u.deleted_at is null
               and u.privacy ->> 'discoverableByUsername' = 'true'
               and (u.username ilike ${term + '%'} or u.display_name %> ${term})
               and not exists (
                 select 1 from blocks b
                  where (b.blocker_id = ${req.user.id}::uuid and b.blocked_id = u.id)
                     or (b.blocked_id = ${req.user.id}::uuid and b.blocker_id = u.id)
               )
             limit 10`,
      ) as unknown as Promise<
        Array<{ id: string; username: string | null; display_name: string | null; is_verified: boolean; avatar_key: string | null }>
      >,
    ]);

    return reply.send({
      conversations: conversationRows.map((c) => ({
        id: c.id,
        type: c.type,
        title: c.title,
        memberCount: c.member_count,
        avatarUrl: c.avatar_key ? `${process.env.S3_PUBLIC_BASE_URL}/${c.avatar_key}` : null,
      })),
      users: userRows.map((u) => ({
        id: u.id,
        username: u.username,
        displayName: u.display_name,
        isVerified: u.is_verified,
        avatarUrl: u.avatar_key ? `${process.env.S3_PUBLIC_BASE_URL}/${u.avatar_key}` : null,
      })),
      // Message hits come from /search/messages — kept separate so the unified
      // box can render people and chats immediately without waiting on FTS.
      messages: [],
    });
  });
}
