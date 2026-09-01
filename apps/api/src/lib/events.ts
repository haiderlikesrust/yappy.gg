import {
  PgBus,
  and,
  conversationMembers,
  eq,
  isNull,
  sql as raw,
  textArray,
  topicForConversation,
  topicForUser,
  type BusExecutor,
  type Database,
  type Executor,
} from '@yappy/db';
import type { EventName } from '@yappy/shared';

/**
 * Publishing side of the realtime layer.
 *
 * Fan-out strategy, and why:
 *
 *   • Conversation events (a message, a reaction, a pin) publish **once** to
 *     the conversation topic. A gateway subscribes to that topic while it holds
 *     at least one connected member. Publishing once is O(1) writes regardless
 *     of group size — the alternative, one notify per member, makes a
 *     5,000-person group a 5,000-write event.
 *
 *   • Personal events (a follow, a block, another of your devices changing a
 *     setting) publish to the user topic, which every gateway holding one of
 *     that user's sockets subscribes to.
 *
 * Both are best-effort. Correctness comes from `seq` reconciliation on
 * reconnect, never from the bus.
 */

/** Wrap a Drizzle transaction so the notify commits with it. */
export function txExecutor(tx: Executor): BusExecutor {
  return {
    async notify(channel, payload) {
      await tx.execute(raw`select pg_notify(${channel}, ${payload})`);
    },
    async notifyMany(channels, payload) {
      await tx.execute(raw`select pg_notify(t, ${payload}) from unnest(${textArray(channels)}) t`);
    },
    async writeOverflow(id, topic, payload) {
      await tx.execute(
        raw`insert into bus_overflow (id, topic, payload, created_at, expires_at)
            values (${id}::uuid, ${topic}, ${payload}::jsonb, now(), now() + interval '60 seconds')`,
      );
    },
  };
}

export interface PublishOptions {
  /** Recipients to skip — normally the actor, whose client already applied the
   *  change optimistically. */
  exclude?: string[];
  /**
   * The one device to skip, when the account's other devices still need this.
   *
   * Prefer this over `exclude: [actorId]` for anything a client applies
   * optimistically: excluding the account skipped the sender's phone as well
   * as the laptop they sent from, which is why a message sent on one showed up
   * on the other only after a refetch.
   */
  excludeDevice?: string;
  /** Pass to bind the publish to a transaction. */
  exec?: BusExecutor;
}

export class EventPublisher {
  constructor(
    private readonly bus: PgBus,
    private readonly db: Database,
  ) {}

  async toConversation(
    conversationId: string,
    event: EventName,
    data: unknown,
    opts: PublishOptions = {},
  ): Promise<void> {
    await this.bus.publish(
      topicForConversation(conversationId),
      { t: event, d: data, exclude: opts.exclude, excludeDevice: opts.excludeDevice },
      opts.exec,
    );
  }

  async toUser(userId: string, event: EventName, data: unknown, opts: PublishOptions = {}): Promise<void> {
    await this.bus.publish(
      topicForUser(userId),
      { t: event, d: data, exclude: opts.exclude, excludeDevice: opts.excludeDevice },
      opts.exec,
    );
  }

  async toUsers(
    userIds: string[],
    event: EventName,
    data: unknown,
    opts: PublishOptions = {},
  ): Promise<void> {
    await this.bus.publishMany(
      userIds.map(topicForUser),
      { t: event, d: data, exclude: opts.exclude, excludeDevice: opts.excludeDevice },
      opts.exec,
    );
  }

  /**
   * For events a member must receive even when their gateway is not subscribed
   * to the conversation topic — chiefly `conversation.create`, where the client
   * does not yet know the conversation exists.
   */
  async toConversationMembers(
    conversationId: string,
    event: EventName,
    data: unknown,
    opts: PublishOptions = {},
  ): Promise<void> {
    const rows = await this.db
      .select({ userId: conversationMembers.userId })
      .from(conversationMembers)
      .where(
        and(eq(conversationMembers.conversationId, conversationId), isNull(conversationMembers.leftAt)),
      );
    await this.toUsers(
      rows.map((r) => r.userId),
      event,
      data,
      opts,
    );
  }
}
