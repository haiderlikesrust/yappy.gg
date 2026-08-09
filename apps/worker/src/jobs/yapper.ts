import { sql as raw, type Database } from '@yappy/db';
import type { Logger } from 'pino';

/**
 * Noticing things nobody asked about.
 *
 * These are the detections behind yapper's unprompted messages. They run on
 * cron and answer questions that have no request to hang off: has this report
 * been open for a day, has that webhook stopped answering, is anyone looking
 * at the queue this morning.
 *
 * The split with `lib/yapperNotify.ts` in the API is deliberate and worth
 * stating once: **this file decides whether something is worth saying, and
 * says nothing**. It enqueues, and the API renders and delivers, because
 * sending a message requires the MessageService that only the API has.
 *
 * Every enqueue carries a `dedupe` key that is stable for the thing being
 * reported — a date, a report id, an application id and a day. Cron is
 * at-least-once and these queries are re-run on a schedule, so the same alert
 * *will* be raised repeatedly; the key is what turns the repeats into the same
 * message rather than a pile of them. That is also why none of these need to
 * record "already alerted" state of their own.
 */

type Enqueue = (name: string, data: Record<string, unknown>) => Promise<void>;

/** UTC day, the bucket most of the dedupe keys below are built on. */
const today = (): string => new Date().toISOString().slice(0, 10);

/**
 * A report has landed in a category that jumps the queue.
 *
 * The hook this replaces logged loudly and stopped there, which is only a
 * notification if someone is watching the log. CSAM and credible self-harm
 * are precisely the reports that must not wait for the next person to glance
 * at #reports, so they get a message with content rather than an embed alone.
 */
export async function triageReport(
  db: Database,
  log: Logger,
  enqueue: Enqueue,
  job: { reportId: string; reason: string },
): Promise<void> {
  if (job.reason !== 'csam' && job.reason !== 'self_harm') return;

  log.error({ reportId: job.reportId, reason: job.reason }, 'HIGH PRIORITY REPORT');

  await enqueue('yapper.staff', {
    kind: 'priority_report',
    dedupe: job.reportId,
    payload: { reportId: job.reportId, reason: job.reason },
  });
}

/** Where the moderation queue stands, once a day. */
export async function staffDigest(db: Database, log: Logger, enqueue: Enqueue): Promise<void> {
  const rows = (await db.execute(raw`
    select
      (select count(*)::int from reports where status in ('open','reviewing')) as open,
      (select count(*)::int from reports where status in ('open','reviewing') and priority > 0) as priority,
      (select coalesce(max(extract(epoch from (now() - created_at)) / 3600), 0)::int
         from reports where status in ('open','reviewing')) as oldest_hours,
      (select count(*)::int from reports
        where resolved_at is not null and resolved_at > now() - interval '1 day') as closed
  `)) as unknown as Array<{ open: number; priority: number; oldest_hours: number; closed: number }>;

  const stats = rows[0];
  if (!stats) return;

  await enqueue('yapper.staff', {
    kind: 'digest',
    dedupe: today(),
    payload: {
      open: stats.open,
      priority: stats.priority,
      oldestHours: stats.oldest_hours,
      closed: stats.closed,
    },
  });

  log.debug({ open: stats.open }, 'staff digest enqueued');
}

/**
 * Reports that have been sitting for over a day.
 *
 * Deduped per day rather than per hour: the point is to be noticed once by a
 * team that has let something slip, not to repeat every hour until they have.
 * An hourly nag about a backlog is how a channel gets muted, and a muted
 * channel is where the next priority report goes unread.
 */
export async function agingReports(db: Database, log: Logger, enqueue: Enqueue): Promise<void> {
  const rows = (await db.execute(raw`
    select count(*)::int as overdue,
           coalesce(max(extract(epoch from (now() - created_at)) / 3600), 0)::int as oldest_hours
      from reports
     where status in ('open','reviewing')
       and created_at < now() - interval '1 day'
  `)) as unknown as Array<{ overdue: number; oldest_hours: number }>;

  const stats = rows[0];
  if (!stats || stats.overdue === 0) return;

  await enqueue('yapper.staff', {
    kind: 'backlog',
    dedupe: today(),
    payload: { overdue: stats.overdue, oldestHours: stats.oldest_hours },
  });
}

