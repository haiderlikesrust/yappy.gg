import fp from 'fastify-plugin';
import { and, applications, devices, eq, isNull, users, type Application, type User } from '@yappy/db';
import { AppError, ErrorCode, unauthenticated } from '@yappy/shared';
import { hashToken, verifyAccessToken, verifyPortalToken } from '../lib/tokens.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Populated by `authenticate`. Throws rather than leaving this null. */
    user: User;
    deviceId: string;
    /** Set only when the caller authenticated with `Authorization: Bot <token>`. */
    application?: Application;
    /** Set only on developer-portal routes. Never populated by an app token. */
    portalUser: User;
  }
  interface FastifyInstance {
    /** preHandler that requires a valid access token. */
    authenticate: (req: import('fastify').FastifyRequest) => Promise<void>;
    /** preHandler that additionally requires a completed profile. */
    authenticateOnboarded: (req: import('fastify').FastifyRequest) => Promise<void>;
    /** preHandler for the developer portal. Rejects ordinary access tokens. */
    authenticatePortal: (req: import('fastify').FastifyRequest) => Promise<void>;
  }
}

/**
 * Access tokens are self-contained, but we still load the user row.
 *
 * The alternative — trusting the JWT alone — means a suspended or deleted
 * account keeps working for up to the token TTL, and every handler that needs
 * the user's privacy settings has to fetch them anyway. One indexed primary-key
 * read is cheaper than the class of bugs avoided.
 *
 * `tokenEpoch` is the cheap half: bumping it invalidates every outstanding
 * token for that user, which is what "log out of all devices" and a password
 * change both need.
 */
/**
 * How stale `devices.lastActiveAt` is allowed to get before we write again.
 *
 * The stamp exists so Settings can say "last active 3 minutes ago" and so a
 * stolen-session investigation has a trail. Neither needs per-request accuracy,
 * and paying a write for every request to get it is a bad trade: `devices` was
 * the most-updated table in the database — more writes than the app has ever
 * had messages — for a column nothing reads in the hot path.
 */
const ACTIVITY_STAMP_INTERVAL_MS = 5 * 60_000;

/**
 * Last stamp per device, so the common case costs nothing at all.
 *
 * Per-process, which means each API replica writes at most once per device per
 * interval rather than once between them. Three writes an hour per device is
 * still three orders of magnitude below one per request, and the alternative —
 * a shared counter — would cost the round trip it is trying to save.
 */
const lastStamped = new Map<string, { at: number; ip: string }>();

/** Same idea for a bot's `lastUsedAt` — a busy bot was paying one UPDATE per
 *  request for a column that feeds "last used 3 minutes ago" in the portal. */
const botStamped = new Map<string, number>();

/**
 * Bounded so a long-lived process cannot accumulate an entry per device seen.
 *
 * Dropping the whole map is the right eviction here: an entry's only effect is
 * to suppress a write, so losing one costs a single redundant update rather
 * than any correctness. That makes exact LRU bookkeeping pointless overhead.
 */
const STAMP_CACHE_LIMIT = 50_000;

/**
 * The user row behind a bearer token, remembered briefly.
 *
 * This lookup is the most frequent query in the system — one per
 * authenticated request, which is to say one per everything. The row it
 * returns almost never changes between two requests of the same client
 * burst (a boot fires dozens in a second), so the read is cached per
 * (user, device) for a few seconds.
 *
 * The rules that make this safe:
 *   • Every code path in this process that writes the `users` row, revokes a
 *     device, or bumps `tokenEpoch` calls `forgetAuthUser()` after the write
 *     commits, so a change bites on the very next request here. If you add a
 *     writer, add the call.
 *   • The epoch check still runs per request against the token's own claim.
 *   • Cross-process (another API replica changed the row), the TTL bounds the
 *     staleness to ten seconds — the same order as an in-flight request that
 *     authenticated a moment before the change, which no design avoids.
 *   • The cached object is shared between requests; handlers treat `req.user`
 *     as read-only (none mutate it today — keep it that way).
 */
const AUTH_CACHE_TTL_MS = 10_000;
const AUTH_CACHE_LIMIT = 50_000;
const authCache = new Map<string, { user: User; deviceRevokedAt: Date | null; at: number }>();

/**
 * Drop everything cached for one user, on this process, now.
 *
 * Called by every local writer of the auth-relevant state: profile and
 * settings updates (so /users/me never echoes yesterday), password changes,
 * logouts and suspensions (so a revocation is immediate here rather than
 * merely soon).
 */
export function forgetAuthUser(userId: string) {
  for (const key of authCache.keys()) {
    if (key.startsWith(`${userId}:`)) authCache.delete(key);
  }
}

