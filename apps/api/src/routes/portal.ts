import { and, desc, deviceGrants, eq, inArray, isNull, media, reports, sql as raw, users } from '@yappy/db';
import {
  AppError,
  EARLY_CLAIM,
  ErrorCode,
  REPORT_REASON_LABEL,
  conflict as conflictError,
  newId,
  notFound,
  staffReportActionBody,
  unprocessable,
  type ReportReason,
} from '@yappy/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { fileBugReport } from '../lib/bugs.js';
import { claimProgress, reserveSlot, submitAddress, validateSolanaAddress } from '../lib/earlyclaim.js';
import { applyReportAction, userLabel } from '../lib/staffspace.js';
import { Storage } from '../lib/storage.js';
import { botRoutes } from './bots.js';
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
    const [flags] = await app.db
      .select({ isStaff: users.isStaff })
      .from(users)
      .where(eq(users.id, req.portalUser.id))
      .limit(1);

    return reply.send({
      user: {
        id: req.portalUser.id,
        username: req.portalUser.username,
        displayName: req.portalUser.displayName,
        isStaff: Boolean(flags?.isStaff),
      },
    });
  });

  // ── Application management ──────────────────────────────────────────────────
  // The same routes the app mounts at /apps, under the portal credential.
  // Managing applications is the portal session's entire purpose.
  await app.register(botRoutes, { prefix: '/apps', portal: true });

  // ── Staff moderation ────────────────────────────────────────────────────────

  const requireStaff = async (req: import('fastify').FastifyRequest): Promise<void> => {
    const [row] = await app.db
      .select({ isStaff: users.isStaff })
      .from(users)
      .where(and(eq(users.id, req.portalUser.id), isNull(users.deletedAt)))
      .limit(1);
    // 404, not 403: non-staff should not learn that a staff area exists here.
    if (!row?.isStaff) throw notFound('Not found');
  };

  /** The queue, most urgent first, with the frozen evidence. */
  app.get('/staff/reports', { preHandler: app.authenticatePortal }, async (req, reply) => {
    await requireStaff(req);
    const { status } = req.query as { status?: string };
    const wanted =
      status === 'handled' ? ['actioned', 'dismissed'] : ['open', 'reviewing'];

    const rows = await app.db
      .select()
      .from(reports)
      .where(inArray(reports.status, wanted as ('open' | 'reviewing' | 'actioned' | 'dismissed')[]))
      .orderBy(desc(reports.priority), reports.createdAt)
      .limit(100);

    const out = await Promise.all(
      rows.map(async (r) => ({
        id: r.id,
        targetType: r.targetType,
        targetId: r.targetId,
        targetLabel: r.targetType === 'user' ? await userLabel(app, r.targetId) : r.targetType,
        reporterLabel: r.reporterId ? await userLabel(app, r.reporterId) : 'deleted account',
        reason: r.reason,
        // Resolved here, beside `targetLabel` and `reporterLabel`, rather than
        // in the portal's markup: `reason` is a category now, and a heading
        // reading "self_harm" is the enum leaking into the one screen where a
        // moderator is deciding what to do about it. Historical rows still hold
        // free prose from before the category step existed, and fall through
        // unchanged.
        reasonLabel: REPORT_REASON_LABEL[r.reason as ReportReason] ?? r.reason,
        detail: r.detail,
        evidence: r.evidence,
        status: r.status,
        priority: r.priority,
        resolution: r.resolution,
        createdAt: r.createdAt.toISOString(),
      })),
    );

    return reply.send({ reports: out });
  });

  app.post('/staff/reports/:id/action', { preHandler: app.authenticatePortal }, async (req, reply) => {
    await requireStaff(req);
    const { id } = req.params as { id: string };
    const body = staffReportActionBody.parse(req.body);

    const result = await applyReportAction(app, {
      reportId: id,
      actorId: req.portalUser.id,
      action: body.action,
      note: body.note,
      suspendDays: body.suspendDays,
    });

    if (!result.ok) throw conflictError(result.message);
    return reply.send({ ok: true, message: result.message });
  });

  // ─── yappy.gg/bug ──────────────────────────────────────────────────────────
  //
  // The same device-code sign-in the developer portal uses, because the person
  // filing a bug from a browser is in exactly the position it was built for:
  // they have an account in the app and no session here.
  //
  // Reporting from *inside* the app is `/bug` in a DM with yapper, and is the
  // better route for almost everyone. This page exists for the one case that
  // cannot use it — the bug is that the app will not open.

  /**
   * Presign an upload for a screenshot.
   *
   * No content-addressed dedupe, unlike `/media/uploads`. That path exists
   * because a popular meme gets sent thousands of times; a screenshot of a bug
   * gets sent once, and the dedupe is the subtlest code in the codebase to
   * borrow for no benefit.
   */
  app.post('/bugs/uploads', { preHandler: app.authenticatePortal }, async (req, reply) => {
    const body = z
      .object({
        mimeType: z.string().min(1).max(255),
        size: z.number().int().positive(),
        filename: z.string().max(255).optional(),
      })
      .parse(req.body);

    await app.limiter.consume(`user:${req.portalUser.id}`, 'media.upload');

    const validated = Storage.validate(body.mimeType, body.size);
    if (!validated.ok) {
      throw new AppError(
        body.size > 0 ? 413 : 415,
        body.size > 0 ? ErrorCode.PayloadTooLarge : ErrorCode.UnsupportedMediaType,
        validated.reason,
      );
    }

    const presigned = await app.storage.presignUpload({
      purpose: 'attachment',
      ownerId: req.portalUser.id,
      mimeType: body.mimeType,
      size: body.size,
    });

    const [row] = await app.db
      .insert(media)
      .values({
        id: newId(),
        ownerId: req.portalUser.id,
        purpose: 'attachment',
        status: 'pending',
        bucket: presigned.bucket,
        objectKey: presigned.objectKey,
        mimeType: body.mimeType,
        size: body.size,
        filename: body.filename,
      })
      .returning({ id: media.id });

    return reply.status(201).send({
      mediaId: row!.id,
      upload: {
        url: presigned.uploadUrl,
        method: 'PUT',
        headers: presigned.headers,
        expiresIn: presigned.expiresIn,
      },
    });
  });

  /** Confirm the bytes landed. Same shape as the app's own confirm. */
  app.post('/bugs/uploads/:id/confirm', { preHandler: app.authenticatePortal }, async (req, reply) => {
    const { id } = req.params as { id: string };

    const [row] = await app.db
      .select()
      .from(media)
      .where(and(eq(media.id, id), eq(media.ownerId, req.portalUser.id), isNull(media.deletedAt)))
      .limit(1);
    if (!row) throw notFound('Upload');
    if (row.confirmedAt) return reply.send({ ok: true });

    const head = await app.storage.head(row.bucket, row.objectKey);
    if (!head) throw unprocessable('The file was not uploaded');

    await app.db
      .update(media)
      .set({ confirmedAt: new Date(), size: head.size, status: 'processing' })
      .where(eq(media.id, id));

    await app.enqueue('media.process', { mediaId: id });
    return reply.send({ ok: true });
  });

  /** File it. Identical path to `/bug` in the app, including the DM back. */
  app.post('/bugs', { preHandler: app.authenticatePortal }, async (req, reply) => {
    const body = z
      .object({
        title: z.string().trim().min(3).max(140),
        description: z.string().trim().min(10).max(2_000),
        mediaIds: z.array(z.string().uuid()).max(10).default([]),
      })
      .parse(req.body);

    await app.limiter.consume(`user:${req.portalUser.id}`, 'bug.file');

    const filed = await fileBugReport(app, {
      reporterId: req.portalUser.id,
      title: body.title,
      description: body.description,
      mediaIds: body.mediaIds,
    });

    return reply.status(201).send({ reference: filed.reference });
  });

  // ─── yappy.gg/claim/early ──────────────────────────────────────────────────

  /**
   * Where they stand: their progress, their claim, and what is left.
   *
   * Takes a slot for somebody who qualifies and has not got one. A read that
   * writes is not usually the right shape, but the alternative here is worse:
   * this page tells a person "you have earned it" and shows them a box to type
   * an address into, and that promise has to be backed by something at the
   * moment it is made. Otherwise two people are told the same last slot is
   * theirs, and the second finds out after typing their wallet in.
   *
   * `reserveSlot` is idempotent and refuses when the treasury is spent, so a
   * refresh costs nothing and this can never hand out a fourth.
   */
  app.get('/claim/early', { preHandler: app.authenticatePortal }, async (req, reply) => {
    if (!EARLY_CLAIM.open) return reply.send({ open: false });

    const initial = await claimProgress(app, req.portalUser.id);
    if (!initial.claim && initial.qualifies && initial.slotsLeft > 0) {
      await reserveSlot(app, req.portalUser.id);
      return reply.send({ open: true, ...(await claimProgress(app, req.portalUser.id)) });
    }

    return reply.send({ open: true, ...initial });
  });

  /**
   * Record where to send it.
   *
   * Only from a reserved slot — qualifying is not a claim, and the reservation
   * is what makes the offer true. Somebody who qualifies but was never offered
   * a slot gets a plain refusal here rather than a payment nobody budgeted.
   *
   * The address is stored exactly as given. It is *not* the last word: the app
   * asks them to confirm it, in full, because no amount of validation can
   * catch a typo in an unchecksummed key — see `validateSolanaAddress`.
   */
  app.post('/claim/early', { preHandler: app.authenticatePortal }, async (req, reply) => {
    if (!EARLY_CLAIM.open) throw conflictError('The early-tester reward is closed.');

    const body = z.object({ walletAddress: z.string().min(1).max(64) }).parse(req.body);
    await app.limiter.consume(`user:${req.portalUser.id}`, 'bug.file');

    const valid = validateSolanaAddress(body.walletAddress);
    if (!valid.ok) throw new AppError(422, ErrorCode.Unprocessable, valid.reason);

    let progress = await claimProgress(app, req.portalUser.id);

    /**
     * Take a slot now if they have not been offered one.
     *
     * Reservations are also made by the hourly detection, but waiting for it
     * would mean somebody who qualifies, opens this page and types an address
     * is refused for up to an hour — with nothing wrong except that a cron had
     * not run yet. Arriving here under your own steam is the same event as
     * being told: you qualify, and there is money left.
     */
    if (!progress.claim) {
      await reserveSlot(app, req.portalUser.id);
      progress = await claimProgress(app, req.portalUser.id);
    }

    if (!progress.claim || !['reserved', 'submitted'].includes(progress.claim.status)) {
      // Each of these is a different thing to be told, and conflating them is
      // how a page reading "3 of 3 left" also said every slot had gone.
      throw conflictError(
        !progress.qualifies
          ? 'You have not qualified for this yet.'
          : progress.slotsLeft <= 0
            ? 'Every slot has gone. Nothing was taken from you — there was simply no money left by the time you got here.'
            : 'That claim is no longer active. Check /progress in the app.',
      );
    }

    const ok = await submitAddress(app, req.portalUser.id, body.walletAddress);
    if (!ok) throw conflictError('That claim is no longer active.');

    // Confirmed in the app, not here. A stolen browser session alone must not
    // be able to redirect somebody's payment, and the address is echoed back in
    // full so a slipped character has one more chance to be spotted.
    await app.enqueue('yapper.dm', {
      userId: req.portalUser.id,
      kind: 'claim_confirm',
      dedupe: `claim_confirm:${req.portalUser.id}:${body.walletAddress.trim()}`,
      payload: { walletAddress: body.walletAddress.trim(), amountUsd: EARLY_CLAIM.amountUsd },
    });

    return reply.send({ ok: true });
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
