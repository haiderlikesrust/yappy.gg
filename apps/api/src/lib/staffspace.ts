import { and, auditLog, conversations, devices, eq, isNull, moderationActions, reports, sql as raw, users } from '@yappy/db';
import {
  REPORT_REASON_LABEL,
  newId,
  type EmbedInput,
  type MessageComponentRow,
  type ReportReason,
} from '@yappy/shared';
import type { FastifyInstance } from 'fastify';
import { env } from '../env.js';
import { forgetAuthUser } from '../plugins/auth.js';
import { suspensionEmail } from './mailer.js';
import { notifyUser } from './notify.js';
import { appealUrl } from './support.js';
import { getYapperUserId } from './yapper.js';

/**
 * The Yappy Staff space.
 *
 * Staff coordination happens *inside the product* rather than in some other
 * company's chat app — the same reasoning Discord's own team lives on
 * Discord. A space marked `system_key = 'staff_space'` holds the team;
 * its #reports channel (`staff_reports`) is where every report lands as a
 * card posted by yapper, with the actions right on it, and #gitlog
 * (`staff_gitlog`) is where the repository's own activity lands. The space is
 * created by `packages/db/scripts/ensure-staff-space.mjs`, never by the API.
 *
 * Everything here degrades to a no-op when the space does not exist yet: a
 * report must never fail to file because the audit surface is missing.
 */

const KEYS = ['staff_space', 'staff_reports', 'staff_general', 'staff_gitlog', 'staff_bugs'] as const;
export type SystemKey = (typeof KEYS)[number];

/** Cached per process — these rows are created once and never change. */
const cache = new Map<SystemKey, string | null>();

export async function getSystemConversationId(
  app: FastifyInstance,
  key: SystemKey,
): Promise<string | null> {
  if (cache.has(key)) return cache.get(key) ?? null;
  const [row] = await app.db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.systemKey, key))
    .limit(1);
  // A miss is cached too: the lookup runs on every report, and hammering the
  // database for a row that does not exist yet helps nobody. The cache is
  // per-process, so creating the space and restarting the API clears it.
  cache.set(key, row?.id ?? null);
  return row?.id ?? null;
}

const AMBER = '#f5a524';

/**
 * Post (or refresh) the card for a report in #reports.
 *
 * The buttons are staff-gated *server-side* via `staffOnly` — being in the
 * channel is not what authorises the press, `users.is_staff` is. That
 * distinction matters the day someone is invited into the space to observe.
 */
export async function postReportCard(
  app: FastifyInstance,
  input: {
    reportId: string;
    reason: string;
    detail: string | null;
    targetLabel: string;
    reporterLabel: string;
    priority: number;
  },
): Promise<void> {
  try {
    const channelId = await getSystemConversationId(app, 'staff_reports');
    const botId = await getYapperUserId(app);
    if (!channelId || !botId) return;

    const embeds: EmbedInput[] = [
      {
        title: `Report · ${REPORT_REASON_LABEL[input.reason as ReportReason] ?? input.reason}`,
        description: input.detail || 'No detail given.',
        color: AMBER,
        fields: [
          { name: 'About', value: input.targetLabel, inline: true },
          { name: 'By', value: input.reporterLabel, inline: true },
          { name: 'Reference', value: input.reportId.slice(0, 8), inline: true },
        ],
        footer: {
          text:
            input.priority >= 80
              ? 'PRIORITY — review this first.'
              : 'Buttons act immediately. The portal has the full evidence.',
        },
      },
    ];

    const components: MessageComponentRow[] = [
      {
        type: 'row',
        components: [
          {
            type: 'button',
            customId: `modreport:resolve:${input.reportId}`,
            label: 'Resolve',
            style: 'success',
            disabled: false,
            staffOnly: true,
          },
          {
            type: 'button',
            customId: `modreport:dismiss:${input.reportId}`,
            label: 'Dismiss',
            style: 'secondary',
            disabled: false,
            staffOnly: true,
          },
          {
            type: 'button',
            customId: `modreport:suspend:${input.reportId}`,
            label: 'Suspend 7d',
            style: 'danger',
            disabled: false,
            staffOnly: true,
          },
        ],
      },
    ];

    const result = await app.messages.send(botId, channelId, {
      nonce: `report_${input.reportId}`,
      type: 'text',
      content: null,
      embeds,
      components,
      silent: false,
    } as never);

    await app.db
      .update(reports)
      .set({ staffMessageId: (result.message as { id: string }).id })
      .where(eq(reports.id, input.reportId));
  } catch (err) {
    // Logged, never thrown: the report is already filed, and the card is the
    // notification, not the record.
    app.log.error({ err }, 'failed to post report card to staff channel');
  }
}