export const authPlugin = fp(async (app) => {
  /**
   * Record that a device was used, if we have not lately.
   *
   * A changed IP always writes regardless of the interval — that is the signal
   * worth having promptly, since it is the one that says a session moved.
   */
  const stampActivity = (deviceId: string, ip: string) => {
    const seen = lastStamped.get(deviceId);
    const now = Date.now();
    if (seen && seen.ip === ip && now - seen.at < ACTIVITY_STAMP_INTERVAL_MS) return;

    if (lastStamped.size >= STAMP_CACHE_LIMIT) lastStamped.clear();
    lastStamped.set(deviceId, { at: now, ip });

    void app.db
      .update(devices)
      .set({ lastActiveAt: new Date(), lastIp: ip })
      .where(eq(devices.id, deviceId))
      .catch(() => {});
  };

  /**
   * `Authorization: Bot <token>`.
   *
   * A bot request resolves to the bot's own user row, so every downstream
   * permission check — membership, the role bitfield, blocks — runs unchanged.
   * There is deliberately no separate authorisation path for bots.
   */
  const authenticateBot = async (req: import('fastify').FastifyRequest, token: string) => {
    const [row] = await app.db
      .select({ application: applications, user: users })
      .from(applications)
      .innerJoin(users, eq(users.id, applications.botUserId))
      .where(and(eq(applications.tokenHash, hashToken(token)), isNull(applications.revokedAt)))
      .limit(1);

    if (!row) throw unauthenticated('Invalid bot token');
    if (row.user.deletedAt) throw unauthenticated('This bot no longer exists');

    req.user = row.user;
    req.application = row.application;
    // A bot has no device. Call endpoints check `req.application` rather than
    // trusting this to be a real device row.
    req.deviceId = row.application.id;

    // "Last used a few minutes ago" does not need per-request accuracy any
    // more than a device's activity stamp does — same throttle, same shape.
    const seen = botStamped.get(row.application.id);
    const now = Date.now();
    if (!seen || now - seen >= ACTIVITY_STAMP_INTERVAL_MS) {
      if (botStamped.size >= STAMP_CACHE_LIMIT) botStamped.clear();
      botStamped.set(row.application.id, now);
      void app.db
        .update(applications)
        .set({ lastUsedAt: new Date() })
        .where(eq(applications.id, row.application.id))
        .catch(() => {});
    }
  };

  const authenticate = async (req: import('fastify').FastifyRequest) => {
    const header = req.headers.authorization;

    if (header?.startsWith('Bot ')) {
      await authenticateBot(req, header.slice(4).trim());
      return;
    }

    if (!header?.startsWith('Bearer ')) throw unauthenticated();

    const token = header.slice(7);
    let claims;
    try {
      claims = await verifyAccessToken(token);
    } catch (err) {
      const expired = err instanceof Error && err.name === 'JWTExpired';
      throw new AppError(
        401,
        expired ? ErrorCode.TokenExpired : ErrorCode.Unauthenticated,
        expired ? 'Access token expired' : 'Invalid access token',
      );
    }

    const cacheKey = `${claims.sub}:${claims.did}`;
    const cached = authCache.get(cacheKey);
    let user: User;
    let deviceRevokedAt: Date | null;
    if (cached && Date.now() - cached.at < AUTH_CACHE_TTL_MS) {
      ({ user, deviceRevokedAt } = cached);
    } else {
      const [row] = await app.db
        .select({ user: users, deviceRevokedAt: devices.revokedAt })
        .from(users)
        .leftJoin(devices, eq(devices.id, claims.did))
        .where(and(eq(users.id, claims.sub), isNull(users.deletedAt)))
        .limit(1);

      if (!row) throw unauthenticated('Account not found');
      if (authCache.size >= AUTH_CACHE_LIMIT) authCache.clear();
      authCache.set(cacheKey, { user: row.user, deviceRevokedAt: row.deviceRevokedAt, at: Date.now() });
      user = row.user;
      deviceRevokedAt = row.deviceRevokedAt;
    }

    // The checks run per request whichever way the row arrived — the cache
    // remembers the row, never a verdict.
    if (deviceRevokedAt) {
      throw new AppError(401, ErrorCode.TokenRevoked, 'This session was signed out');
    }
    if (user.tokenEpoch !== claims.ep) {
      throw new AppError(401, ErrorCode.TokenRevoked, 'Session is no longer valid');
    }

    req.user = user;
    req.deviceId = claims.did;

    // Suspended accounts read but do not write. The suspension path also
    // bumps tokenEpoch (killing existing sessions) and login refuses while
    // suspended — this check is the backstop for any future code path that
    // sets suspendedUntil and forgets those two, because a suspension that
    // still posts is not a suspension.
    if (
      req.user.suspendedUntil &&
      req.user.suspendedUntil > new Date() &&
      req.method !== 'GET' &&
      req.method !== 'HEAD'
    ) {
      throw new AppError(403, ErrorCode.Forbidden, 'This account is suspended');
    }

    // Best-effort activity stamp — never block the request on it, and mostly
    // do not issue it at all.
    stampActivity(claims.did, req.ip);
  };

  app.decorate('authenticate', authenticate);

  /**
   * The portal's own session.
   *
   * Verifying the  claim is what keeps the two worlds apart: a portal
   * token signed with the same secret still cannot call the app's API, and an
   * app token cannot manage applications. Without that check, sharing a secret
   * would silently mean sharing a session.
   */
  app.decorate('authenticatePortal', async (req: import('fastify').FastifyRequest) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw unauthenticated('Portal session required');

    let claims;
    try {
      claims = await verifyPortalToken(header.slice(7));
    } catch {
      throw unauthenticated('Portal session required');
    }

    const [row] = await app.db.select().from(users).where(eq(users.id, claims.sub)).limit(1);
    if (!row || row.deletedAt) throw unauthenticated('Portal session required');
    req.portalUser = row;
  });

  app.decorate('authenticateOnboarded', async (req: import('fastify').FastifyRequest) => {
    await authenticate(req);
    if (!req.user.username) {
      // The username may have been claimed milliseconds ago on another
      // replica — finish onboarding, then the first real request. Refusing
      // off a cached null would 403 a brand-new account, so ask the truth
      // before saying no. Only the un-onboarded ever pay this second read.
      forgetAuthUser(req.user.id);
      await authenticate(req);
      if (!req.user.username) {
        throw new AppError(403, ErrorCode.Forbidden, 'Finish setting up your profile first');
      }
    }
  });
});
