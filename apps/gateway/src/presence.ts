import { sql as raw, uuidArray, type Database } from '@yappy/db';
import { NODE_ID } from './env.js';

/**
 * Presence and typing, without Redis.
 *
 * Presence is a heartbeat table: each connected device holds a row with a TTL
 * that this node refreshes in bulk every 30 seconds. A node that dies stops
 * refreshing and its users age out; a node that restarts cleanly sweeps its own
 * previous rows by `node_id`.
 *
 * Typing is deliberately *not* stored. It has a life of a few seconds, it is
 * pure noise if it arrives late, and writing it to Postgres at the rate people
 * type would be the single heaviest write in the system. It goes straight onto
 * the bus and is forgotten.
 */

const PRESENCE_TTL_SECONDS = 90;
const REFRESH_INTERVAL_MS = 30_000;

export class PresenceTracker {
  /** deviceId → userId, for the devices this node holds. */
  private readonly local = new Map<string, { userId: string; status: string }>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Database,
    private readonly onError: (err: unknown, ctx: string) => void,
  ) {}

  async start(): Promise<void> {
    // Clean up after a previous incarnation of this process before accepting
    // connections, or restarts leave ghosts showing as online.
    await this.db.execute(raw`select sweep_presence(${NODE_ID})`).catch((err) => {
      this.onError(err, 'presence startup sweep');
    });

    this.timer = setInterval(() => {
      void this.refresh();
    }, REFRESH_INTERVAL_MS);
    this.timer.unref();
  }

  async connect(deviceId: string, userId: string, status = 'online'): Promise<void> {
    this.local.set(deviceId, { userId, status });
    await this.db
      .execute(
        raw`insert into presence (device_id, user_id, node_id, status, expires_at, connected_at)
            values (${deviceId}::uuid, ${userId}::uuid, ${NODE_ID}, ${status},
                    now() + make_interval(secs => ${PRESENCE_TTL_SECONDS}), now())
            on conflict (device_id) do update
              set node_id = excluded.node_id,
                  status = excluded.status,
                  expires_at = excluded.expires_at`,
      )
      .catch((err) => this.onError(err, 'presence connect'));

    await this.db
      .execute(
        raw`update users set presence_status = ${status}, last_seen_at = now()
             where id = ${userId}::uuid and presence_status = 'offline'`,
      )
      .catch((err) => this.onError(err, 'presence user status'));
  }

  async setStatus(deviceId: string, status: string): Promise<void> {
    const entry = this.local.get(deviceId);
    if (!entry) return;
    entry.status = status;

    await this.db
      .execute(raw`update presence set status = ${status} where device_id = ${deviceId}::uuid`)
      .catch((err) => this.onError(err, 'presence status'));

    await this.db
      .execute(raw`update users set presence_status = ${status} where id = ${entry.userId}::uuid`)
      .catch((err) => this.onError(err, 'presence user status'));
  }

  /**
   * Disconnect one device. The user only goes offline when their *last* device
   * does — someone reading on their phone with a dead laptop tab is online.
   */
  async disconnect(deviceId: string): Promise<{ userId: string; nowOffline: boolean } | null> {
    const entry = this.local.get(deviceId);
    if (!entry) return null;
    this.local.delete(deviceId);

    try {
      await this.db.execute(raw`delete from presence where device_id = ${deviceId}::uuid`);

      const rows = (await this.db.execute(
        raw`select count(*)::int as remaining from presence
             where user_id = ${entry.userId}::uuid and expires_at > now()`,
      )) as unknown as Array<{ remaining: number }>;

      const nowOffline = (rows[0]?.remaining ?? 0) === 0;
      if (nowOffline) {
        await this.db.execute(
          raw`update users set presence_status = 'offline', last_seen_at = now()
               where id = ${entry.userId}::uuid`,
        );
      }
      return { userId: entry.userId, nowOffline };
    } catch (err) {
      this.onError(err, 'presence disconnect');
      return { userId: entry.userId, nowOffline: false };
    }
  }

  /** Bulk TTL bump for every device this node holds — one statement, not N. */
  private async refresh(): Promise<void> {
    if (this.local.size === 0) return;
    const deviceIds = [...this.local.keys()];
    try {
      await this.db.execute(
        raw`update presence
               set expires_at = now() + make_interval(secs => ${PRESENCE_TTL_SECONDS})
             where device_id = any(${uuidArray(deviceIds)})`,
      );
    } catch (err) {
      this.onError(err, 'presence refresh');
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    // Clean shutdown: drop this node's rows so nobody lingers as online through
    // a rolling deploy.
    await this.db.execute(raw`select sweep_presence(${NODE_ID})`).catch(() => {});
    this.local.clear();
  }

  get count(): number {
    return this.local.size;
  }
}
