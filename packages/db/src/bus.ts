import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { createListener } from './index.js';

/**
 * Event bus on top of Postgres LISTEN/NOTIFY.
 *
 * This is the piece Redis would normally own. The interface is deliberately
 * narrow — `publish`, `subscribe`, `unsubscribe` — so swapping in a Redis or
 * NATS implementation later is one file, not a refactor.
 *
 * What you get from Postgres that Redis pub/sub does not give you:
 *   • NOTIFY is transactional. Publishing inside the send transaction means the
 *     event fires if and only if the message actually committed. With Redis you
 *     need an outbox to get the same guarantee.
 *
 * What you give up, and how it is handled here:
 *   • 8000-byte payload cap → oversized events spill to `bus_overflow` and the
 *     notification carries a pointer.
 *   • No delivery guarantee to a disconnected listener → the gateway does not
 *     rely on the bus for correctness. Every client reconciles with `seq` via
 *     the sync endpoint on reconnect; the bus is a latency optimisation.
 *   • Throughput ceiling. A single Postgres handles low tens of thousands of
 *     notifies/second comfortably. Past that, shard by topic across replicas or
 *     move to Redis. See docs/ARCHITECTURE.md §Scaling out.
 */

export interface BusMessage {
  /** Event name from @yappy/shared `Event`. */
  t: string;
  /** Event body. */
  d: unknown;
  /** Excluded recipients — normally the actor, whose client already applied
   *  the change optimistically. */
  exclude?: string[];
  /**
   * Excluded *device*, when only the one that made the change should skip it.
   *
   * `exclude` is by account, which for a message meant every device that
   * account owns: sending from the laptop left the phone with no event at all
   * until it refetched. The client that already applied the change is a single
   * device, so that is what gets skipped.
   */
  excludeDevice?: string;
  /** Set by the publisher for tracing. */
  origin?: string;
}

export type BusHandler = (msg: BusMessage, topic: string) => void;

/**
 * Minimal surface the bus needs to emit an event, so a publish can join an
 * in-flight transaction regardless of whether the caller holds a raw
 * `postgres.Sql` or a Drizzle transaction handle. Adapters below.
 */
export interface BusExecutor {
  notify(channel: string, payload: string): Promise<void>;
  writeOverflow(id: string, topic: string, payload: string): Promise<void>;
}

export function sqlExecutor(sql: postgres.Sql): BusExecutor {
  return {
    async notify(channel, payload) {
      await sql`select pg_notify(${channel}, ${payload})`;
    },
    async writeOverflow(id, topic, payload) {
      await sql`
        insert into bus_overflow (id, topic, payload, created_at, expires_at)
        values (${id}, ${topic}, ${payload}::jsonb, now(), now() + interval '60 seconds')
      `;
    },
  };
}

/**
 * Adapter for a Drizzle transaction. Takes the `execute` method rather than the
 * transaction object so this package does not have to depend on Drizzle's
 * transaction generics.
 */
export function drizzleExecutor(
  execute: (query: unknown) => Promise<unknown>,
  raw: (strings: TemplateStringsArray, ...values: unknown[]) => unknown,
): BusExecutor {
  return {
    async notify(channel, payload) {
      await execute(raw`select pg_notify(${channel}, ${payload})`);
    },
    async writeOverflow(id, topic, payload) {
      await execute(
        raw`insert into bus_overflow (id, topic, payload, created_at, expires_at)
            values (${id}, ${topic}, ${payload}::jsonb, now(), now() + interval '60 seconds')`,
      );
    },
  };
}

/** Postgres channel names are identifiers: ≤63 bytes, no dashes. */
export const topicForConversation = (id: string) => `c_${id.replace(/-/g, '')}`;
export const topicForUser = (id: string) => `u_${id.replace(/-/g, '')}`;
/** Cluster-wide control channel: deploys, forced reconnects, config reloads. */
export const TOPIC_CONTROL = 'yappy_control';

const NOTIFY_LIMIT = 7_000; // 8000 minus headroom for the envelope

interface Envelope {
  v: 1;
  t: string;
  d?: unknown;
  /** Present instead of `d` when the payload spilled to bus_overflow. */
  ref?: string;
  x?: string[];
  xd?: string;
  o?: string;
}

export class PgBus {
  private listener: postgres.Sql | null = null;
  private readonly handlers = new Map<string, Set<BusHandler>>();
  private readonly unlisteners = new Map<string, () => Promise<void>>();

  constructor(
    private readonly url: string,
    /** Pool used for publishing and for overflow reads/writes. */
    private readonly pool: postgres.Sql,
    private readonly onError: (err: unknown, ctx: string) => void = () => {},
  ) {}

