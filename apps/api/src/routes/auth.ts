import { and, auditLog, authIdentities, desc, deviceGrants, devices, eq, gt, isNull, users } from '@yappy/db';
import {
  AppError,
  ErrorCode,
  changePasswordBody,
  completeProfileBody,
  deviceAuthPollBody,
  forgotPasswordBody,
  loginBody,
  newId,
  refreshBody,
  registerBody,
  resetPasswordBody,
  socialAuthBody,
  unauthenticated,
  unprocessable,
  verifyEmailBody,
} from '@yappy/shared';
import type { FastifyInstance } from 'fastify';
import { env } from '../env.js';
import { forgetAuthUser } from '../plugins/auth.js';
import { hashPassword, verifyPassword } from '../lib/passwords.js';
import { toSelf } from '../lib/serialize.js';
import { availableUsername, findIdentity, verifyAppleToken, verifyGoogleToken } from '../lib/socialauth.js';
import { CODE_TTL_MINUTES, consumeCode, issueCode, type CodeResult } from '../lib/codes.js';
import { resetEmail, verifyEmail } from '../lib/mailer.js';
import { hashToken, newPollToken, newRefreshToken, newUserCode, signAccessToken, signGatewayTicket } from '../lib/tokens.js';
import { checkUsername } from '../lib/profile.js';

/**
 * Authentication: email, password, username.
 *
 * This was OTP-over-SMS, on the reasoning that a phone-book social app wants
 * phone numbers and that skipping passwords removes credential stuffing and
 * password storage from the threat model. yappy turned out not to be that app —
 * it is group-first, there is no phone book, and requiring a phone number to
 * join a group chat is a real barrier for no benefit. SMS also costs money per
 * sign-in and is the weakest common second factor.
 *
 * What that trade costs is honest to state: passwords must now be stored (see
 * `lib/passwords.ts`), sign-in can be brute-forced (see the `auth.login`
 * bucket), and people reuse passwords across sites.
 *
 * Email is **not verified** at present. An address is a login handle and a
 * future recovery route, and nothing is sent to it, so an unverified one costs
 * nothing today. It will need verifying before password reset exists, or the
 * reset becomes a way to take over an account by claiming its address.
 */
/**
 * How long a just-rotated refresh token stays usable. Long enough to cover a
 * dropped response and a client retry; short enough that a token lifted from a
 * log or a proxy cache is already dead.
 */
const REFRESH_RETRY_GRACE_SECONDS = 60;


/**
 * What a failed code means to the caller.
 *
 * Deliberately three different answers: "expired" and "out of guesses" are
 * both things a person can act on, and flattening them into "invalid" makes a
 * fifteen-minute-old code look like a typo.
 */
