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
  private readonly local = new Map<
    string,
    { userId: string; status: string; viewing?: string | null }
  >();
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
                  expires_at = excluded.expires_at,
                  -- A reconnecting device is in no room until it says so, or a
                  -- crash mid-chat leaves a ghost sitting in that room forever.
                  viewing_conversation_id = null`,
      )
      .catch((err) => this.onError(err, 'presence connect'));

    await this.db
      .execute(
        raw`update users set presence_status = ${status}, last_seen_at = now()
             where id = ${userId}::uuid and presence_status = 'offline'`,
      )
      .catch((err) => this.onError(err, 'presence user status'));
  }

  /**
   * @param customStatus `undefined` leaves the stored text alone; `null` clears
   *   it. The distinction matters because a plain status flip ("idle") must not
   *   wipe the text someone set an hour ago, while clearing has to be possible.
   */
  async setStatus(deviceId: string, status: string, customStatus?: string | null): Promise<void> {
    const entry = this.local.get(deviceId);
    if (!entry) return;
    entry.status = status;

    await this.db
      .execute(raw`update presence set status = ${status} where device_id = ${deviceId}::uuid`)
      .catch((err) => this.onError(err, 'presence status'));

    // The custom status lives on `users`, not `presence`: it is an account-level
    // thing that outlives any one socket, and it used to be accepted here and
    // then dropped on the floor — set over the socket, gone on reconnect.
    if (customStatus === undefined) {
      await this.db
        .execute(raw`update users set presence_status = ${status} where id = ${entry.userId}::uuid`)
        .catch((err) => this.onError(err, 'presence user status'));
      return;
    }

    await this.db
      .execute(
        raw`update users
               set presence_status = ${status},
                   custom_status = ${customStatus},
                   custom_status_expires_at = null
             where id = ${entry.userId}::uuid`,
      )
      .catch((err) => this.onError(err, 'presence user status'));
  }

  /**
   * Record which conversation this device is looking at, and report whether
   * that actually changed — the caller only broadcasts on a real transition,
   * so a screen that re-sends the same room on every recomposition is free.
   */
  async setViewing(
    deviceId: string,
    conversationId: string | null,
  ): Promise<{ left: string | null; entered: string | null }> {
    const entry = this.local.get(deviceId);
    if (!entry) return { left: null, entered: null };

    const previous = entry.viewing ?? null;
    if (previous === conversationId) return { left: null, entered: null };
    entry.viewing = conversationId;

    await this.db
      .execute(
        raw`update presence set viewing_conversation_id = ${conversationId}::uuid
             where device_id = ${deviceId}::uuid`,
      )
      .catch((err) => this.onError(err, 'presence viewing'));

    return { left: previous, entered: conversationId };
  }

  /**
   * Everyone currently looking at a conversation, one row per person.
   *
   * Reads the shared table rather than any node's memory, so the answer is the
   * same from every node and survives one of them dying. Members who have
   * turned ambient presence off are excluded here rather than at the caller,
   * so no future call site can forget the privacy check.
   */
  async viewersOf(conversationId: string): Promise<string[]> {
    const rows = (await this.db
      .execute(
        raw`select distinct p.user_id
              from presence p
              join users u on u.id = p.user_id
             where p.viewing_conversation_id = ${conversationId}::uuid
               and p.expires_at > now()
               and coalesce((u.privacy ->> 'ambientPresence')::boolean, true)`,
      )
      .catch((err) => {
        this.onError(err, 'presence viewers');
        return [] as unknown;
      })) as unknown as Array<{ user_id: string }>;
    return rows.map((r) => r.user_id);
  }

  /**
   * The answer per user, remembered briefly.
   *
   * Every Viewing command asked the users table for a preference that almost
   * nobody ever changes — switching rooms is one of the chattiest things a
   * client does. Thirty seconds of memory means toggling the setting takes
   * up to that long to stop the *announcements*; what people can see is
   * unaffected, because `viewersOf` reads the live column every time.
   */
  private readonly ambientPref = new Map<string, { allowed: boolean; at: number }>();

  /** Whether this user has opted into appearing in "here now" strips. */
  async allowsAmbientPresence(userId: string): Promise<boolean> {
    const cached = this.ambientPref.get(userId);
    if (cached && Date.now() - cached.at < 30_000) return cached.allowed;

    const rows = (await this.db
      .execute(
        raw`select coalesce((privacy ->> 'ambientPresence')::boolean, true) as allowed
              from users where id = ${userId}::uuid`,
      )
      .catch((err) => {
        this.onError(err, 'presence ambient pref');
        return [] as unknown;
      })) as unknown as Array<{ allowed: boolean }>;
    const allowed = rows[0]?.allowed ?? true;
    // Losing an entry costs one redundant read, so wholesale eviction is fine.
    if (this.ambientPref.size >= 50_000) this.ambientPref.clear();
    this.ambientPref.set(userId, { allowed, at: Date.now() });
    return allowed;
  }

  /**
   * Disconnect one device. The user only goes offline when their *last* device
   * does — someone reading on their phone with a dead laptop tab is online.
   */
  async disconnect(
    deviceId: string,
  ): Promise<{ userId: string; nowOffline: boolean; wasViewing: string | null } | null> {
    const entry = this.local.get(deviceId);
    if (!entry) return null;
    const wasViewing = entry.viewing ?? null;
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
      return { userId: entry.userId, nowOffline, wasViewing };
    } catch (err) {
      this.onError(err, 'presence disconnect');
      return { userId: entry.userId, nowOffline: false, wasViewing };
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
