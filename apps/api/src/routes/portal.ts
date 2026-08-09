import { and, deviceGrants, eq, isNull, sql as raw } from '@yappy/db';
import { AppError, ErrorCode, newId, notFound, unprocessable } from '@yappy/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  hashToken,
  newPollToken,
  newUserCode,
  signPortalToken,
} from '../lib/tokens.js';

/**
 * Developer portal sign-in.
 *
 * Nothing here is authenticated by an account token — that is the point. The
 * browser has no session yet, so it asks for a grant, shows a code, and waits.
 * The approval happens in the app, where the user already is.
 *
 * See `device_grants` for why the code travels browser → human → app and not
 * the other way around.
 */

const GRANT_TTL_SECONDS = 10 * 60;
const MAX_CODE_ATTEMPTS = 5;

const pollBody = z.object({ pollToken: z.string().min(20).max(200) });

/**
 * A readable summary of the requesting browser, shown back verbatim by the
 * bot. Parsed loosely: a wrong guess produces a slightly vague prompt, whereas
 * a strict parser that throws would block a sign-in.
 */
function describeClient(userAgent: string | undefined): string {
  const ua = userAgent ?? '';
  const browser =
    /Edg\//.test(ua) ? 'Edge'
    : /OPR\//.test(ua) ? 'Opera'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : 'A browser';

  const os =
    /Windows/.test(ua) ? 'Windows'
    : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
    : /Android/.test(ua) ? 'Android'
    : /iPhone|iPad/.test(ua) ? 'iOS'
    : /Linux/.test(ua) ? 'Linux'
    : 'an unknown system';

  return `${browser} on ${os}`;
}

export async function portalRoutes(app: FastifyInstance) {
  /**
   * The browser asks to be let in. Returns a code for the human and a handle
   * for itself.
   */
  app.post('/auth/start', async (req, reply) => {
    // Keyed by IP: there is no user yet, and without this one machine could
    // mint codes until it collided with someone else's.
    await app.limiter.consume(`ip:${req.ip}`, 'portal.grant');

    const userCode = newUserCode();
    const poll = newPollToken();
    const expiresAt = new Date(Date.now() + GRANT_TTL_SECONDS * 1000);

    await app.db.insert(deviceGrants).values({
      id: newId(),
      userCodeHash: hashToken(userCode),
      pollTokenHash: poll.hash,
      clientDescription: describeClient(req.headers['user-agent']),
      requestIp: req.ip,
      expiresAt,
    });

    return reply.status(201).send({
      userCode,
      pollToken: poll.token,
      expiresIn: GRANT_TTL_SECONDS,
      // So the page can tell the user exactly what to type.
      instructions: `Message @yapper in the app:  /login dev ${userCode}`,
    });
  });

  /**
   * The browser waits. Deliberately a poll rather than a socket: this runs
   * once per sign-in on a page that is otherwise idle, and a WebSocket would
   * be more moving parts for no benefit.
   */
  app.post('/auth/poll', async (req, reply) => {
    const { pollToken } = pollBody.parse(req.body);
    await app.limiter.consume(`ip:${req.ip}`, 'auth.refresh');

    const [grant] = await app.db
      .select()
      .from(deviceGrants)
      .where(eq(deviceGrants.pollTokenHash, hashToken(pollToken)))
      .limit(1);

    if (!grant) throw notFound('Sign-in request');
    if (grant.consumedAt) return reply.send({ status: 'consumed' });
    if (grant.expiresAt < new Date()) return reply.send({ status: 'expired' });
    if (grant.status === 'denied') return reply.send({ status: 'denied' });

    if (grant.status !== 'approved' || !grant.claimedByUserId) {
      // `awaiting_confirm` is surfaced so the page can say "check your phone"
      // instead of leaving someone staring at an unchanged screen.
      return reply.send({ status: grant.status });
    }

    // Single use, and claimed atomically: two tabs polling the same grant must
    // not both walk away with a session.
    const claimed = await app.db
      .update(deviceGrants)
      .set({ consumedAt: new Date() })
      .where(and(eq(deviceGrants.id, grant.id), isNull(deviceGrants.consumedAt)))
      .returning({ id: deviceGrants.id });

    if (claimed.length === 0) return reply.send({ status: 'consumed' });

    return reply.send({
      status: 'approved',
      token: await signPortalToken(grant.claimedByUserId),
      expiresIn: 8 * 3600,
    });
  });

  /** Who the portal session belongs to. Rejects an ordinary access token. */
  app.get('/me', { preHandler: app.authenticatePortal }, async (req, reply) => {
    return reply.send({
      user: {
        id: req.portalUser.id,
        username: req.portalUser.username,
        displayName: req.portalUser.displayName,
      },
    });
  });
}

