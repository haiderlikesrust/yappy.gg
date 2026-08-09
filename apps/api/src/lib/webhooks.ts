import { sql as raw } from '@yappy/db';
import type { FastifyInstance } from 'fastify';

/**
 * Fan a delivered message out to the webhook bots in its conversation.
 *
 * Enqueued, not sent inline: a webhook is someone else's server, and a slow
 * one must never add latency to a person's message send. pg-boss retries with
 * backoff, so a bot that is briefly down gets the event late rather than
 * never — and a bot that is down for good stops costing anything once the
 * retry budget is spent.
 *
 * The sending bot itself is excluded. Echoing a bot's own message back to it
 * is the classic infinite-loop starter kit.
 */
export async function fanoutMessageToBots(
  app: FastifyInstance,
  conversationId: string,
  message: unknown,
  senderId: string | null,
): Promise<void> {
  const rows = (await app.db.execute(raw`
    select a.id
      from conversations c
      join conversation_members m
        on m.conversation_id = coalesce(c.parent_id, c.id) and m.left_at is null
      join users u on u.id = m.user_id and u.is_bot and u.deleted_at is null
      join applications a on a.bot_user_id = u.id and a.revoked_at is null
     where c.id = ${conversationId}::uuid
       and a.webhook_url is not null
       and u.id is distinct from ${senderId}
  `)) as unknown as Array<{ id: string }>;

  for (const row of rows) {
    await app.boss.send(
      'bot.event',
      { applicationId: row.id, type: 'message.created', data: { conversationId, message } },
      { retryLimit: 5, retryDelay: 30, retryBackoff: true },
    );
  }
}

/** An interaction press, delivered the same way. */
export async function sendInteractionToBot(
  app: FastifyInstance,
  applicationId: string,
  data: Record<string, unknown>,
): Promise<void> {
  await app.boss.send(
    'bot.event',
    { applicationId, type: 'interaction.pressed', data },
    { retryLimit: 5, retryDelay: 30, retryBackoff: true },
  );
}
