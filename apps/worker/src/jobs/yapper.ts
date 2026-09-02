import { sql as raw, type Database } from '@yappy/db';
import { EARLY_CLAIM } from '@yappy/shared';
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

/**
 * Testers who have earned the early reward and not been offered it.
 *
 * Detection only. Whether a slot actually gets spent is decided in the API,
 * one candidate at a time, because there are three payments in total and that
 * is a decision about money rather than a query — see the `yapper.claim_offer`
 * consumer. Enqueuing somebody here promises them nothing.
 *
 * Bounded per pass. There is no scenario at this size where more than a
 * handful qualify in an hour, and a bug that made every user look eligible
 * should cost one small batch rather than a broadcast.
 */
export async function earlyClaimOffers(db: Database, log: Logger, enqueue: Enqueue): Promise<void> {
  if (!EARLY_CLAIM.open) return;

  // Cheap gate first: if every slot is spoken for there is nothing to look for.
  const taken = (await db.execute(raw`
    select count(*)::int as n from early_claims
     where status in ('reserved','submitted','paid')
       and (status <> 'reserved' or expires_at > now())
  `)) as unknown as Array<{ n: number }>;
  if ((taken[0]?.n ?? 0) >= EARLY_CLAIM.slots) return;

  const rows = (await db.execute(raw`
    select u.id
      from users u
      left join early_claims c on c.user_id = u.id
     where u.is_bot = false
       and u.deleted_at is null
       and c.id is null
       and (
         (select count(*) from bug_reports b
           where b.reporter_id = u.id and b.status in ('fixed','known'))
             >= ${EARLY_CLAIM.acceptedBugsRequired}
         or
         (select count(*) from messages m
           where m.sender_id = u.id and m.deleted_at is null
             and (
               exists (select 1 from message_reactions r
                        where r.message_id = m.id and r.user_id <> m.sender_id)
               or exists (select 1 from messages q
                           where q.reply_to_id = m.id and q.deleted_at is null
                             and q.sender_id <> m.sender_id)
             ))
             >= ${EARLY_CLAIM.answeredRequired}
       )
     -- Oldest account first, so a tie for the last slot breaks on who was here
     -- first rather than on whatever order the planner felt like.
     order by u.created_at
     limit ${EARLY_CLAIM.slots}
  `)) as unknown as Array<{ id: string }>;

  if (rows.length === 0) return;
  log.info({ candidates: rows.length }, 'early claim candidates');

  for (const row of rows) {
    // Re-queuing the same person is harmless and self-limiting: the query
    // above excludes anyone who already has a claim row, and the API refuses a
    // second reservation on the unique index regardless.
    await enqueue('yapper.claim_offer', { userId: row.id });
  }
}

/**
 * The lurker.
 *
 * Thirty days in a group, read everything, never said a word. Once — the
 * nonce carries (group, person), and the moment they answer back (which is
 * the point) the "never sent a message" clause excludes them for good. One
 * per group per day, longest-standing lurker first, so a quiet group with
 * three of them is teased on three mornings rather than one.
 *
 * Only where yapper has been let in, only in groups, and not where somebody
 * ran `/yapper quiet` — the API re-checks all three at delivery, but
 * filtering here keeps the queue from carrying lines that will be dropped.
 */
export async function lurkers(db: Database, log: Logger, enqueue: Enqueue): Promise<void> {
  const rows = (await db.execute(raw`
    with bot as (
      select id from users where username = 'yapper' and is_bot = true and deleted_at is null
    )
    select distinct on (c.id)
           c.id as conversation_id,
           m.user_id,
           coalesce(u.display_name, u.username, 'someone') as name,
           (m.last_read_seq - m.history_start_seq)::int as read_count,
           extract(day from now() - m.joined_at)::int as days
      from conversation_members m
      join conversations c
        on c.id = m.conversation_id
       and c.type = 'group' and c.parent_id is null and c.deleted_at is null
      join users u on u.id = m.user_id and u.is_bot = false and u.deleted_at is null
      join conversation_members mb
        on mb.conversation_id = c.id and mb.user_id = (select id from bot) and mb.left_at is null
     where m.left_at is null
       and m.user_id <> (select id from bot)
       and m.joined_at < now() - interval '30 days'
       -- Read everything: the cursor sits at (or within a breath of) the head.
       and m.last_read_seq >= c.message_seq - 5
       -- And there was something to read. A hundred messages is a lurk; ten is a quiet group.
       and m.last_read_seq - m.history_start_seq >= 100
       and not exists (
             select 1 from messages s where s.conversation_id = c.id and s.sender_id = m.user_id
           )
       and not exists (
             select 1 from messages y
              where y.sender_id = (select id from bot)
                and y.nonce = 'yapper_lurker_' || c.id || '_' || m.user_id
           )
       and coalesce((c.settings ->> 'yapperQuiet')::boolean, false) = false
     order by c.id, m.joined_at
     limit 200
  `)) as unknown as Array<{
    conversation_id: string;
    user_id: string;
    name: string;
    read_count: number;
    days: number;
  }>;

  if (rows.length === 0) return;
  log.info({ lurkers: rows.length }, 'lurkers noticed');

  for (const row of rows) {
    const n = row.read_count.toLocaleString('en-US');
    const lines = [
      `${row.name} has read ${n} messages here and said nothing. we see you.`,
      `${n} messages read, zero sent. ${row.name}, blink twice if you're okay.`,
      `${row.name} joined ${row.days} days ago, has read everything, and has never spoken. a ghost with read receipts.`,
    ];
    await enqueue('yapper.line', {
      conversationId: row.conversation_id,
      nonce: `yapper_lurker_${row.conversation_id}_${row.user_id}`,
      content: lines[Math.floor(Math.random() * lines.length)],
    });
  }
}

/**
 * Happy birthday, once a year.
 *
 * `users.birthday` is a timezone-free 'YYYY-MM-DD' string that until now
 * nothing read. Matched on month and day against the UTC date; a Feb 29
 * birthday is celebrated on Mar 1 in non-leap years, because skipping
 * somebody's birthday three years out of four is worse than being a day late.
 * The dedupe key carries the year, so the daily cron re-running cannot wish
 * twice and next year wishes again.
 */
export async function birthdayWishes(db: Database, log: Logger, enqueue: Enqueue): Promise<void> {
  const now = new Date();
  const mmdd = now.toISOString().slice(5, 10);
  const year = now.getUTCFullYear();
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const also = mmdd === '03-01' && !isLeap ? '02-29' : mmdd;

  const rows = (await db.execute(raw`
    select id, display_name, username
      from users
     where deleted_at is null
       and is_bot = false
       and birthday is not null
       and substring(birthday from 6 for 5) in (${mmdd}, ${also})
  `)) as unknown as Array<{ id: string; display_name: string | null; username: string | null }>;

  if (rows.length === 0) return;
  log.info({ birthdays: rows.length }, 'birthday wishes queued');

  for (const row of rows) {
    await enqueue('yapper.dm', {
      userId: row.id,
      kind: 'birthday',
      dedupe: `${row.id}_${year}`,
      payload: { name: row.display_name ?? row.username ?? '' },
    });

    // And the groups hear about it — the API finds which ones and posts a
    // party per group, idempotent per (user, year, conversation).
    await enqueue('yapper.party', { userId: row.id, year });
  }
}
