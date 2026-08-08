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
export const authPlugin = fp(async (app) => {
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

    void app.db
      .update(applications)
      .set({ lastUsedAt: new Date() })
      .where(eq(applications.id, row.application.id))
      .catch(() => {});
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

    const [row] = await app.db
      .select({ user: users, deviceRevokedAt: devices.revokedAt })
      .from(users)
      .leftJoin(devices, eq(devices.id, claims.did))
      .where(and(eq(users.id, claims.sub), isNull(users.deletedAt)))
      .limit(1);

    if (!row) throw unauthenticated('Account not found');
    if (row.deviceRevokedAt) {
      throw new AppError(401, ErrorCode.TokenRevoked, 'This session was signed out');
    }
    if (row.user.tokenEpoch !== claims.ep) {
      throw new AppError(401, ErrorCode.TokenRevoked, 'Session is no longer valid');
    }

    req.user = row.user;
    req.deviceId = claims.did;

    // Best-effort activity stamp — never block the request on it.
    void app.db
      .update(devices)
      .set({ lastActiveAt: new Date(), lastIp: req.ip })
      .where(eq(devices.id, claims.did))
      .catch(() => {});
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
      throw new AppError(403, ErrorCode.Forbidden, 'Finish setting up your profile first');
    }
  });
});
