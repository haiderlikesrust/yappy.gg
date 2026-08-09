import { and, conversations, eq, isNull, moderationActions, reports, sql as raw, users } from '@yappy/db';
import {
  REPORT_REASON_LABEL,
  newId,
  type EmbedInput,
  type MessageComponentRow,
  type ReportReason,
} from '@yappy/shared';
import type { FastifyInstance } from 'fastify';
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

const KEYS = ['staff_space', 'staff_reports', 'staff_general', 'staff_gitlog'] as const;
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

export type ReportAction = 'resolve' | 'dismiss' | 'suspend';

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

  await app.db.transaction(async (tx) => {
    if (input.action === 'suspend') {
      if (report.targetType !== 'user') {
        throw new Error('Only a user report can suspend an account');
      }
      const until = new Date(Date.now() + days * 86_400_000);
      await tx
        .update(users)
        .set({
          suspendedUntil: until,
          suspensionReason: input.note ?? `Report ${input.reportId.slice(0, 8)}: ${report.reason}`,
          // Suspension must end the sessions, not just refuse new writes —
          // an already-issued access token is a write path for its whole
          // lifetime unless the epoch moves.
          tokenEpoch: raw`${users.tokenEpoch} + 1`,
        })
        .where(eq(users.id, report.targetId));
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
  });

  outcome =
    input.action === 'suspend'
      ? `Account suspended for ${days} days.`
      : input.action === 'dismiss'
        ? 'Dismissed — no action taken.'
        : 'Resolved.';

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
    await app.enqueue('yapper.dm', {
      userId: report.reporterId,
      kind: 'report_closed',
      dedupe: input.reportId,
      payload: { reportId: input.reportId },
    });
  }

  if (input.action === 'suspend' && report.targetType === 'user') {
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
        until: new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10),
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