// ─── The bot's half ──────────────────────────────────────────────────────────

export interface GrantLookup {
  db: FastifyInstance['db'];
}

/**
 * Claim a code typed at the bot. Returns what to say back.
 *
 * Kept here rather than in the bot handler so the whole grant lifecycle reads
 * in one file: issued, claimed, confirmed, consumed.
 */
export async function claimGrant(
  db: FastifyInstance['db'],
  userId: string,
  rawCode: string,
): Promise<{ ok: false; reason: string } | { ok: true; description: string; ip: string | null }> {
  const code = rawCode.trim().toUpperCase();
  const [grant] = await db
    .select()
    .from(deviceGrants)
    .where(eq(deviceGrants.userCodeHash, hashToken(code)))
    .limit(1);

  // Same message for "no such code" and "expired": distinguishing them tells
  // someone guessing codes when they have found a real one.
  if (!grant || grant.expiresAt < new Date() || grant.consumedAt) {
    return { ok: false, reason: 'That code is not valid, or it has expired. Codes last ten minutes.' };
  }
  if (grant.status === 'approved') {
    return { ok: false, reason: 'That code was already approved.' };
  }
  if (Number(grant.attempts) >= MAX_CODE_ATTEMPTS) {
    return { ok: false, reason: 'Too many attempts on that code. Start again in the browser.' };
  }
  if (grant.claimedByUserId && grant.claimedByUserId !== userId) {
    return { ok: false, reason: 'Someone else is already signing in with that code.' };
  }

  await db
    .update(deviceGrants)
    .set({ status: 'awaiting_confirm', claimedByUserId: userId, claimedAt: new Date() })
    .where(eq(deviceGrants.id, grant.id));

  return { ok: true, description: grant.clientDescription, ip: grant.requestIp };
}

/** The second step. Nothing is granted until this runs. */
export async function confirmGrant(
  db: FastifyInstance['db'],
  userId: string,
  approve: boolean,
): Promise<{ ok: boolean; message: string }> {
  const [grant] = await db
    .select()
    .from(deviceGrants)
    .where(
      and(
        eq(deviceGrants.claimedByUserId, userId),
        eq(deviceGrants.status, 'awaiting_confirm'),
        isNull(deviceGrants.consumedAt),
      ),
    )
    .orderBy(raw`${deviceGrants.claimedAt} desc`)
    .limit(1);

  if (!grant) return { ok: false, message: 'Nothing is waiting for confirmation.' };
  if (grant.expiresAt < new Date()) {
    return { ok: false, message: 'That request expired. Start again in the browser.' };
  }

  // Worded to stand on its own inside a card whose title already says which
  // way it went, so neither sentence begins by repeating the outcome.
  if (!approve) {
    await db.update(deviceGrants).set({ status: 'denied' }).where(eq(deviceGrants.id, grant.id));
    return {
      ok: true,
      message: 'Nothing was signed in. If someone sent you that code, they were trying to use your account.',
    };
  }

  await db
    .update(deviceGrants)
    .set({ status: 'approved', approvedAt: new Date() })
    .where(eq(deviceGrants.id, grant.id));

  return {
    ok: true,
    message: `${grant.clientDescription} now has a developer-portal session. It lasts 8 hours and manages applications only.`,
  };
}

/** Recorded on a wrong code so guessing is bounded rather than merely slow. */
export async function noteBadAttempt(db: FastifyInstance['db'], userId: string): Promise<void> {
  await db.execute(raw`
    update device_grants
       set attempts = (attempts::int + 1)::text
     where claimed_by_user_id = ${userId}::uuid
       and status = 'awaiting_confirm'
       and consumed_at is null
  `);
}

export { AppError, ErrorCode, unprocessable };