  private ensureListener(): postgres.Sql {
    this.listener ??= createListener(this.url);
    return this.listener;
  }

  /**
   * Publish to a topic. Pass an executor bound to an in-flight transaction to
   * make the notify part of it — the event then fires on commit and never on
   * rollback, which is what makes an outbox unnecessary here.
   */
  async publish(topic: string, msg: BusMessage, exec?: BusExecutor): Promise<void> {
    const executor = exec ?? sqlExecutor(this.pool);
    const envelope: Envelope = {
      v: 1,
      t: msg.t,
      d: msg.d,
      x: msg.exclude,
      xd: msg.excludeDevice,
      o: msg.origin,
    };
    let body = JSON.stringify(envelope);

    if (Buffer.byteLength(body) > NOTIFY_LIMIT) {
      const ref = randomUUID();
      await executor.writeOverflow(ref, topic, JSON.stringify({ d: msg.d }));
      body = JSON.stringify({
        v: 1,
        t: msg.t,
        ref,
        x: msg.exclude,
        xd: msg.excludeDevice,
        o: msg.origin,
      } satisfies Envelope);
    }

    await executor.notify(topic, body);
  }

  /** Publish the same event to many topics. */
  async publishMany(topics: string[], msg: BusMessage, exec?: BusExecutor): Promise<void> {
    if (topics.length === 0) return;
    // Deduplicate: a user can be reachable via both their user topic and a
    // conversation topic, and delivering twice makes clients flicker.
    await Promise.all([...new Set(topics)].map((topic) => this.publish(topic, msg, exec)));
  }

  async subscribe(topic: string, handler: BusHandler): Promise<void> {
    let set = this.handlers.get(topic);
    if (!set) {
      set = new Set();
      this.handlers.set(topic, set);

      const listener = this.ensureListener();
      // postgres.js re-issues LISTEN automatically after a reconnect, which
      // matters: a silently dead listener produces no error, just an app where
      // messages stop arriving.
      const sub = await listener.listen(topic, (raw) => {
        void this.dispatch(topic, raw);
      });
      this.unlisteners.set(topic, () => sub.unlisten());
    }
    set.add(handler);
  }

  async unsubscribe(topic: string, handler?: BusHandler): Promise<void> {
    const set = this.handlers.get(topic);
    if (!set) return;
    if (handler) set.delete(handler);
    else set.clear();

    if (set.size === 0) {
      this.handlers.delete(topic);
      const stop = this.unlisteners.get(topic);
      this.unlisteners.delete(topic);
      await stop?.().catch((err) => this.onError(err, `unlisten ${topic}`));
    }
  }

  private async dispatch(topic: string, raw: string): Promise<void> {
    const set = this.handlers.get(topic);
    if (!set || set.size === 0) return;

    let envelope: Envelope;
    try {
      envelope = JSON.parse(raw) as Envelope;
    } catch (err) {
      this.onError(err, `bad envelope on ${topic}`);
      return;
    }

    let data = envelope.d;
    if (envelope.ref) {
      try {
        // Read, do not consume.
        //
        // Every replica LISTENing on this topic gets the NOTIFY, and each one
        // has its own sessions to deliver to. Deleting the row meant the first
        // replica to arrive took the body and every other replica found nothing
        // and returned — so an oversized event reached roughly one Nth of the
        // people who should have got it, silently, with the early return
        // commented as if it were expected. The row already carries a 60-second
        // `expires_at` and the maintenance sweeper collects it.
        const rows = await this.pool<{ payload: { d: unknown } }[]>`
          select payload from bus_overflow where id = ${envelope.ref}
        `;
        if (rows.length === 0) {
          this.onError(new Error('overflow row missing or expired'), `overflow ${envelope.ref}`);
          return;
        }
        data = rows[0]!.payload.d;
      } catch (err) {
        this.onError(err, `overflow fetch ${envelope.ref}`);
        return;
      }
    }

    const msg: BusMessage = {
      t: envelope.t,
      d: data,
      exclude: envelope.x,
      excludeDevice: envelope.xd,
      origin: envelope.o,
    };
    for (const handler of set) {
      try {
        handler(msg, topic);
      } catch (err) {
        this.onError(err, `handler for ${topic}`);
      }
    }
  }

  get subscribedTopics(): string[] {
    return [...this.handlers.keys()];
  }

  async close(): Promise<void> {
    this.handlers.clear();
    for (const stop of this.unlisteners.values()) await stop().catch(() => {});
    this.unlisteners.clear();
    await this.listener?.end({ timeout: 5 });
    this.listener = null;
  }
}