/**
 * Several people reporting the same account in a short window.
 *
 * Three independent reports in a day is a different signal from three reports
 * spread over a year, and reading them one at a time as they arrive is how a
 * coordinated problem looks like three unremarkable ones. Distinct reporters,
 * so somebody filing repeatedly about the same person does not raise it alone.
 */
export async function reportSpikes(db: Database, log: Logger, enqueue: Enqueue): Promise<void> {
  const rows = (await db.execute(raw`
    select r.target_id,
           count(distinct r.reporter_id)::int as reporters,
           coalesce(u.display_name, u.username, 'deleted account') as label,
           u.username
      from reports r
      left join users u on u.id = r.target_id
     where r.target_type = 'user'
       and r.created_at > now() - interval '1 day'
       and r.status in ('open','reviewing')
     group by r.target_id, u.display_name, u.username
    having count(distinct r.reporter_id) >= 3
     limit 10
  `)) as unknown as Array<{
    target_id: string;
    reporters: number;
    label: string;
    username: string | null;
  }>;

  for (const row of rows) {
    await enqueue('yapper.staff', {
      kind: 'spike',
      // Per target per day: a spike that stays a spike should not re-announce
      // itself every hour while the team is already looking at it.
      dedupe: `${row.target_id}_${today()}`,
      payload: {
        targetLabel: row.username ? `${row.label} (@${row.username})` : row.label,
        count: row.reporters,
      },
    });
  }

  if (rows.length > 0) log.info({ targets: rows.length }, 'report spikes flagged');
}

/**
 * Webhooks that have stopped answering, told to the owner rather than logged.
 *
 * Five consecutive failures is one exhausted retry budget — the point at which
 * events stop being delivered late and start being dropped. Before this, the
 * only signal was a warn line in our logs, which is the wrong place entirely:
 * the person who can fix it does not read them.
 */
export async function failingWebhooks(db: Database, log: Logger, enqueue: Enqueue): Promise<void> {
  const rows = (await db.execute(raw`
    select a.id, a.name, a.owner_id, a.webhook_failure_count, a.webhook_last_success_at
      from applications a
      join users u on u.id = a.owner_id and u.deleted_at is null
     where a.revoked_at is null
       and a.webhook_url is not null
       and a.webhook_failure_count >= 5
       and a.webhook_last_failure_at > now() - interval '1 day'
     limit 50
  `)) as unknown as Array<{
    id: string;
    name: string;
    owner_id: string;
    webhook_failure_count: number;
    webhook_last_success_at: string | null;
  }>;

  for (const row of rows) {
    await enqueue('yapper.dm', {
      userId: row.owner_id,
      kind: 'webhook_failing',
      // Once a day per application while it stays broken. Often enough to be a
      // reminder, rare enough that the fix is not competing with the alerts.
      dedupe: `${row.id}_${today()}`,
      payload: {
        name: row.name,
        failures: row.webhook_failure_count,
        lastSuccessAt: row.webhook_last_success_at
          ? String(row.webhook_last_success_at).slice(0, 16).replace('T', ' ') + ' UTC'
          : null,
      },
    });
  }

  if (rows.length > 0) log.info({ applications: rows.length }, 'failing webhooks flagged');
}

/**
 * Bot tokens nobody has rotated in a year.
 *
 * A nudge, not a policy — nothing expires, because breaking every long-running
 * bot on an anniversary would be a worse outage than the risk it addresses.
 * Monthly per application so it reads as housekeeping rather than an alarm.
 */
export async function ageingTokens(db: Database, log: Logger, enqueue: Enqueue): Promise<void> {
  const rows = (await db.execute(raw`
    select a.id, a.name, a.owner_id,
           (extract(epoch from (now() - a.token_issued_at)) / 86400)::int as age_days
      from applications a
      join users u on u.id = a.owner_id and u.deleted_at is null
     where a.revoked_at is null
       and a.token_issued_at < now() - interval '365 days'
     limit 50
  `)) as unknown as Array<{ id: string; name: string; owner_id: string; age_days: number }>;

  const month = today().slice(0, 7);

  for (const row of rows) {
    await enqueue('yapper.dm', {
      userId: row.owner_id,
      kind: 'token_ageing',
      dedupe: `${row.id}_${month}`,
      payload: { name: row.name, ageDays: row.age_days },
    });
  }

  if (rows.length > 0) log.debug({ applications: rows.length }, 'ageing tokens flagged');
}
