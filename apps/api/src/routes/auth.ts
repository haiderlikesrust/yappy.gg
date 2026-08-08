import { and, auditLog, desc, devices, eq, gt, isNull, otpChallenges, users, sql as raw } from '@yappy/db';
import {
  AppError,
  ErrorCode,
  completeProfileBody,
  newId,
  refreshBody,
  requestOtpBody,
  unauthenticated,
  verifyOtpBody,
} from '@yappy/shared';
import type { FastifyInstance } from 'fastify';
import { env } from '../env.js';
import { toSelf } from '../lib/serialize.js';
import {
  hashOtp,
  hashToken,
  newOtpCode,
  newRefreshToken,
  signAccessToken,
  signGatewayTicket,
} from '../lib/tokens.js';

/**
 * Authentication.
 *
 * OTP-first, because that is what a phone-book social app needs and it removes
 * password reset, credential stuffing and password storage from the threat
 * model entirely. Sign in with Apple is included because the App Store requires
 * it wherever any third-party login is offered.
 */
/**
 * How long a just-rotated refresh token stays usable. Long enough to cover a
 * dropped response and a client retry; short enough that a token lifted from a
 * log or a proxy cache is already dead.
 */
const REFRESH_RETRY_GRACE_SECONDS = 60;

export async function authRoutes(app: FastifyInstance) {
  const issueSession = async (
    userId: string,
    tokenEpoch: number,
    client: { platform: string; version: string; os?: string; device?: string; pushToken?: string },
    ip: string,
    userAgent?: string,
  ) => {
    const deviceId = newId();
    const refresh = newRefreshToken();

    await app.db.insert(devices).values({
      id: deviceId,
      userId,
      platform: client.platform,
      appVersion: client.version,
      osVersion: client.os ?? null,
      name: client.device ?? null,
      refreshTokenHash: refresh.hash,
      refreshTokenExpiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL * 1000),
      pushToken: client.pushToken ?? null,
      lastIp: ip,
      lastUserAgent: userAgent ?? null,
    });

    await app.db.insert(auditLog).values({
      id: newId(),
      userId,
      action: 'session.created',
      ip,
      userAgent: userAgent ?? null,
      metadata: { deviceId, platform: client.platform },
    });

    return {
      accessToken: await signAccessToken(userId, deviceId, tokenEpoch),
      refreshToken: refresh.token,
      expiresIn: env.ACCESS_TOKEN_TTL,
      deviceId,
    };
  };

  // ── OTP ────────────────────────────────────────────────────────────────────

  app.post('/otp/request', async (req, reply) => {
    const body = requestOtpBody.parse(req.body);
    const identifier = (body.phone ?? body.email)!.toLowerCase();
    const channel = body.phone ? 'sms' : 'email';

    // Limited on both the identifier and the source IP: one stops a single
    // number being spammed, the other stops one host enumerating many.
    await app.limiter.consume(`id:${identifier}`, 'auth.otp.request');
    await app.limiter.consume(`ip:${req.ip}`, 'auth.otp.request', 0.34);

    const code = newOtpCode();

    await app.db.transaction(async (tx) => {
      // Supersede any outstanding challenge so an attacker cannot keep several
      // live codes in flight for the same identifier.
      await tx
        .update(otpChallenges)
        .set({ consumedAt: new Date() })
        .where(
          and(
            eq(otpChallenges.identifier, identifier),
            eq(otpChallenges.purpose, body.purpose),
            isNull(otpChallenges.consumedAt),
          ),
        );

      await tx.insert(otpChallenges).values({
        id: newId(),
        identifier,
        channel,
        purpose: body.purpose,
        codeHash: hashOtp(code, identifier),
        maxAttempts: env.OTP_MAX_ATTEMPTS,
        expiresAt: new Date(Date.now() + env.OTP_TTL * 1000),
        requestIp: req.ip,
      });
    });

    await app.boss.send('otp.deliver', { identifier, channel, code, purpose: body.purpose });

    // Never reveal whether the identifier is registered — that turns this
    // endpoint into an account-existence oracle.
    return reply.send({ sent: true, expiresIn: env.OTP_TTL, channel });
  });

  app.post('/otp/verify', async (req, reply) => {
    const body = verifyOtpBody.parse(req.body);
    const identifier = (body.phone ?? body.email)!.toLowerCase();

    await app.limiter.consume(`id:${identifier}`, 'auth.otp.verify');

    const [challenge] = await app.db
      .select()
      .from(otpChallenges)
      .where(
        and(
          eq(otpChallenges.identifier, identifier),
          isNull(otpChallenges.consumedAt),
          gt(otpChallenges.expiresAt, new Date()),
        ),
      )
      .orderBy(desc(otpChallenges.createdAt))
      .limit(1);

    if (!challenge) throw unauthenticated('That code has expired — request a new one');

    if (challenge.attempts >= challenge.maxAttempts) {
      await app.db
        .update(otpChallenges)
        .set({ consumedAt: new Date() })
        .where(eq(otpChallenges.id, challenge.id));
      throw unauthenticated('Too many attempts — request a new code');
    }

    if (challenge.codeHash !== hashOtp(body.code, identifier)) {
      await app.db
        .update(otpChallenges)
        .set({ attempts: challenge.attempts + 1 })
        .where(eq(otpChallenges.id, challenge.id));
      throw unauthenticated('Incorrect code');
    }

    await app.db
      .update(otpChallenges)
      .set({ consumedAt: new Date() })
      .where(eq(otpChallenges.id, challenge.id));

    const field = body.phone ? users.phone : users.email;
    const [existing] = await app.db
      .select()
      .from(users)
      .where(and(eq(field, identifier), isNull(users.deletedAt)))
      .limit(1);

    let user = existing;
    if (!user) {
      // Account is created on first successful verification. `username` stays
      // null until onboarding completes, which is what gates the rest of the API.
      const [created] = await app.db
        .insert(users)
        .values({
          id: newId(),
          ...(body.phone
            ? { phone: identifier, phoneVerifiedAt: new Date() }
            : { email: identifier, emailVerifiedAt: new Date() }),
        })
        .returning();
      user = created!;

      if (body.phone) {
        // Blind index for contact sync, peppered with a secret held in the DB.
        await app.db.execute(
          raw`update users
                 set phone_hash = encode(hmac(${identifier}, (select value from server_secrets where key = 'phone_pepper'), 'sha256'), 'hex')
               where id = ${user.id}::uuid`,
        );
      }
    } else if (body.phone && !user.phoneVerifiedAt) {
      await app.db.update(users).set({ phoneVerifiedAt: new Date() }).where(eq(users.id, user.id));
    }

    const session = await issueSession(
      user.id,
      user.tokenEpoch,
      body.client,
      req.ip,
      req.headers['user-agent'],
    );

    return reply.send({
      ...session,
      user: toSelf(user),
      needsOnboarding: !user.username,
    });
  });

  // ── Onboarding ─────────────────────────────────────────────────────────────

  app.post('/complete-profile', { preHandler: app.authenticate }, async (req, reply) => {
    const body = completeProfileBody.parse(req.body);

    if (req.user.username) throw new AppError(409, ErrorCode.Conflict, 'Profile is already set up');

    try {
      const [updated] = await app.db
        .update(users)
        .set({
          username: body.username,
          displayName: body.displayName,
          avatarMediaId: body.avatarMediaId ?? null,
        })
        .where(eq(users.id, req.user.id))
        .returning();
      return reply.send({ user: toSelf(updated!) });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new AppError(409, ErrorCode.AlreadyExists, 'That username is taken');
      }
      throw err;
    }
  });

  app.get('/username-available', async (req, reply) => {
    const { username } = req.query as { username?: string };
    if (!username) throw new AppError(400, ErrorCode.BadRequest, 'username is required');
    const parsed = completeProfileBody.shape.username.safeParse(username);
    if (!parsed.success) {
      return reply.send({ available: false, reason: parsed.error.issues[0]?.message });
    }
    const [taken] = await app.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.username, parsed.data), isNull(users.deletedAt)))
      .limit(1);
    return reply.send({ available: !taken });
  });

  // ── Token lifecycle ────────────────────────────────────────────────────────

  /**
   * Refresh with rotation.
   *
   * Rotating on every use means a stolen refresh token is only good until the
   * legitimate client next refreshes — at which point the theft is detectable.
   * But naive rotation has a brutal failure mode: a client that sends a
   * refresh, loses the response to a dropped connection, and retries with the
   * same token gets logged out. On mobile that is common, not exotic.
   *
   * So the previous hash stays valid for a short grace window
   * (REFRESH_RETRY_GRACE_SECONDS). Inside it, a repeat is treated as that
   * retry and rotated normally. Outside it, the token should have been dead
   * long ago and its reappearance means theft — revoke the session.
   */
  app.post('/refresh', async (req, reply) => {
    const body = refreshBody.parse(req.body);
    await app.limiter.consume(`ip:${req.ip}`, 'auth.refresh');

    const hash = hashToken(body.refreshToken);

    let [device] = await app.db
      .select()
      .from(devices)
      .where(eq(devices.refreshTokenHash, hash))
      .limit(1);

    if (!device) {
      const [previous] = await app.db
        .select()
        .from(devices)
        .where(eq(devices.previousRefreshTokenHash, hash))
        .limit(1);

      const withinGrace =
        previous?.previousRefreshExpiresAt && previous.previousRefreshExpiresAt > new Date();

      if (previous && !previous.revokedAt && withinGrace) {
        device = previous; // the dropped-response retry — carry on and rotate
      } else {
        if (previous && !previous.revokedAt) {
          await app.db.update(devices).set({ revokedAt: new Date() }).where(eq(devices.id, previous.id));
          await app.db.insert(auditLog).values({
            id: newId(),
            userId: previous.userId,
            action: 'session.refresh_reuse_detected',
            ip: req.ip,
            metadata: { deviceId: previous.id },
          });
        }
        throw new AppError(401, ErrorCode.TokenRevoked, 'Please sign in again');
      }
    }

    if (device.revokedAt) throw new AppError(401, ErrorCode.TokenRevoked, 'This session was signed out');
    if (device.refreshTokenExpiresAt && device.refreshTokenExpiresAt < new Date()) {
      throw new AppError(401, ErrorCode.TokenExpired, 'Session expired — please sign in again');
    }

    const [user] = await app.db
      .select()
      .from(users)
      .where(and(eq(users.id, device.userId), isNull(users.deletedAt)))
      .limit(1);
    if (!user) throw unauthenticated('Account not found');

    const next = newRefreshToken();
    await app.db
      .update(devices)
      .set({
        refreshTokenHash: next.hash,
        previousRefreshTokenHash: device.refreshTokenHash,
        previousRefreshExpiresAt: new Date(Date.now() + REFRESH_RETRY_GRACE_SECONDS * 1000),
        refreshTokenExpiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL * 1000),
        lastActiveAt: new Date(),
        lastIp: req.ip,
      })
      .where(eq(devices.id, device.id));

    return reply.send({
      accessToken: await signAccessToken(user.id, device.id, user.tokenEpoch),
      refreshToken: next.token,
      expiresIn: env.ACCESS_TOKEN_TTL,
    });
  });

  /**
   * Short-lived ticket for opening the WebSocket. Separate from the access
   * token because the gateway URL may carry it as a query parameter, and query
   * strings leak into proxy and CDN logs.
   */
  app.post('/gateway-ticket', { preHandler: app.authenticate }, async (req, reply) => {
    return reply.send({
      ticket: await signGatewayTicket(req.user.id, req.deviceId, req.user.tokenEpoch),
      url: env.PUBLIC_GATEWAY_URL,
      expiresIn: 60,
    });
  });

  app.post('/logout', { preHandler: app.authenticate }, async (req, reply) => {
    await app.db.update(devices).set({ revokedAt: new Date() }).where(eq(devices.id, req.deviceId));
    await app.events.toUser(req.user.id, 'session.update', { deviceId: req.deviceId, revoked: true });
    return reply.send({ ok: true });
  });

  /** Bumping the epoch invalidates every outstanding access token at once. */
  app.post('/logout-all', { preHandler: app.authenticate }, async (req, reply) => {
    await app.db.transaction(async (tx) => {
      await tx
        .update(devices)
        .set({ revokedAt: new Date() })
        .where(and(eq(devices.userId, req.user.id), isNull(devices.revokedAt)));
      await tx
        .update(users)
        .set({ tokenEpoch: req.user.tokenEpoch + 1 })
        .where(eq(users.id, req.user.id));
    });

    await app.db.insert(auditLog).values({
      id: newId(),
      userId: req.user.id,
      action: 'session.revoked_all',
      ip: req.ip,
      metadata: {},
    });

    return reply.send({ ok: true });
  });
}
