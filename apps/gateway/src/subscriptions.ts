import { PgBus, topicForConversation, topicForUser, type BusMessage } from '@yappy/db';
import { prepareDispatch, type EventName } from '@yappy/shared';
import type { Session } from './session.js';

/**
 * Reference-counted bus subscriptions.
 *
 * A node subscribes to a conversation topic once, no matter how many of its
 * sockets are members, and unsubscribes when the last one goes. Without the
 * refcount, the second user in a group to disconnect would silently unsubscribe
 * the first — a bug that only shows up under real concurrency and is miserable
 * to track down.
 *
 * Unsubscribes are also *deferred*. Mobile clients reconnect within seconds all
 * the time, and churning LISTEN/UNLISTEN on every subway tunnel is pure waste.
 */
const UNSUBSCRIBE_GRACE_MS = 30_000;

export class SubscriptionManager {
  /** topic → sessions currently interested */
  private readonly topics = new Map<string, Set<Session>>();
  private readonly pendingUnsubscribe = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly bus: PgBus,
    private readonly onError: (err: unknown, ctx: string) => void,
  ) {}

  private handlerFor(topic: string) {
    return (msg: BusMessage) => {
      const sessions = this.topics.get(topic);
      if (!sessions) return;

      const excluded = msg.exclude ? new Set(msg.exclude) : null;

      // Serialised once for the whole room. Every recipient's frame differs
      // only in its sequence number, and encoding per session meant a busy
      // group paid `JSON.stringify` over the same message once per member.
      // `null` means the payload was `undefined`, which cannot be spliced —
      // those fall through to the ordinary path.
      const prepared = prepareDispatch(msg.t, msg.d);

      for (const session of sessions) {
        // The actor's own client already applied this optimistically. Skipping
        // it prevents the "message appears, jumps, reappears" flicker.
        if (excluded?.has(session.user.id)) continue;
        if (prepared) session.dispatchPrepared(prepared);
        else session.dispatch(msg.t as EventName, msg.d);
      }
    };
  }

  async add(topic: string, session: Session): Promise<void> {
    const pending = this.pendingUnsubscribe.get(topic);
    if (pending) {
      clearTimeout(pending);
      this.pendingUnsubscribe.delete(topic);
    }

    let sessions = this.topics.get(topic);
    if (!sessions) {
      sessions = new Set();
      this.topics.set(topic, sessions);
      try {
        await this.bus.subscribe(topic, this.handlerFor(topic));
      } catch (err) {
        this.topics.delete(topic);
        this.onError(err, `subscribe ${topic}`);
        throw err;
      }
    }
    sessions.add(session);
  }

  remove(topic: string, session: Session): void {
    const sessions = this.topics.get(topic);
    if (!sessions) return;
    sessions.delete(session);
    if (sessions.size > 0) return;

    const timer = setTimeout(() => {
      this.pendingUnsubscribe.delete(topic);
      const current = this.topics.get(topic);
      if (current && current.size > 0) return; // someone rejoined in the meantime
      this.topics.delete(topic);
      void this.bus.unsubscribe(topic).catch((err) => this.onError(err, `unsubscribe ${topic}`));
    }, UNSUBSCRIBE_GRACE_MS);

    timer.unref();
    this.pendingUnsubscribe.set(topic, timer);
  }

  async addUser(session: Session): Promise<void> {
    await this.add(topicForUser(session.user.id), session);
  }

  async addConversations(session: Session, conversationIds: string[]): Promise<void> {
    // Subscribe in parallel but bounded — a user in 500 groups should not open
    // 500 concurrent LISTENs on connect.
    const batchSize = 32;
    for (let i = 0; i < conversationIds.length; i += batchSize) {
      await Promise.all(
        conversationIds.slice(i, i + batchSize).map(async (id) => {
          await this.add(topicForConversation(id), session);
          session.conversations.add(id);
        }),
      );
    }
  }

  removeAll(session: Session): void {
    this.remove(topicForUser(session.user.id), session);
    for (const id of session.conversations) {
      this.remove(topicForConversation(id), session);
    }
    session.conversations.clear();
  }

  get stats() {
    return {
      topics: this.topics.size,
      pendingUnsubscribes: this.pendingUnsubscribe.size,
    };
  }
}
