import fp from 'fastify-plugin';
import { ConversationService } from '../services/conversations.js';
import { MessageService } from '../services/messages.js';

declare module 'fastify' {
  interface FastifyInstance {
    messages: MessageService;
    conversations: ConversationService;
    /** Enqueue deferred work. Thin wrapper so services never see pg-boss. */
    enqueue: (
      name: string,
      data: Record<string, unknown>,
      opts?: { delaySeconds?: number },
    ) => Promise<void>;
  }
}

export const servicesPlugin = fp(
  async (app) => {
    const enqueue = async (
      name: string,
      data: Record<string, unknown>,
      opts: { delaySeconds?: number } = {},
    ) => {
      // Enqueue failures must never fail the user-facing request that caused
      // them: the message is already committed, and a lost push is recoverable
      // (the client reconciles on next open) while a 500 is not.
      try {
        await app.boss.send(name, data, {
          retryLimit: 5,
          retryBackoff: true,
          expireInSeconds: 3_600,
          ...(opts.delaySeconds ? { startAfter: opts.delaySeconds } : {}),
        });
      } catch (err) {
        app.log.error({ err, job: name }, 'failed to enqueue job');
      }
    };

    app.decorate('enqueue', enqueue);
    app.decorate('messages', new MessageService({ db: app.db, events: app.events, enqueue }));
    app.decorate('conversations', new ConversationService({ db: app.db, events: app.events, enqueue }));
  },
  { dependencies: [] },
);