// ─── Acting on a report ──────────────────────────────────────────────────────

const GREEN = '#3dd68c';
const GREY = '#726c8c';
const RED = '#ff6369';

export type ReportAction = 'resolve' | 'dismiss' | 'suspend' | 'warn';

/**
 * The one implementation both surfaces call — the buttons in #reports and the
 * portal's moderation tab. One report, one outcome, whichever acts first; the
 * status check is what makes the second press a polite "already handled"
 * instead of a double suspension.
 *
 * The caller is responsible for having checked `is_staff`. This function
 * records *which* staff member acted — an audit log where every row says
 * "the system" is not an audit log.
 */
export async function applyReportAction(
  app: FastifyInstance,
  input: {
    reportId: string;
    actorId: string;
    action: ReportAction;
    note?: string;
    suspendDays?: number;
    /** The button path rewrites the card itself (as the interaction response);
     *  setting this avoids writing the same message twice in a row. */
    skipCardRewrite?: boolean;
    /** Direct staff commands recheck actor and target inside the action transaction. */
    staffCommand?: boolean;
  },
): Promise<{ ok: boolean; message: string }> {
  const [report] = await app.db
    .select()
    .from(reports)
    .where(eq(reports.id, input.reportId))
    .limit(1);

  if (!report) return { ok: false, message: 'That report does not exist.' };
  if (report.status === 'actioned' || report.status === 'dismissed') {
    return { ok: false, message: `Already handled (${report.status}).` };
  }

  const days = input.suspendDays ?? 7;
  let outcome: string;
  /** Filled inside the transaction, sent after it commits. */
  interface Notice { email: string | null; until: Date; reason: string }
  let notify: Notice | null = null;
  let revokedDeviceIds: string[] = [];

  const notice = await app.db.transaction(async (tx) => {
    const [locked] = await tx.select({ status: reports.status }).from(reports)
      .where(eq(reports.id, input.reportId)).for('update');
    if (!locked || locked.status === 'actioned' || locked.status === 'dismissed') return undefined;
    if (input.staffCommand) {
      const [actor] = await tx.select().from(users).where(eq(users.id, input.actorId)).for('share');
      if (!actor?.isStaff || actor.deletedAt || (actor.suspendedUntil && actor.suspendedUntil > new Date())) throw new Error('Staff access was revoked');
      const [target] = await tx.select().from(users).where(eq(users.id, report.targetId)).for('update');
      if (!target || target.deletedAt || target.isStaff || target.isBot || target.id === input.actorId ||
        (input.action === 'suspend' && target.suspendedUntil && target.suspendedUntil > new Date())) throw new Error('Target account changed; review the case');
    }
    if (input.action === 'suspend') {
      if (report.targetType !== 'user') {
        throw new Error('Only a user report can suspend an account');
      }
      const until = new Date(Date.now() + days * 86_400_000);
      const reason = input.note ?? `Report ${input.reportId.slice(0, 8)}: ${report.reason}`;
      // Read inside the transaction so the letter cannot describe a
      // suspension that then rolled back.
      const [target] = await tx
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, report.targetId))
        .limit(1);
      if (target) notify = { email: target.email, until, reason };
      await tx
        .update(users)
        .set({
          suspendedUntil: until,
          suspensionReason: reason,
          // Suspension must end the sessions, not just refuse new writes —
          // an already-issued access token is a write path for its whole
          // lifetime unless the epoch moves.
          tokenEpoch: raw`${users.tokenEpoch} + 1`,
        })
        .where(eq(users.id, report.targetId));
      const revoked = await tx.update(devices)
        .set({ revokedAt: new Date(), refreshTokenHash: null, previousRefreshTokenHash: null })
        .where(and(eq(devices.userId, report.targetId), isNull(devices.revokedAt)))
        .returning({ id: devices.id });
      revokedDeviceIds = revoked.map((device) => device.id);
    }

    await tx
      .update(reports)
      .set({
        status: input.action === 'dismiss' ? 'dismissed' : 'actioned',
        resolution: input.note ?? input.action,
        resolvedAt: new Date(),
        assignedToId: input.actorId,
      })
      .where(eq(reports.id, input.reportId));

    await tx.insert(moderationActions).values({
      id: newId(),
      moderatorId: input.actorId,
      reportId: input.reportId,
      action: input.action === 'suspend' ? 'suspend' : input.action === 'dismiss' ? 'dismiss' : 'warn',
      targetType: report.targetType,
      targetId: report.targetId,
      reason: input.note ?? report.reason,
      metadata: input.action === 'suspend' ? { days } : {},
    } as never);

    if (input.staffCommand) {
      await tx.insert(auditLog).values({ id: newId(), userId: input.actorId,
        action: `user.${input.action}`, metadata: { targetId: report.targetId, reportId: input.reportId, reason: input.note, ...(input.action === 'suspend' ? { days } : {}) },
      });
    }

    // Handed out rather than read from the outer scope afterwards: a value
    // assigned inside this callback is invisible to the checker outside it.
    return notify;
  });

  if (notice === undefined) return { ok: false, message: 'That report was already handled.' };
  if (input.action === 'warn' && report.targetType === 'user') {
    await notifyUser(app, { userId: report.targetId, kind: 'account_warning', data: {
      title: 'An official warning from yappy', body: input.note ?? report.reason,
      detail: `Reference: ${input.reportId}\n\nPlease review this warning. Your account access has not changed.`,
    } });
  }
  const suspensionData = notice ? {
    title: 'Your account was suspended',
    body: notice.reason,
    until: notice.until.toISOString(),
    supportUrl: await appealUrl(report.targetId, input.reportId),
    detail: `Suspended until ${notice.until.toUTCString()}.\n\nWhile suspended, you cannot sign in or post. Your messages and groups have not been deleted.` +
      (env.SUPPORT_EMAIL ? `\n\nIf you believe this is a mistake, contact ${env.SUPPORT_EMAIL}.` : ''),
  } : null;

  // The suspension must bite on the very next request, not up to a cache
  // TTL later — a suspension that still posts is not a suspension.
  if (input.action === 'suspend') {
    forgetAuthUser(report.targetId);
    // Session revocation is consumed by every gateway replica, including
    // parked sessions that would otherwise remain resumable.
    for (const deviceId of revokedDeviceIds) {
      try {
        await app.events.toUser(report.targetId, 'session.update', {
          deviceId, revoked: true, reason: 'account_suspended', notice: suspensionData,
        });
      } catch (err) {
        app.log.error({ err, deviceId }, 'could not publish suspension session revocation');
      }
    }
  }

  outcome =
    input.action === 'suspend'
      ? `Account suspended for ${days} days.`
      : input.action === 'dismiss'
        ? 'Dismissed — no action taken.'
        : input.action === 'warn' ? 'Official warning recorded and notification requested.' : 'Resolved.';

  /**
   * Tell the people it happened to.
   *
   * Both notices hang off this function rather than off the two surfaces that
   * call it, so acting from the portal and acting from the card in #reports
   * produce the same follow-up. Enqueued, so a moderator's button press does
   * not wait on a DM being composed.
   *
   * The reporter is told only that it was closed — not the outcome. Telling
   * them what happened to the reported account tells a harasser whether their
   * target reported them, which is why the REST endpoint is vague at filing
   * time; being specific at closing time would give the same thing away one
   * step later.
   */
  if (report.reporterId && report.reporterId !== input.actorId) {
    await notifyUser(app, {
      userId: report.reporterId,
      kind: 'report_reviewed',
      data: {
        title: 'Your report has been reviewed',
        body: 'A moderator has reviewed and closed your report. Thank you for sending it.',
        detail: `Reference: ${input.reportId.slice(0, 8)}\n\nWe do not share what action was taken or who took it.`,
      },
    });
    await app.enqueue('yapper.dm', {
      userId: report.reporterId,
      kind: 'report_closed',
      dedupe: input.reportId,
      payload: { reportId: input.reportId },
    });
  }

  if (input.action === 'suspend' && report.targetType === 'user') {
    if (suspensionData) {
      await notifyUser(app, {
        userId: report.targetId,
        kind: 'account_suspended',
        data: suspensionData,
      });
    }
    // Reaches them when they can next sign in: a suspension moves `tokenEpoch`
    // and ends every session, so this sits unread until the suspension does.
    // That is the right time to read it — the alternative is a notice nobody
    // can open, which is no notice at all.
    await app.enqueue('yapper.dm', {
      userId: report.targetId,
      kind: 'suspended',
      dedupe: input.reportId,
      payload: {
        days,
        until: notice?.until.toISOString().slice(0, 10),
        reason: input.note ?? `Report ${input.reportId.slice(0, 8)}: ${report.reason}`,
      },
    });
  }

  // Retire the card in #reports so the queue in chat reflects reality.
  if (report.staffMessageId && !input.skipCardRewrite) {
    try {
      const botId = await getYapperUserId(app);
      const actor = await userLabel(app, input.actorId);
      if (botId) {
        await app.messages.rewriteBotMessage(botId, report.staffMessageId, {
          embeds: [
            {
              title:
                input.action === 'suspend'
                  ? 'Suspended'
                  : input.action === 'dismiss'
                    ? 'Dismissed'
                    : 'Resolved',
              description: `${outcome} — ${actor}`,
              color: input.action === 'suspend' ? RED : input.action === 'dismiss' ? GREY : GREEN,
              fields: [{ name: 'Reference', value: input.reportId.slice(0, 8), inline: true }],
            },
          ],
          components: [],
        });
      }
    } catch (err) {
      app.log.warn({ err }, 'could not retire report card');
    }
  }

  /**
   * Tell them, once the suspension is actually written.
   *
   * Queued rather than awaited inline: a mail provider having a bad minute
   * must not fail a moderation action that has already happened. Skipped
   * entirely when there is no support address configured, because the notice
   * exists to be replied to.
   */
  if (notice?.email && env.SUPPORT_EMAIL) {
    const letter = suspensionEmail({
      reason: notice.reason,
      until: notice.until,
      supportAddress: env.SUPPORT_EMAIL,
      from: env.SUPPORT_FROM || undefined,
    });
    await app.enqueue('email.send', { ...letter, to: notice.email });
  }

  return { ok: true, message: outcome };
}

/** "Display Name (@username)" for a user id, or a fallback that says gone. */
export async function userLabel(app: FastifyInstance, userId: string): Promise<string> {
  const [row] = await app.db
    .select({ username: users.username, displayName: users.displayName })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .limit(1);
  if (!row) return 'deleted account';
  return `${row.displayName ?? row.username ?? 'unknown'} (@${row.username ?? '?'})`;
}
