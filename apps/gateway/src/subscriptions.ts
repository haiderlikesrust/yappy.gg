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
    /**
     * A device's session was revoked (sign-out, "sign out other devices",
     * the sessions screen). The server owns closing and forgetting a
     * session; this manager only knows which sockets belong to the device.
     */
    private readonly onSessionRevoked: (session: Session) => void,
  ) {}

  private handlerFor(topic: string) {
    return (msg: BusMessage) => {
      const sessions = this.topics.get(topic);
      if (!sessions) return;

      const excluded = msg.exclude ? new Set(msg.exclude) : null;
      const excludedDevice = msg.excludeDevice ?? null;

      // Serialised once for the whole room. Every recipient's frame differs
      // only in its sequence number, and encoding per session meant a busy
      // group paid `JSON.stringify` over the same message once per member.
      // `null` means the payload was `undefined`, which cannot be spliced —
      // those fall through to the ordinary path.
      const prepared = prepareDispatch(msg.t, msg.d);

      for (const session of sessions) {
        // The actor's own client already applied this optimistically. Skipping
        // it prevents the "message appears, jumps, reappears" flicker.
        //
        // By device where the publisher named one: the account's *other*
        // devices applied nothing and need the event like anybody else.
        if (excluded?.has(session.user.id)) continue;
        if (excludedDevice && session.user.deviceId === excludedDevice) continue;
        if (prepared) session.dispatchPrepared(prepared);
        else session.dispatch(msg.t as EventName, msg.d);
      }

      /*
       * Revocation. Nothing used to remove a subscription except the client
       * asking or the session dying, so a kicked member's socket kept
       * receiving the room's every message — fully hydrated — for as long as
       * it heartbeated, and could still type, ack and query presence there.
       * The event is delivered first (the client needs it to update), then
       * the subscription goes.
       */
      const data = msg.d as
        | { conversationId?: string; userId?: string; id?: string; deviceId?: string; revoked?: boolean }
        | undefined;
      if (msg.t === 'member.remove' && data?.conversationId && data.userId) {
        for (const session of [...sessions]) {
          if (session.user.id === data.userId) this.dropConversation(session, data.conversationId);
        }
      } else if (msg.t === 'conversation.delete' && data?.id) {
        // Arrives on the leaver's user topic (leave, kick) or on every
        // member's user topic (delete), so the sessions here are exactly
        // the ones to evict.
        for (const session of [...sessions]) this.dropConversation(session, data.id);
      } else if (msg.t === 'session.update' && data?.revoked && data.deviceId) {
        // The same hole, one level up: the API has published this event on
        // every revoke since the sessions screen existed, and nothing here
        // listened. "Signed out 12 other devices" left all twelve sockets
        // streaming every new message until they happened to drop and try
        // to resume. The frame goes out first so the device learns why.
        for (const session of [...sessions]) {
          if (session.user.deviceId === data.deviceId) this.onSessionRevoked(session);
        }
      }
    };
  }

  /**
   * Drop one conversation from a session — and, when it is a space, every
   * channel of it this session holds. The grant came through the space, so
   * the revocation has to as well.
   */
  dropConversation(session: Session, conversationId: string): void {
    const gone = [conversationId];
    for (const [id, parent] of session.parentOf) {
      if (parent === conversationId) gone.push(id);
    }
    for (const id of gone) {
      if (!session.conversations.has(id)) continue;
      this.remove(topicForConversation(id), session);
      session.conversations.delete(id);
      session.parentOf.delete(id);
    }
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

  async addConversations(
    session: Session,
    conversations: Array<{ id: string; parentId: string | null }>,
  ): Promise<void> {
    // Subscribe in parallel but bounded — a user in 500 groups should not open
    // 500 concurrent LISTENs on connect.
    const batchSize = 32;
    for (let i = 0; i < conversations.length; i += batchSize) {
      await Promise.all(
        conversations.slice(i, i + batchSize).map(async ({ id, parentId }) => {
          await this.add(topicForConversation(id), session);
          session.conversations.add(id);
          session.parentOf.set(id, parentId);
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
    session.parentOf.clear();
  }

  get stats() {
    return {
      topics: this.topics.size,
      pendingUnsubscribes: this.pendingUnsubscribe.size,
    };
  }
}
