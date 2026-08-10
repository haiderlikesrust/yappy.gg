import { eq, messages } from '@yappy/db';
import { Event } from '@yappy/shared';
import fp from 'fastify-plugin';

export interface RehydrateJob {
  messageId: string;
  conversationId: string;
}

/**
 * Re-publish a message that changed underneath the API.
 *
 * The second place the API consumes a queue rather than producing into it, and
 * for the same reason as `yapper.dm`: the shape a client expects on
 * `message.update` is a fully hydrated message — sender, attachments, poll
 * state, reactions, link previews — and hydration is `MessageService`, which
 * lives here.
 *
 * The worker can finish a link preview, but a payload it builds by hand is not
 * that shape, and on this particular event a partial payload is *worse than
 * silence*: both clients decode `message.update` into a `Message` and replace
 * the one they hold, so every field the payload omits is reset to its default.
 * That is the bug this exists to close — pasting a link blanked your own
 * message until you left the conversation and came back.
 *
 * Hydrated as the sender, because `hydrateOne` takes a viewer and there isn't
 * one: this is a broadcast. The sender is the least wrong choice, and the
 * viewer-dependent fields it affects (`myReactions`, `isPinned`) are ones every
 * client already reconciles from its own state. The edit path at
 * `MessageService.edit` makes the same trade.
 */
export const messageJobsPlugin = fp(
  async (app) => {
    await app.boss.work<RehydrateJob>('message.rehydrate', { batchSize: 10 }, async (jobs) => {
      for (const job of jobs) {
        const { messageId } = job.data;
        try {
          const [row] = await app.db
            .select()
            .from(messages)
            .where(eq(messages.id, messageId))
            .limit(1);

          // Deleted, or swept, between the preview being fetched and this
          // running. Nothing to say, and saying it would resurrect a tombstone.
          if (!row || row.deletedAt) continue;

          const payload = await app.messages.hydrateOne(row, row.senderId ?? messageId);
          await app.events.toConversation(row.conversationId, Event.MessageUpdate, payload);
        } catch (err) {
          app.log.error({ err, messageId }, 'message rehydrate failed');
        }
      }
    });

    app.log.info('message rehydrate worker started');
  },
  { name: 'message-jobs', dependencies: [] },
);
