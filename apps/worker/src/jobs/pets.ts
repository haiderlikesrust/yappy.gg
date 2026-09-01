import { sql as raw, type Database } from '@yappy/db';
import type { Logger } from 'pino';

/**
 * The daily tending of the group pets.
 *
 * Feeding is not an action anyone takes — it is the group talking. A fed day
 * is a day with a handful of messages from more than one human; the cron
 * counts those, grows streaks, and notices the pets nobody has talked near
 * for two weeks, which wander off. Mood is not handled here at all: it decays
 * hour by hour and is derived at read time from the conversation's own
 * `last_message_at`.
 *
 * Everything is idempotent on the day: `last_fed_on` refuses a second feed,
 * and wandering checks its own null. Cron re-runs are absorbed.
 */
export async function tendGroupPets(db: Database, log: Logger): Promise<void> {
  // Hatch a pet for every group that does not have one. Lazily and centrally,
  // so no create/join code path ever has to remember pets exist. Campfires
  // get one too — it burns down with the place, which is the theme.
  await db.execute(raw`
    insert into group_pets (conversation_id)
    select c.id
      from conversations c
     where c.type = 'group'
       and c.deleted_at is null
       and c.parent_id is null
    on conflict (conversation_id) do nothing
  `);

  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

  /**
   * A fed day: at least five messages from at least two distinct humans in
   * the last 24 hours. Two thresholds on purpose — one person monologuing at
   * a wall is not a living group, and neither is a bot filling the silence.
   */
  const fed = (await db.execute(raw`
    with activity as (
      select m.conversation_id, count(*) as msgs, count(distinct m.sender_id) as senders
        from messages m
        join users u on u.id = m.sender_id and u.is_bot = false
       where m.created_at > now() - interval '24 hours'
         and m.deleted_at is null
       group by m.conversation_id
    )
    update group_pets p
       set fed_days = p.fed_days + 1,
           streak = case when p.last_fed_on = ${yesterday} then p.streak + 1 else 1 end,
           last_fed_on = ${today},
           wandered_at = null
      from activity a
     where a.conversation_id = p.conversation_id
       and a.msgs >= 5
       and a.senders >= 2
       and (p.last_fed_on is null or p.last_fed_on < ${today})
    returning p.conversation_id
  `)) as unknown as Array<{ conversation_id: string }>;

  /**
   * Two silent weeks and the pet wanders off. The streak goes with it; the
   * fed days (growth) stay, because it is the same creature when it comes
   * back — the cost is the streak and the empty spot on the card, not the
   * years. `born_at` guards the grace period for brand-new pets in brand-new
   * quiet groups.
   */
  const wandered = (await db.execute(raw`
    update group_pets p
       set wandered_at = now(), streak = 0
      from conversations c
     where c.id = p.conversation_id
       and p.wandered_at is null
       and p.born_at < now() - interval '14 days'
       and (c.last_message_at is null or c.last_message_at < now() - interval '14 days')
    returning p.conversation_id
  `)) as unknown as Array<{ conversation_id: string }>;

  if (fed.length > 0 || wandered.length > 0) {
    log.info({ fed: fed.length, wandered: wandered.length }, 'group pets tended');
  }
}

/** ISO week label in UTC, e.g. `2026-W36`. Part of every recap nonce, so a
 *  retried job re-posts nothing and next week posts fresh. */
export function isoWeekLabel(date: Date): string {
  // Thursday of the current week decides the ISO year and week number.
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * The label of the week the recap describes: the one holding the most recent
 * Saturday, i.e. the last *completed* ISO week.
 *
 * Not `isoWeekLabel(now)` — the cron drains on Sunday, when "now" already sits
 * in the NEXT ISO week (ISO weeks run Mon–Sun... no: Mon–Sun means Sunday is
 * the last day of week N, but a job delayed past Monday midnight would label
 * itself N+1, and that nonce would then swallow the following week's real
 * recap). Anchoring on the most recent Saturday gives the same answer from
 * Sunday morning through the following Friday, so a drain delayed by an
 * outage still names the week it is actually reporting on.
 */
export function completedWeekLabel(now: Date): string {
  const d = new Date(now.getTime());
  d.setUTCHours(0, 0, 0, 0);
  while (d.getUTCDay() !== 6) d.setUTCDate(d.getUTCDate() - 1);
  return isoWeekLabel(d);
}

/**
 * Which groups get a weekly recap card, decided here; what it says, decided
 * by the API (`yapper.recap`), which owns message sending.
 *
 * A recap goes to a group that actually had a week — the same two-threshold
 * idea as a fed day, scaled up: enough messages that there is something to
 * count, from more than one human, so a recap never narrates a monologue or
 * a bot filling the silence. And only where yapper has been let in: the pet
 * does the remembering, but yapper does the talking, and a bot nobody added
 * does not get to speak.
 */
export async function enqueueWeeklyRecaps(
  db: Database,
  log: Logger,
  enqueue: (
    name: string,
    data: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => Promise<void>,
): Promise<void> {
  // The same seven complete UTC days the card will describe — anchored, so
  // the eligibility decision and the delivered numbers agree.
  const windowEnd = new Date();
  windowEnd.setUTCHours(0, 0, 0, 0);
  const windowStart = new Date(windowEnd.getTime() - 7 * 86_400_000);

  const rows = (await db.execute(raw`
    with bot as (
      -- The API's YAPPER_USERNAME; a worker-side lookup because the worker
      -- deliberately cannot import API code.
      select id from users where username = 'yapper' and is_bot = true and deleted_at is null
    )
    select m.conversation_id
      from messages m
      join users u on u.id = m.sender_id and u.is_bot = false
      join conversations c on c.id = m.conversation_id
       and c.type = 'group' and c.parent_id is null and c.deleted_at is null
      join conversation_members mb
        on mb.conversation_id = c.id
       and mb.user_id = (select id from bot)
       and mb.left_at is null
     where m.created_at >= ${windowStart.toISOString()}::timestamptz
       and m.created_at < ${windowEnd.toISOString()}::timestamptz
       and m.deleted_at is null
     group by m.conversation_id
    having count(*) >= 10 and count(distinct m.sender_id) >= 2
  `)) as unknown as Array<{ conversation_id: string }>;

  if (rows.length === 0) return;
  const week = completedWeekLabel(new Date());
  for (const row of rows) {
    // singletonKey suppresses the duplicates that a cron retry or the hourly
    // catch-up would otherwise enqueue; the message nonce downstream is the
    // final backstop. pg-boss ignores a bare key on a standard queue, hence
    // the paired singletonHours window.
    await enqueue(
      'yapper.recap',
      { conversationId: row.conversation_id, week },
      { singletonKey: `${row.conversation_id}:${week}`, singletonHours: 24 },
    );
  }
  log.info({ recaps: rows.length, week }, 'weekly recaps queued');
}
