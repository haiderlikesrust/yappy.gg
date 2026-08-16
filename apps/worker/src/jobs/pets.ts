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