function codeProblem(result: Exclude<CodeResult, 'ok'>): Error {
  if (result === 'expired') return unprocessable('That code has expired. Ask for a new one.');
  if (result === 'too_many_attempts') {
    return unprocessable('Too many attempts on that code. Ask for a new one.');
  }
  return unauthenticated('That code is not valid');
}
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

  // ── Register & sign in ─────────────────────────────────────────────────────

  app.post('/register', async (req, reply) => {
    const body = registerBody.parse(req.body);
    await app.limiter.consume(`ip:${req.ip}`, 'auth.register');

    const passwordHash = await hashPassword(body.password);

    // Uniqueness is enforced by the partial unique indexes on email and
    // username, not by selecting first: check-then-insert is a race that two
    // simultaneous signups can both win.
    let user;
    try {
      const [created] = await app.db
        .insert(users)
        .values({
          id: newId(),
          email: body.email,
          passwordHash,
          username: body.username,
          displayName: body.displayName ?? body.username,
        })
        .returning();
      user = created!;
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        const constraint = String(
          (err as { constraint_name?: string; constraint?: string }).constraint_name ??
            (err as { constraint?: string }).constraint ??
            '',
        );
        throw new AppError(
          409,
          ErrorCode.AlreadyExists,
          constraint.includes('username')
            ? 'That username is taken'
            : 'That email is already registered',
        );
      }
      throw err;
    }

    const session = await issueSession(
      user.id,
      user.tokenEpoch,
      body.client,
      req.ip,
      req.headers['user-agent'],
    );

    // Say hello. Keyed on the user id so a retried job cannot produce a second
    // welcome, and enqueued rather than sent inline because a new account must
    // not wait on — or fail because of — a bot.
    void app.enqueue('yapper.dm', { userId: user.id, kind: 'welcome_v2', dedupe: user.id });

    // No onboarding step: the username is chosen during registration, so the
    // account is complete the moment it exists.
    return reply.status(201).send({ ...session, user: toSelf(user), needsOnboarding: false });
  });

  /**
   * Native social sign-in: Google (both platforms) and Apple (iOS).
   *
   * The client verified nothing — it just obtained the provider's ID token on
   * device and sent it here, where the real check happens against the
   * provider's JWKS. One endpoint covers first-ever sign-in, returning users,
   * and account creation, because the client cannot know which it is.
   *
   * The linking rule, stated where the risk lives: an incoming social
   * identity auto-attaches to an existing email-matched account ONLY when
   * that account has no password. Our own emails are unverified, so a
   * password account with someone else's address could otherwise be captured
   * by — or capture — the address's real owner the first time they use
   * Google. A password account gets a 409 and signs in with its password;
   * deliberate linking can become a Settings feature later.
   */
  app.post('/social', async (req, reply) => {
    const body = socialAuthBody.parse(req.body);
    await app.limiter.consume(`ip:${req.ip}`, 'auth.login', 0.5);

    let identity;
    try {
      identity =
        body.provider === 'google'
          ? await verifyGoogleToken(body.idToken)
          : await verifyAppleToken(body.idToken);
    } catch (err) {
      if ((err as Error).message === 'google_disabled') {
        throw new AppError(400, ErrorCode.BadRequest, 'Google sign-in is not enabled on this server');
      }
      // Expired, wrong audience, bad signature — all the same to the caller.
      throw unauthenticated('That sign-in could not be verified. Try again.');
    }

    // Fast path: this provider subject has signed in before.
    const existing = await findIdentity(app.db, identity.provider, identity.subject);
    let user;
    let created = false;

    if (existing) {
      [user] = await app.db
        .select()
        .from(users)
        .where(and(eq(users.id, existing.userId), isNull(users.deletedAt)))
        .limit(1);
      if (!user) throw unauthenticated('That sign-in could not be verified. Try again.');
    } else {
      // Never link on an email the provider itself does not vouch for.
      const email = identity.emailVerified ? identity.email : null;
      const [byEmail] = email
        ? await app.db
            .select()
            .from(users)
            .where(and(eq(users.email, email), isNull(users.deletedAt)))
            .limit(1)
        : [undefined];

      if (byEmail && byEmail.passwordHash) {
        throw new AppError(
          409,
          ErrorCode.AlreadyExists,
          'That email already has a password account. Sign in with your password.',
        );
      }

      if (byEmail) {
        user = byEmail;
      } else {
        const username = await availableUsername(app.db, identity.email);
        const [fresh] = await app.db
          .insert(users)
          .values({
            id: newId(),
            email: identity.email,
            // The provider vouched for it, which is more than our own
            // register flow can say.
            emailVerifiedAt: identity.emailVerified ? new Date() : null,
            username,
            displayName: body.fullName ?? identity.name ?? username,
          })
          .returning();
        user = fresh!;
        created = true;
      }

      await app.db
        .insert(authIdentities)
        .values({
          provider: identity.provider,
          subject: identity.subject,
          userId: user.id,
          email: identity.email,
        })
        .onConflictDoNothing();
    }

    if (user.suspendedUntil && user.suspendedUntil > new Date()) {
      throw new AppError(
        403,
        ErrorCode.Forbidden,
        `This account is suspended until ${user.suspendedUntil.toISOString().slice(0, 10)}`,
      );
    }

    const session = await issueSession(
      user.id,
      user.tokenEpoch,
      body.client,
      req.ip,
      req.headers['user-agent'],
    );

    if (created) {
      void app.enqueue('yapper.dm', { userId: user.id, kind: 'welcome_v2', dedupe: user.id });
    }

    return reply
      .status(created ? 201 : 200)
      .send({ ...session, user: toSelf(user), needsOnboarding: !user.username });
  });

  // ── Sign in with the app ───────────────────────────────────────────────────
  //
  // The web client's passwordless door: the browser mints a device grant and
  // shows the code; the person sends yapper `/login <code>` from a phone that
  // is already signed in and confirms; the browser's poll exchanges the
  // approved grant for a full session. Same `device_grants` table and yapper
  // claim flow as the developer portal — the difference is the prize, so the
  // poll here runs the same suspension check and session mint as /login.

  app.post('/device/start', async (req, reply) => {
    // Keyed by IP — there is no user yet.
    await app.limiter.consume(`ip:${req.ip}`, 'portal.grant');

    const userCode = newUserCode();
    const poll = newPollToken();
    const ttlSeconds = 10 * 60;

    const ua = req.headers['user-agent'] ?? '';
    const browser =
      /Edg\//.test(ua) ? 'Edge'
      : /Chrome\//.test(ua) ? 'Chrome'
      : /Firefox\//.test(ua) ? 'Firefox'
      : /Safari\//.test(ua) ? 'Safari'
      : 'A browser';

    await app.db.insert(deviceGrants).values({
      id: newId(),
      userCodeHash: hashToken(userCode),
      pollTokenHash: poll.hash,
      clientDescription: `yappy web (${browser})`,
      requestIp: req.ip,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000),
    });

    return reply.status(201).send({
      userCode,
      pollToken: poll.token,
      expiresIn: ttlSeconds,
      instructions: `Message @yapper from your phone:  /login ${userCode}`,
    });
  });

  app.post('/device/poll', async (req, reply) => {
    const body = deviceAuthPollBody.parse(req.body);
    await app.limiter.consume(`ip:${req.ip}`, 'auth.refresh');

    const [grant] = await app.db
      .select()
      .from(deviceGrants)
      .where(eq(deviceGrants.pollTokenHash, hashToken(body.pollToken)))
      .limit(1);

    if (!grant) throw unauthenticated('That sign-in request is not known here.');
    if (grant.consumedAt) return reply.send({ status: 'consumed' });
    if (grant.expiresAt < new Date()) return reply.send({ status: 'expired' });
    if (grant.status === 'denied') return reply.send({ status: 'denied' });
    if (grant.status !== 'approved' || !grant.claimedByUserId) {
      return reply.send({ status: grant.status });
    }

    // Single use, claimed atomically — two tabs polling the same grant must
    // not both walk away with a session.
    const claimed = await app.db
      .update(deviceGrants)
      .set({ consumedAt: new Date() })
      .where(and(eq(deviceGrants.id, grant.id), isNull(deviceGrants.consumedAt)))
      .returning({ id: deviceGrants.id });
    if (claimed.length === 0) return reply.send({ status: 'consumed' });

    const [user] = await app.db
      .select()
      .from(users)
      .where(and(eq(users.id, grant.claimedByUserId), isNull(users.deletedAt)))
      .limit(1);
    if (!user) throw unauthenticated('That account no longer exists.');

    if (user.suspendedUntil && user.suspendedUntil > new Date()) {
      throw new AppError(
        403,
        ErrorCode.Forbidden,
        `This account is suspended until ${user.suspendedUntil.toISOString().slice(0, 10)}`,
      );
    }

    const session = await issueSession(
      user.id,
      user.tokenEpoch,
      body.client,
      req.ip,
      req.headers['user-agent'],
    );

    return reply.send({
      status: 'approved',
      ...session,
      user: toSelf(user),
      needsOnboarding: !user.username,
    });
  });

  app.post('/login', async (req, reply) => {
    const body = loginBody.parse(req.body);

    // Both keys, every attempt. Per-email defeats guessing one account's
    // password; per-IP defeats spraying one common password across thousands
    // of accounts, which no per-account limit would ever see.
    await app.limiter.consume(`email:${body.email}`, 'auth.login');
    await app.limiter.consume(`ip:${req.ip}`, 'auth.login', 0.2);

    const [user] = await app.db
      .select()
      .from(users)
      .where(and(eq(users.email, body.email), isNull(users.deletedAt)))
      .limit(1);

    // The same work and the same message whether the account is missing or the
    // password is wrong. Anything else is an account-existence oracle.
    const ok = await verifyPassword(user?.passwordHash ?? null, body.password);
    if (!ok || !user) throw unauthenticated('Email or password is incorrect');

    // After the credential check, deliberately: a suspension is information,
    // and it is only owed to someone who has proven they own the account.
    if (user.suspendedUntil && user.suspendedUntil > new Date()) {
      throw new AppError(
        403,
        ErrorCode.Forbidden,
        `This account is suspended until ${user.suspendedUntil.toISOString().slice(0, 10)}`,
      );
    }

    /**
     * Is this sign-in from somewhere I have seen this account before?
     *
     * Asked *before* the session is issued, because issuing it writes the very
     * device row that would make the answer yes.
     *
     * Same platform and same address, active within the month. Deliberately
     * coarse: the alert exists to catch "someone else has your password", and
     * the failure that matters is staying quiet when they do. A false alarm
     * when a phone lands on a new IP costs one message that says nothing is
     * necessarily wrong; a missed alarm costs the account. Clients refresh
     * their tokens rather than re-authenticating, so reaching this line at all
     * means a password was typed somewhere.
     */
    const familiarSince = new Date(Date.now() - 30 * 86_400_000);
    const [familiar] = await app.db
      .select({ id: devices.id })
      .from(devices)
      .where(
        and(
          eq(devices.userId, user.id),
          eq(devices.platform, body.client.platform),
          eq(devices.lastIp, req.ip),
          isNull(devices.revokedAt),
          gt(devices.lastActiveAt, familiarSince),
        ),
      )
      .limit(1);

    const session = await issueSession(
      user.id,
      user.tokenEpoch,
      body.client,
      req.ip,
      req.headers['user-agent'],
    );

    if (!familiar) {
      void app.enqueue('yapper.dm', {
        userId: user.id,
        kind: 'new_device',
        // One alert per session, not per detection: the device id is minted by
        // this sign-in and never reused.
        dedupe: session.deviceId,
        payload: {
          platform: body.client.platform,
          device: body.client.device ?? body.client.platform,
          ip: req.ip,
          at: new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
        },
      });
    }

    return reply.send({ ...session, user: toSelf(user), needsOnboarding: !user.username });
  });

  /**
   * Change a password.
   *
   * Moving `tokenEpoch` is as much the point of this endpoint as the new hash
   * is: someone changing their password after a scare expects it to end every
   * other session, and an access token already minted stays valid for its full
   * lifetime unless the epoch moves.
   */
  app.post('/change-password', { preHandler: app.authenticate }, async (req, reply) => {
    const body = changePasswordBody.parse(req.body);
    await app.limiter.consume(`user:${req.user.id}`, 'auth.password.change');

    const [me] = await app.db
      .select({ passwordHash: users.passwordHash, tokenEpoch: users.tokenEpoch })
      .from(users)
      .where(eq(users.id, req.user.id))
      .limit(1);

    if (!(await verifyPassword(me?.passwordHash ?? null, body.currentPassword))) {
      throw unauthenticated('Current password is incorrect');
    }

    const passwordHash = await hashPassword(body.newPassword);
    const nextEpoch = (me?.tokenEpoch ?? 0) + 1;

    await app.db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ passwordHash, tokenEpoch: nextEpoch })
        .where(eq(users.id, req.user.id));

      // Refresh tokens are not covered by the epoch, so they are revoked
      // explicitly. Without this, every other device could go on minting fresh
      // access tokens indefinitely — which is exactly what the person changing
      // their password is trying to stop.
      await tx
        .update(devices)
        .set({ revokedAt: new Date(), refreshTokenHash: null, previousRefreshTokenHash: null })
        .where(and(eq(devices.userId, req.user.id), isNull(devices.revokedAt)));

      await tx.insert(auditLog).values({
        id: newId(),
        userId: req.user.id,
        action: 'password.changed',
        ip: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
        metadata: {},
      });
    });
    forgetAuthUser(req.user.id);

    // That revoked the caller's own session too, so hand back a fresh one
    // rather than signing them out of the device in their hand.
    const session = await issueSession(
      req.user.id,
      nextEpoch,
      { platform: 'unknown', version: '0' },
      req.ip,
      req.headers['user-agent'],
    );

    return reply.send({ ...session, changed: true });
  });


  // ── Recovery ───────────────────────────────────────────────────────────────
  //
  // Two flows sharing one mechanism: a six-digit code, emailed, hashed at rest,
  // good for fifteen minutes and five guesses. lib/codes.ts says why a code
  // rather than a link.

  /**
   * Send a verification code to the address on the account.
   *
   * Verifying an address is what makes the reset below meaningful: a reset mail
   * to an address nobody proved they own is a way of losing an account, not
   * recovering one.
   */
  app.post('/email/verify/request', { preHandler: app.authenticate }, async (req, reply) => {
    const [me] = await app.db
      .select({ email: users.email, verifiedAt: users.emailVerifiedAt })
      .from(users)
      .where(eq(users.id, req.user.id))
      .limit(1);

    if (!me?.email) throw unprocessable('This account has no email address');
    if (me.verifiedAt) return reply.send({ sent: false, alreadyVerified: true });

    await app.limiter.consume(`user:${req.user.id}`, 'auth.email.verify.send');

    const code = await issueCode(app.db, me.email, 'email.verify', req.ip);
    await app.enqueue('email.send', { ...verifyEmail(code, CODE_TTL_MINUTES), to: me.email });

    return reply.send({ sent: true, expiresInMinutes: CODE_TTL_MINUTES });
  });

  app.post('/email/verify', { preHandler: app.authenticate }, async (req, reply) => {
    const body = verifyEmailBody.parse(req.body);

    const [me] = await app.db
      .select({ email: users.email, verifiedAt: users.emailVerifiedAt })
      .from(users)
      .where(eq(users.id, req.user.id))
      .limit(1);
    if (!me?.email) throw unprocessable('This account has no email address');
    if (me.verifiedAt) return reply.send({ verified: true });

    const result = await consumeCode(app.db, me.email, 'email.verify', body.code);
    if (result !== 'ok') throw codeProblem(result);

    await app.db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, req.user.id));
    forgetAuthUser(req.user.id);
    return reply.send({ verified: true });
  });

  /**
   * Ask for a reset code.
   *
   * Always answers the same thing. "No account with that address" is a way to
   * ask whether somebody has an account here, one address at a time, and this
   * endpoint needs no authentication at all — so the only honest answer is the
   * one that says nothing either way.
   *
   * Rate limited on the address as well as the IP: without the first, one
   * person can be mailed a code every second by anyone who knows where they
   * signed up.
   */
  app.post('/password/forgot', async (req, reply) => {
    const body = forgotPasswordBody.parse(req.body);
    await app.limiter.consume(`ip:${req.ip}`, 'auth.password.forgot');

    const [user] = await app.db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(and(eq(users.email, body.email), isNull(users.deletedAt)))
      .limit(1);

    if (user?.email) {
      await app.limiter.consume(`email:${body.email}`, 'auth.password.forgot');
      const code = await issueCode(app.db, user.email, 'password.reset', req.ip);
      await app.enqueue('email.send', { ...resetEmail(code, CODE_TTL_MINUTES), to: user.email });
    }

    return reply.send({ sent: true, expiresInMinutes: CODE_TTL_MINUTES });
  });

  /**
   * Set a new password with a code, and end every other session.
   *
   * The epoch bump and the device revocation are not housekeeping: somebody
   * resetting a password may be doing it *because* another session exists that
   * should not. The caller gets a fresh session back, so the flow ends on the
   * device that performed it, signed in.
   */
  app.post('/password/reset', async (req, reply) => {
    const body = resetPasswordBody.parse(req.body);
    await app.limiter.consume(`ip:${req.ip}`, 'auth.password.reset');

    const [user] = await app.db
      .select({ id: users.id, email: users.email, tokenEpoch: users.tokenEpoch })
      .from(users)
      .where(and(eq(users.email, body.email), isNull(users.deletedAt)))
      .limit(1);

    // Same answer as a wrong code, for the same reason as above.
    if (!user?.email) throw unauthenticated('That code is not valid');

    const result = await consumeCode(app.db, user.email, 'password.reset', body.code);
    if (result !== 'ok') throw codeProblem(result);

    const passwordHash = await hashPassword(body.password);
    const nextEpoch = user.tokenEpoch + 1;

    await app.db.transaction(async (tx) => {
      await tx
        .update(users)
        // Resetting with a code proves the address, so the act verifies it:
        // the mail arrived and they read it.
        .set({ passwordHash, tokenEpoch: nextEpoch, emailVerifiedAt: new Date() })
        .where(eq(users.id, user.id));

      await tx
        .update(devices)
        .set({ revokedAt: new Date(), refreshTokenHash: null, previousRefreshTokenHash: null })
        .where(and(eq(devices.userId, user.id), isNull(devices.revokedAt)));

      await tx.insert(auditLog).values({
        id: newId(),
        userId: user.id,
        action: 'password.reset',
        ip: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
        metadata: {},
      });
    });

    forgetAuthUser(user.id);
    const session = await issueSession(user.id, nextEpoch, body.client, req.ip, req.headers['user-agent']);

    const [full] = await app.db.select().from(users).where(eq(users.id, user.id)).limit(1);
    return reply.send({ ...session, user: toSelf(full!), needsOnboarding: !full!.username });
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
      forgetAuthUser(req.user.id);
      return reply.send({ user: toSelf(updated!) });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new AppError(409, ErrorCode.AlreadyExists, 'That username is taken');
      }
      throw err;
    }
  });

  /**
   * Is this username free?
   *
   * Unauthenticated because it has to be — the signup form asks before there
   * is an account to ask with. That makes it an account-existence oracle by
   * construction, which is unavoidable; what is avoidable is answering at
   * machine speed, so it is metered per address. Sixty in hand with a
   * per-second refill is invisible to someone typing and useless to someone
   * enumerating.
   */
  app.get('/username-available', async (req, reply) => {
    const { username } = req.query as { username?: string };
    if (!username) throw new AppError(400, ErrorCode.BadRequest, 'username is required');
    await app.limiter.consume(`ip:${req.ip}`, 'username.check');
    const result = await checkUsername(app, username);
    return reply.send({ available: result.available, reason: result.reason });
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
          forgetAuthUser(previous.userId);
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
    forgetAuthUser(req.user.id);
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
    forgetAuthUser(req.user.id);

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
