import { and, desc, eq, isNull, moderationActions, reports, users, type User } from '@yappy/db';
import { AppError, ErrorCode, unauthenticated } from '@yappy/shared';
import type { FastifyInstance } from 'fastify';
import { SignJWT, jwtVerify } from 'jose';
import { env } from '../env.js';

const secret = new TextEncoder().encode(env.JWT_SECRET);

/** A case identifier for support, deliberately unusable as an app/portal token. */
export async function appealUrl(userId: string, reportId: string): Promise<string> {
  const token = await new SignJWT({ typ: 'support_appeal', reportId })
    .setProtectedHeader({ alg: 'HS256' }).setIssuer(env.JWT_ISSUER)
    .setAudience('yappy-support').setSubject(userId).setIssuedAt().setExpirationTime('30d').sign(secret);
  // A fragment is not sent in HTTP requests, referrers or proxy access logs.
  return `${env.PUBLIC_WEB_URL.replace(/\/$/, '')}/support#appeal=${encodeURIComponent(token)}`;
}

export async function readAppealContext(app: FastifyInstance, token: string) {
  let userId: string;
  let reportId: string;
  const unavailable = () => unauthenticated('This appeal link has expired or is no longer available. You can still send an account-help request.');
  try {
    const { payload } = await jwtVerify(token, secret, {
      issuer: env.JWT_ISSUER, audience: 'yappy-support', algorithms: ['HS256'],
    });
    if (payload.typ !== 'support_appeal' || typeof payload.sub !== 'string' ||
        typeof payload.reportId !== 'string') throw new Error('wrong token scope');
    userId = payload.sub;
    reportId = payload.reportId;
  } catch {
    throw unavailable();
  }
  // A database outage is a server failure, not an expired link.
  const [context] = await app.db.select({ userId: users.id, username: users.username, reportId: reports.id })
    .from(reports).innerJoin(users, eq(users.id, reports.targetId))
    .where(and(eq(reports.id, reportId), eq(reports.targetType, 'user'),
      eq(users.id, userId), isNull(users.deletedAt))).limit(1);
  if (!context) throw unavailable();
  return context;
}

/** Called only after sign-in credentials have been verified. No session is issued. */
export async function rejectSuspendedSignIn(app: FastifyInstance, user: User): Promise<void> {
  if (!user.suspendedUntil || user.suspendedUntil <= new Date()) return;
  const [action] = await app.db.select({ reportId: moderationActions.reportId })
    .from(moderationActions)
    .where(and(eq(moderationActions.targetId, user.id), eq(moderationActions.targetType, 'user'),
      eq(moderationActions.action, 'suspend')))
    .orderBy(desc(moderationActions.createdAt)).limit(1);
  const supportUrl = action?.reportId ? await appealUrl(user.id, action.reportId)
    : `${env.PUBLIC_WEB_URL.replace(/\/$/, '')}/support?topic=appeal`;
  throw new AppError(403, ErrorCode.AccountSuspended,
    `Your account is suspended until ${user.suspendedUntil.toUTCString()}.` +
      (user.suspensionReason ? ` ${user.suspensionReason}` : ''),
    { details: { supportUrl } });
}
