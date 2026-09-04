import {
  and,
  blocks,
  conversationMembers,
  conversations,
  eq,
  isNull,
  sql as raw,
  users,
} from '@yappy/db';
import {
  Event,
  REPORT_REASON_LABEL,
  dmKey,
  newId,
  type EmbedInput,
  type MessageComponentRow,
  type ReportReason,
} from '@yappy/shared';
import type { FastifyInstance } from 'fastify';
import { getSystemConversationId, type SystemKey } from './staffspace.js';
import { getYapperUserId } from './yapper.js';

/**
 * yapper speaking first.
 *
 * Everything in `yapper.ts` is a reply: someone typed something, and the bot
 * answered in the conversation they typed it in. This is the other half —
 * a sign-in from a device nobody recognises, a webhook that stopped answering
 * three hours ago, the morning's moderation queue. Nobody asked, which is
 * exactly what makes it worth having and exactly what makes it dangerous.
 *
 * Two rules hold the danger down, and both are enforced here rather than at
 * the dozen call sites that enqueue this work:
 *
 * 1. **Every unprompted DM is either security or optional.** Security notices
 *    (an unfamiliar sign-in, a suspension) go out regardless of preference,
 *    because they are things an account holder is owed. Everything else is
 *    gated on `notifications.announcements` and carries its own off switch.
 * 2. **Every send is idempotent.** The queue is at-least-once and the cron
 *    detections are re-run on a schedule, so the same alert *will* be enqueued
 *    twice. `nonce` is what makes the second one a no-op, which is why every
 *    job has to name a stable `dedupe` key rather than being handed a fresh id.
 */

const VIOLET = '#8b7cff';
const AMBER = '#f5a524';
const GREEN = '#3dd68c';
const RED = '#ff6369';
const GREY = '#8b90a0';

export type YapperDmKind =
  /**
   * The original welcome, kept for the jobs already in the queue when this
   * deploys. Nothing enqueues it any more — see `welcome_v2`.
   */
  | 'welcome'
  /** What a new account is actually sent. */
  | 'welcome_v2'
  | 'new_device'
  | 'suspended'
  | 'report_closed'
  | 'webhook_failing'
  | 'webhook_test_result'
  | 'token_ageing'
  /** Once a year, from the bot. Optional like every other nicety. */
  | 'birthday'
  /**
   * A staff announcement, sent to everyone. Deliberately *not* in
   * `SECURITY_KINDS`: a product update is exactly the kind of message the
   * announcements preference exists to decline.
   */
  | 'announcement'
  /**
   * A badge granted or taken back.
   *
   * Not a security notice, so it respects the announcements preference like
   * every other optional message — but it is about *them*, so it is worth
   * saying rather than leaving to be noticed.
   */
  | 'badge_changed'
  /**
   * What happened to a bug they reported.
   *
   * Unlike `report_closed`, this one *does* say the outcome. A moderation
   * report is about another person and the outcome is none of the reporter's
   * business; a bug is about our software and they are owed the answer. Silence
   * here is what stops the next report being filed.
   */
  | 'bug_update'
  /**
   * A slot in the early-tester reward is theirs.
   *
   * Sent only after the slot is actually reserved, never on qualifying alone.
   * The treasury is three payments wide; telling a fourth person they have won
   * something and letting them discover otherwise is worse than never running
   * the reward at all.
   */
  | 'early_claim'
  /**
   * "Is this the address?" — asked in the app, after it was typed on the web.
   *
   * Two jobs. A stolen browser session on its own cannot redirect somebody's
   * payment, and the address gets read once more by the person it belongs to.
   * The second matters more than it looks: a Solana address carries no
   * checksum, so nothing on the server can tell a typo from a real address,
   * and this is the last point at which a slipped character can be caught.
   */
  | 'claim_confirm'
  /** The money has gone out. */
  | 'claim_paid';

export interface YapperDmJob {
  userId: string;
  kind: YapperDmKind;
  /**
   * Stable identity for this notification — a device id, a report id, a date
   * bucket. Combined with the kind it becomes the message nonce, so a retried
   * job or a cron detection that fires again resolves to the same message
   * instead of a second copy.
   */
  dedupe: string;
  payload?: Record<string, unknown>;
}

export type YapperStaffKind = 'digest' | 'backlog' | 'spike' | 'priority_report' | 'gitlog';

export interface YapperStaffJob {
  kind: YapperStaffKind;
  dedupe: string;
  payload?: Record<string, unknown>;
}

/**
 * Which channel each staff notice belongs in.
 *
 * Moderation and repository activity have nothing to say to each other, and
 * one channel carrying both is a channel where the report that needed
 * answering is four commits up the scrollback. Keyed by kind so the routing
 * lives next to the rendering rather than at the enqueue sites.
 */
const STAFF_CHANNEL: Record<YapperStaffKind, SystemKey> = {
  digest: 'staff_reports',
  backlog: 'staff_reports',
  spike: 'staff_reports',
  priority_report: 'staff_reports',
  gitlog: 'staff_gitlog',
};

/**
 * Notices that ignore `notifications.announcements`, and ignore a block on
 * yapper.
 *
 * The line is not "important" — everything here is important to someone. It
 * is whether the message is *about the security of the account itself*. A
 * person who turned off tips did not thereby consent to never being told that
 * their password was used from a machine they do not own, and blocking the
 * first-party bot must not be a way to stop an attacker's victim finding out.
 */
const SECURITY_KINDS = new Set<YapperDmKind>(['new_device', 'suspended']);

// ─── The DM ──────────────────────────────────────────────────────────────────

/**
 * The conversation yapper talks to someone in, creating it if this is the
 * first thing it has ever said to them.
 *
 * Written out here rather than calling `ConversationService.create` because
 * that path runs `assertCanInitiate`, which applies the recipient's `whoCanDm`
 * audience and block list. Those are the right rules for a *person* opening a
 * DM and the wrong ones for the account that tells you your password was just
 * used in Ohio: "only my contacts may message me" is a statement about social
 * contact, not a request to be cut off from security notices. The block and
 * preference checks that *do* apply are in `deliverYapperDm`, where they can
 * be applied per kind.
 */
async function ensureYapperDm(
  app: FastifyInstance,
  botId: string,
  userId: string,
): Promise<string | null> {
  const key = dmKey(botId, userId);

  const [existing] = await app.db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.dmKey, key), isNull(conversations.deletedAt)))
    .limit(1);

  if (existing) {
    // Re-open the thread if either side had left it, the same as opening a DM
    // with someone you had cleared. A notice delivered into a conversation the
    // recipient cannot see is not a notice.
    await app.db
      .update(conversationMembers)
      .set({ leftAt: null })
      .where(eq(conversationMembers.conversationId, existing.id));
    return existing.id;
  }

  const id = newId();
  try {
    await app.db.transaction(async (tx) => {
      await tx.insert(conversations).values({
        id,
        type: 'dm',
        dmKey: key,
        createdById: botId,
        disappearingSeconds: 0,
      });
      await tx.insert(conversationMembers).values([
        { conversationId: id, userId: botId, role: 'member' },
        { conversationId: id, userId, role: 'member' },
      ]);
    });
  } catch (err) {
    // Lost the race against the person opening the DM themselves. The unique
    // index on `dm_key` is what makes that safe; read the winner.
    if ((err as { code?: string }).code === '23505') {
      const [row] = await app.db
        .select({ id: conversations.id })
        .from(conversations)
        .where(eq(conversations.dmKey, key))
        .limit(1);
      return row?.id ?? null;
    }
    throw err;
  }

  // Their client needs to know the thread exists, or the message lands in a
  // conversation that only appears after a cold restart.
  try {
    const view = await app.conversations.view(id, userId);
    await app.events.toUsers([userId], Event.ConversationCreate, view);
  } catch (err) {
    app.log.warn({ err, userId }, 'could not publish yapper DM creation');
  }

  return id;
}

/** Has this person blocked yapper? Only consulted for optional notices. */
async function hasBlockedYapper(
  app: FastifyInstance,
  userId: string,
  botId: string,
): Promise<boolean> {
  const [row] = await app.db
    .select({ blockerId: blocks.blockerId })
    .from(blocks)
    .where(and(eq(blocks.blockerId, userId), eq(blocks.blockedId, botId)))
    .limit(1);
  return Boolean(row);
}

/**
 * Deliver one unprompted DM.
 *
 * Never throws for a reason that will not fix itself — a missing recipient, a
 * preference that says no, an unknown kind. Those are outcomes, not failures,
 * and throwing would hand pg-boss five retries of something guaranteed to be
 * refused identically each time. A genuine fault (the database, the send)
 * still throws, because that one is worth retrying.
 */
export async function deliverYapperDm(app: FastifyInstance, job: YapperDmJob): Promise<void> {
  const botId = await getYapperUserId(app);
  if (!botId || botId === job.userId) return;

  const [recipient] = await app.db
    .select({ notifications: users.notifications, deletedAt: users.deletedAt })
    .from(users)
    .where(eq(users.id, job.userId))
    .limit(1);
  if (!recipient || recipient.deletedAt) return;

  if (!SECURITY_KINDS.has(job.kind)) {
    // `!== false` rather than `=== true`: a row written before this setting
    // existed has no key, and the default is on.
    if (recipient.notifications?.announcements === false) return;
    if (await hasBlockedYapper(app, job.userId, botId)) return;
  }

  const card = renderDm(job);
  if (!card) {
    app.log.warn({ kind: job.kind }, 'unknown yapper DM kind');
    return;
  }

  const conversationId = await ensureYapperDm(app, botId, job.userId);
  if (!conversationId) return;

  const result = await app.messages.send(botId, conversationId, {
    nonce: `yapper_${job.kind}_${job.dedupe}`,
    type: 'text',
    content: card.content,
    embeds: card.embeds,
    components: card.components,
    silent: false,
  } as never);

  /**
   * The invariant that was silently false for a week.
   *
   * Idempotency is scoped to `(sender_id, nonce)`, and yapper is the sender of
   * every one of these — so two recipients sharing a `dedupe` do not each get
   * a message, they share *one*, and whoever sorts second gets nothing while
   * the send reports success. A broadcast did exactly that: 215 people, one
   * message, no error anywhere.
   *
   * A resolved-but-elsewhere message is the signature of that mistake, and it
   * cannot be detected any other way, so it is checked rather than assumed.
   */
  if (!result.created && result.message.conversationId !== conversationId) {
    app.log.error(
      { kind: job.kind, dedupe: job.dedupe, userId: job.userId },
      'yapper DM dedupe key is shared between recipients — this notice was not delivered',
    );
  }
}

// ─── The party ───────────────────────────────────────────────────────────────

export interface YapperPartyJob {
  /** Whose day it is. */
  userId: string;
  /** The year, part of every nonce so next year celebrates again. */
  year: number;
}

/**
 * Announce somebody's birthday in the groups they share with yapper.
 *
 * The DM wish already existed; this is the group-first half. Consent is the
 * `/birthday` command itself — the confirmation card says the groups will
 * hear about it, and `/birthday clear` is checked again here at delivery, so
 * changing your mind any time before the day still works.
 *
 * Idempotency is per (user, year, conversation): the message nonce carries all
 * three, so a retried job re-posts nothing and next year posts fresh.
 */
export async function deliverYapperParty(app: FastifyInstance, job: YapperPartyJob): Promise<void> {
  const botId = await getYapperUserId(app);
  if (!botId || botId === job.userId) return;

  const [person] = await app.db
    .select({ name: users.displayName, username: users.username, birthday: users.birthday, deletedAt: users.deletedAt })
    .from(users)
    .where(eq(users.id, job.userId))
    .limit(1);
  // Cleared birthday means withdrawn consent; a party is the last thing to
  // throw anyway when the account is gone or the bot is blocked.
  if (!person || person.deletedAt || !person.birthday) return;
  if (await hasBlockedYapper(app, job.userId, botId)) return;

  const rows = (await app.db.execute(raw`
    select c.id
      from conversations c
      join conversation_members mu on mu.conversation_id = c.id
       and mu.user_id = ${job.userId} and mu.left_at is null
      join conversation_members mb on mb.conversation_id = c.id
       and mb.user_id = ${botId} and mb.left_at is null
     where c.type = 'group' and c.deleted_at is null
     limit 20
  `)) as unknown as Array<{ id: string }>;
  if (rows.length === 0) return;

  const name = person.name ?? person.username ?? 'someone in here';

  for (const row of rows) {
    try {
      await app.messages.send(botId, row.id, {
        nonce: `yapper_party_${job.userId}_${job.year}_${row.id}`,
        type: 'text',
        content: `🎂 It's ${name}'s birthday today!`,
        embeds: [
          {
            title: '🎉 Birthday in the house',
            description: `Make some noise for ${name}. The pet is wearing a party hat in spirit.`,
            color: VIOLET,
            fields: [],
          },
        ],
        silent: false,
      } as never);
    } catch (err) {
      // One group refusing (kicked bot mid-loop, conversation gone) must not
      // cost the rest their party — and a retry of the job re-covers this one
      // through the nonce.
      app.log.warn({ err, conversationId: row.id }, 'birthday party post failed');
    }
  }
}

// ─── The boomerang ───────────────────────────────────────────────────────────

/**
 * From the third time on, yapper has something to say about it.
 *
 * `count` is the member row's lifetime rejoin count *after* this rejoin; the
 * tiers below escalate with it. Ordinals are only needed past four, where
 * the lines stop pretending to be surprised.
 */
const BOOMERANG_LINES: Array<(name: string, count: number) => string> = [
  // 3
  (n) => `${n} left for attention and came back for validation. that's three.`,
  (n) => `oh, ${n}'s back. third time. the door is not a toy.`,
  (n) => `${n} has now left and rejoined three times. i'm starting to take it personally.`,
];
const BOOMERANG_LINES_FOUR: Array<(name: string, count: number) => string> = [
  (n) => `${n}. four times. at this point you're not leaving, you're commuting.`,
  (n) => `welcome back ${n}. fourth time. we kept your seat warm, unwillingly.`,
  (n) => `${n} left again and came back again. four. the pet has stopped looking up.`,
];
const BOOMERANG_LINES_MORE: Array<(name: string, count: number) => string> = [
  (n, c) => `${n} is back for the ${ordinal(c)} time. i've stopped updating the banner.`,
  (n, c) => `${ordinal(c)} rejoin for ${n}. the group has a revolving door now and it's named after you.`,
  (n, c) => `${n}. ${c} times. leaving is not a personality.`,
  (n, c) => `${n} has left and rejoined ${c} times. we should be charging rent by the visit.`,
];

function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

export interface YapperLineJob {
  conversationId: string;
  /** Stable per (trigger, group, subject): the send path dedupes on it, so a
   *  retried or re-detected line lands once. */
  nonce: string;
  content: string;
}

/**
 * One unprompted line from yapper into a group — the gate every easter egg
 * goes through.
 *
 * Three rules, applied here rather than at each trigger so none can forget
 * one: only where yapper has been let in (a bot nobody added does not get to
 * have opinions), only in a living group, and not where an admin has run
 * `/yapper quiet`. Silent: a joke is a line in the chat, not a reason for
 * every phone in the room to buzz. Returns whether it was said.
 */
export async function postYapperLine(app: FastifyInstance, job: YapperLineJob): Promise<boolean> {
  const botId = await getYapperUserId(app);
  if (!botId) return false;

  const [ok] = (await app.db.execute(raw`
    select 1
      from conversations c
      join conversation_members mb
        on mb.conversation_id = c.id and mb.user_id = ${botId}::uuid and mb.left_at is null
     where c.id = ${job.conversationId}::uuid
       and c.type = 'group' and c.deleted_at is null
       and coalesce((c.settings ->> 'yapperQuiet')::boolean, false) = false
  `)) as unknown as Array<unknown>;
  if (!ok) return false;

  await app.messages.send(botId, job.conversationId, {
    nonce: job.nonce,
    type: 'text',
    content: job.content,
    silent: true,
  } as never);
  return true;
}

/** The queue consumer for `yapper.line`: what the worker detected, said. */
export async function deliverYapperLine(app: FastifyInstance, job: YapperLineJob): Promise<void> {
  await postYapperLine(app, job);
}

/**
 * Somebody left the group and walked back in — again.
 *
 * An easter egg, not a feature: nothing announces it, and it only fires from
 * the third rejoin on. Idempotent per (group, person, count) through the
 * nonce so a retried join cannot tell the joke twice.
 *
 * Fire-and-forget by contract — the caller never awaits it, so nothing here
 * may throw out.
 */
export async function announceBoomerang(
  app: FastifyInstance,
  conversationId: string,
  userId: string,
  count: number,
): Promise<void> {
  if (count < 3) return;
  try {
    const [row] = (await app.db.execute(raw`
      select coalesce(u.display_name, u.username) as name
        from users u where u.id = ${userId}::uuid and u.is_bot = false
    `)) as unknown as Array<{ name: string | null }>;
    if (!row) return;
    const name = row.name ?? 'someone';

    const pool = count === 3 ? BOOMERANG_LINES : count === 4 ? BOOMERANG_LINES_FOUR : BOOMERANG_LINES_MORE;
    const line = pool[Math.floor(Math.random() * pool.length)]!(name, count);

    await postYapperLine(app, {
      conversationId,
      nonce: `yapper_boomerang_${conversationId}_${userId}_${count}`,
      content: line,
    });
  } catch (err) {
    app.log.warn({ err, conversationId, userId }, 'boomerang line failed');
  }
}

// ─── The recap ───────────────────────────────────────────────────────────────

export interface YapperRecapJob {
  /** The group whose week it was. */
  conversationId: string;
  /** ISO week label (`2026-W36`) — part of the nonce, so a retried job
   *  re-posts nothing and next week posts fresh. */
  week: string;
}

/**
 * The pet's week, told back to the group that lived it.
 *
 * The pet's whole design is the group's own activity reflected at it, and
 * until now the reflection had no voice — the card on the home screen moved,
 * and that was all. This is the voice: once a week, in groups that had a real
 * week (the worker's `enqueueWeeklyRecaps` decides which), yapper posts a
 * card of what happened — the daily pulse as a chart, who talked most, what
 * got the biggest reaction, and the streak the pet is carrying.
 *
 * Deliberate choices:
 *   • Silent. A weekly digest that buzzes every phone on a Sunday morning
 *     teaches people to mute the group, which is the opposite of the point.
 *     It waits in the chat like a newspaper on the doorstep.
 *   • Only where yapper is a member. The pet does the remembering, but
 *     yapper does the talking, and a bot nobody added does not get to speak.
 *   • Encrypted and deleted messages count in the totals but are never
 *     quoted; the "loudest message" line only ever excerpts plain text.
 */
export async function deliverYapperRecap(app: FastifyInstance, job: YapperRecapJob): Promise<void> {
  const botId = await getYapperUserId(app);
  if (!botId) return;

  // Membership and liveness re-checked at delivery: the bot can be kicked and
  // the group deleted between the cron's decision and this job running.
  const [membership] = (await app.db.execute(raw`
    select 1
      from conversations c
      join conversation_members mb
        on mb.conversation_id = c.id and mb.user_id = ${botId}::uuid and mb.left_at is null
     where c.id = ${job.conversationId}::uuid
       and c.type = 'group' and c.deleted_at is null
  `)) as unknown as Array<unknown>;
  if (!membership) return;

  /**
   * The seven complete UTC days ending at the most recent midnight.
   *
   * Anchored, never rolling: `now() - interval '7 days'` at a Sunday-morning
   * drain spans eight calendar days, splits Sunday into two partial buckets
   * (the chart drew two 'Sun' bars, both undercounted), and drifts as the
   * queue drains — later groups' cards described a different window than
   * earlier ones. Whole days mean every card for the week says the same
   * thing regardless of when its job ran.
   */
  const windowEnd = new Date();
  windowEnd.setUTCHours(0, 0, 0, 0);
  const windowStart = new Date(windowEnd.getTime() - 7 * 86_400_000);

  const [dailyRows, topRows, loudRows, [mediaRow], [pet]] = await Promise.all([
    // The pulse: messages per day, oldest first, humans only.
    app.db.execute(raw`
      select to_char(date_trunc('day', m.created_at at time zone 'UTC'), 'YYYY-MM-DD') as bucket,
             count(*)::int as msgs
        from messages m
        join users u on u.id = m.sender_id and u.is_bot = false
       where m.conversation_id = ${job.conversationId}::uuid
         and m.created_at >= ${windowStart.toISOString()}::timestamptz
         and m.created_at < ${windowEnd.toISOString()}::timestamptz
         and m.deleted_at is null
       group by 1
       order by 1
    `) as unknown as Promise<Array<{ bucket: string; msgs: number }>>,
    app.db.execute(raw`
      select coalesce(u.display_name, u.username, 'someone') as name, count(*)::int as msgs
        from messages m
        join users u on u.id = m.sender_id and u.is_bot = false
       where m.conversation_id = ${job.conversationId}::uuid
         and m.created_at >= ${windowStart.toISOString()}::timestamptz
         and m.created_at < ${windowEnd.toISOString()}::timestamptz
         and m.deleted_at is null
       group by u.id, 1
       order by msgs desc
       limit 3
    `) as unknown as Promise<Array<{ name: string; msgs: number }>>,
    /*
     * The loudest message: most reactions this week, two at minimum — one
     * reaction is a nicety, two is an event.
     *
     * The excerpt is quoted into a card every member can read forever, so
     * everything with a reader- or time-scoped visibility is ruled out, not
     * merely unlikely: encrypted bodies, non-text, bot cards, disappearing
     * messages (the quote would outlive the sweep), spoiler-marked text (the
     * tap-to-reveal veil does not survive excerpting), anything a member has
     * deleted for themselves, and anything below the newest member's history
     * floor — a card is one message for the whole room, so it only quotes
     * what the whole room is entitled to read.
     */
    app.db.execute(raw`
      select left(m.content, 90) as excerpt,
             coalesce(u.display_name, u.username, 'someone') as name,
             count(*)::int as reactions
        from message_reactions r
        join messages m on m.id = r.message_id
        join users u on u.id = m.sender_id
       where m.conversation_id = ${job.conversationId}::uuid
         and m.created_at >= ${windowStart.toISOString()}::timestamptz
         and m.created_at < ${windowEnd.toISOString()}::timestamptz
         and m.deleted_at is null
         and m.is_encrypted = false
         and m.type = 'text'
         and m.content is not null
         and u.is_bot = false
         and m.expires_at is null
         and not coalesce(m.entities @> '[{"type":"spoiler"}]'::jsonb, false)
         and not exists (select 1 from message_deletions md where md.message_id = m.id)
         and m.seq >= (
               select coalesce(max(mm.history_start_seq), 0)
                 from conversation_members mm
                where mm.conversation_id = m.conversation_id
                  and mm.left_at is null
             )
       group by m.id, m.content, u.display_name, u.username
      having count(*) >= 2
       order by reactions desc, m.id
       limit 1
    `) as unknown as Promise<Array<{ excerpt: string; name: string; reactions: number }>>,
    app.db.execute(raw`
      select count(*)::int as media
        from message_attachments a
        join messages m on m.id = a.message_id
       where m.conversation_id = ${job.conversationId}::uuid
         and m.created_at >= ${windowStart.toISOString()}::timestamptz
         and m.created_at < ${windowEnd.toISOString()}::timestamptz
         and m.deleted_at is null
    `) as unknown as Promise<Array<{ media: number }>>,
    app.db.execute(raw`
      select name, streak, fed_days
        from group_pets
       where conversation_id = ${job.conversationId}::uuid
    `) as unknown as Promise<Array<{ name: string | null; streak: number; fed_days: number }>>,
  ]);

  // The cron checked Sunday-morning's truth; check this moment's. Two rows in
  // the top list is two distinct humans, which is the exact threshold.
  const totalMsgs = dailyRows.reduce((n, d) => n + d.msgs, 0);
  if (totalMsgs < 10 || topRows.length < 2) return;

  const petName = pet?.name ?? 'the pet';
  const medals = ['🥇', '🥈', '🥉'];
  const fields: Array<{ name: string; value: string; inline?: boolean }> = [
    {
      name: 'Top yappers',
      value: topRows.map((t, i) => `${medals[i]} ${t.name} — ${t.msgs}`).join('\n'),
    },
  ];
  const loud = loudRows[0];
  if (loud) {
    fields.push({
      name: 'Loudest message',
      value: `“${loud.excerpt.trim()}” — ${loud.name}, ${loud.reactions} reactions`,
    });
  }
  const mediaCount = mediaRow?.media ?? 0;
  if (mediaCount > 0) {
    fields.push({
      name: 'Media',
      value: mediaCount === 1 ? '1 photo or file shared' : `${mediaCount} photos & files shared`,
      inline: true,
    });
  }
  const streak = pet?.streak ?? 0;
  if (streak > 0) {
    fields.push({
      name: 'Streak',
      value: streak === 1 ? '1 fed day. it is a start.' : `${streak} fed days and counting`,
      inline: true,
    });
  }

  const description =
    `${totalMsgs} messages this week. ` +
    ((pet?.streak ?? 0) >= 7
      ? `I have eaten every day for ${pet!.streak} days straight — keep it coming.`
      : (pet?.streak ?? 0) > 0
        ? 'I ate well. Mostly.'
        : 'I would not say I ate *well*, but I am still here.') +
    (pet?.name ? '' : ' (Still no name, by the way. Just saying.)');

  // Zero-filled: a group's quiet Tuesday is part of the week's shape, and a
  // chart that omits it draws a six-day week that never happened.
  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const byBucket = new Map(dailyRows.map((r) => [r.bucket, r.msgs]));
  const points = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(windowStart.getTime() + i * 86_400_000);
    return {
      label: DAY_NAMES[d.getUTCDay()]!,
      value: byBucket.get(d.toISOString().slice(0, 10)) ?? 0,
    };
  });

  // A retried job re-sends the same nonce and `send` hands back the existing
  // message — the idempotency is the send path's, not this function's.
  await app.messages.send(botId, job.conversationId, {
    nonce: `yapper_recap_${job.conversationId}_${job.week}`,
    type: 'text',
    content: `🐾 ${petName}'s weekly report`,
    embeds: [
      {
        title: `📊 The week according to ${petName}`,
        description,
        color: VIOLET,
        fields,
        chart: { kind: 'bar', points },
      },
    ],
    silent: true,
  } as never);
}

/** Post to the staff space. A no-op when the channel has not been created yet. */
export async function deliverYapperStaff(app: FastifyInstance, job: YapperStaffJob): Promise<void> {
  const botId = await getYapperUserId(app);
  const channelId = await getSystemConversationId(app, STAFF_CHANNEL[job.kind] ?? 'staff_reports');
  if (!botId || !channelId) return;

  const card = renderStaff(job);
  if (!card) {
    app.log.warn({ kind: job.kind }, 'unknown yapper staff kind');
    return;
  }

  await app.messages.send(botId, channelId, {
    nonce: `yapper_${job.kind}_${job.dedupe}`,
    type: 'text',
    content: card.content,
    embeds: card.embeds,
    components: card.components,
    silent: card.silent ?? false,
  } as never);
}

// ─── Cards ───────────────────────────────────────────────────────────────────

interface Card {
  content: string | null;
  embeds?: EmbedInput[];
  components?: MessageComponentRow[];
  /**
   * Land in the channel without pushing anyone's phone.
   *
   * Defaults to off, because every other notice here is something a person is
   * owed promptly. The exception is a channel fed by a machine at machine
   * pace — see the gitlog case, where a push per commit is how a channel gets
   * muted, and a muted channel swallows the one card that mattered.
   */
  silent?: boolean;
}

/**
 * The off switch, carried by every optional notice.
 *
 * On the message rather than buried in settings, because the moment someone
 * decides they do not want these is the moment they are reading one. A
 * preference that takes four taps to find is a preference people express by
 * blocking the sender instead.
 */
const muteRow = (userId: string): MessageComponentRow => ({
  type: 'row',
  components: [
    {
      type: 'button',
      customId: 'notify:off',
      label: 'Stop messages like this',
      style: 'secondary',
      disabled: false,
      onlyUserId: userId,
    },
  ],
});

const str = (v: unknown, fallback = 'unknown'): string => {
  const s = v === null || v === undefined ? '' : String(v);
  return s.trim() === '' ? fallback : s.slice(0, 1_024);
};

function renderDm(job: YapperDmJob): Card | null {
  const p = job.payload ?? {};

  switch (job.kind) {
    /**
     * A staff announcement.
     *
     * An embed rather than a new message type, and the reason is reach: a new
     * entry in `MESSAGE_TYPES` renders as an unknown blank on every app already
     * installed, and the one message that most needs to arrive intact is the
     * one going to everybody at once. Embeds have rendered on both clients
     * since the first release.
     *
     * Carries the mute row like every other optional notice — someone who does
     * not want product news should be able to say so from the news itself.
     */
    case 'announcement': {
      const footer = str(p.footer, '');
      return {
        content: null,
        embeds: [
          {
            // Survives the server's own strip because yapper is a badged bot;
            // any other sender loses it. New clients give this its own card
            // and no line cap, old ones ignore the field and render the
            // ordinary embed they always did.
            kind: 'announcement',
            author: { name: 'Announcement' },
            title: str(p.title, 'An update from yappy'),
            description: str(p.body, ''),
            color: VIOLET,
            fields: [],
            timestamp: new Date().toISOString(),
            ...(footer ? { footer: { text: footer } } : {}),
          },
        ],
        components: [muteRow(job.userId)],
      };
    }
    case 'birthday': {
      const name = str(p.name, '');
      return {
        content: null,
        embeds: [
          {
            title: '🎂 Happy birthday!',
            description: name
              ? `Happy birthday, ${name}! Hope it's a good one. From all of us at yappy, which is mostly me, the bot. 🎈`
              : `Happy birthday! Hope it's a good one. From all of us at yappy, which is mostly me, the bot. 🎈`,
            color: VIOLET,
            fields: [],
          },
        ],
        components: [muteRow(job.userId)],
      };
    }

    case 'badge_changed': {
      const badge = str(p.badge, 'badge');
      const granted = p.granted === true;
      return {
        content: null,
        embeds: [
          {
            title: granted ? 'You have a new badge' : 'A badge was removed',
            // Plain text: an embed description is not rendered as markdown on
            // either client, so asterisks would arrive as asterisks.
            description: granted
              ? `Your account now carries the ${badge} badge. It shows next to your name.`
              : `The ${badge} badge is no longer on your account.`,
            color: granted ? GREEN : AMBER,
            fields: [],
          },
        ],
        components: [muteRow(job.userId)],
      };
    }

    /**
     * The first thing anybody reads on yappy.
     *
     * It used to introduce the bot — portal sign-in, reports, account notices —
     * which is accurate and is about yapper rather than about them. Somebody
     * who has just arrived has no groups and knows nobody here, and the home
     * screen's one suggestion ("start a conversation") is the single thing they
     * cannot do. So this offers the thing they can: a group, and a link to send
     * to the people they actually want to talk to.
     *
     * `/help` still exists for anyone who wants the rest of it.
     */
    case 'welcome_v2':
      return {
        content: null,
        embeds: [
          {
            title: 'Welcome to yappy',
            description:
              'yappy is for group chats — the kind that feel like a place you drop into rather than a thread you catch up on.\n\nYou are the only one here so far. Shall I make you a group to invite people to?',
            color: VIOLET,
            fields: [],
            footer: { text: 'I am a bot. /help is everything else I answer to.' },
          },
        ],
        components: [
          {
            type: 'row',
            components: [
              {
                type: 'button',
                customId: 'welcome:group',
                label: 'Make me a group',
                style: 'primary',
                disabled: false,
              },
              {
                type: 'button',
                customId: 'welcome:invited',
                label: 'I was invited to one',
                style: 'secondary',
                disabled: false,
              },
            ],
          },
        ],
      };

    case 'welcome':
      return {
        content: null,
        embeds: [
          {
            title: 'Welcome to yappy',
            description:
              'I am the first-party bot. I sign you in to the developer portal, I take reports, and I tell you when something happens to your account.',
            color: VIOLET,
            fields: [
              { name: 'Try', value: '/help — everything I answer to', inline: false },
              { name: 'Privacy', value: '/privacy — who can reach you', inline: false },
              { name: 'Building a bot?', value: '/login — sign in to the portal', inline: false },
            ],
            footer: { text: 'I only act in this conversation. I am not in your groups.' },
          },
        ],
        components: [muteRow(job.userId)],
      };

    case 'new_device':
      return {
        content: null,
        embeds: [
          {
            title: 'New sign-in to your account',
            description:
              'Your password was used to sign in from a device or location I have not seen recently. If that was you, there is nothing to do.',
            color: AMBER,
            fields: [
              { name: 'Device', value: str(p.device, str(p.platform)), inline: true },
              { name: 'Address', value: str(p.ip), inline: true },
              { name: 'When', value: str(p.at), inline: true },
            ],
            // No "this wasn't me" button on purpose: a one-tap remedy for a
            // stolen password is a one-tap remedy an attacker with the session
            // can also press. Changing the password is the action that ends
            // every other session, and it belongs behind the password prompt.
            footer: { text: 'Not you? Change your password — that signs every other device out.' },
          },
        ],
      };

    case 'suspended':
      return {
        content: null,
        embeds: [
          {
            title: 'Your account has been suspended',
            description: str(p.reason, 'No reason was recorded.'),
            color: RED,
            fields: [
              { name: 'Until', value: str(p.until), inline: true },
              { name: 'Length', value: `${str(p.days, '?')} days`, inline: true },
            ],
            footer: { text: 'Reply here if you believe this was a mistake. A person reads it.' },
          },
        ],
      };

    case 'report_closed':
      return {
        content: null,
        embeds: [
          {
            title: 'Your report has been reviewed',
            // Deliberately silent on the outcome. Telling a reporter what
            // happened to the account they reported tells a harasser whether
            // their target reported them, which is the same reasoning the REST
            // endpoint's response follows.
            description: 'A moderator has looked at it and closed it. Thank you for sending it.',
            color: GREEN,
            fields: [{ name: 'Reference', value: str(p.reportId).slice(0, 8), inline: true }],
            footer: { text: 'We do not share what action was taken, or who took it.' },
          },
        ],
      };

    case 'bug_update': {
      const status = str(p.status);
      return {
        content: null,
        embeds: [
          {
            title: `${str(p.reference)} — ${status === 'fixed' ? 'fixed' : 'updated'}`,
            description: str(p.message),
            color: status === 'fixed' ? GREEN : status === 'invalid' ? GREY : VIOLET,
            fields: [{ name: 'Reference', value: str(p.reference), inline: true }],
            footer: { text: 'Reply here if there is more to it. /bug files another.' },
          },
        ],
      };
    }

    case 'early_claim':
      return {
        content: null,
        embeds: [
          {
            title: `You have earned $${str(p.amountUsd)} ${str(p.currency)}`,
            description:
              'For using yappy while it was still rough. A slot is held for you — nobody else can take it, so there is no race to win.',
            color: GREEN,
            fields: [
              { name: 'Claim it at', value: str(p.url), inline: false },
              { name: 'Held until', value: str(p.expiresAt), inline: false },
            ],
            footer: {
              text: 'You will be asked for a Solana address, then to confirm it back here. Check it character by character — a wrong one cannot be undone.',
            },
          },
        ],
      };

    case 'claim_confirm':
      return {
        content: null,
        embeds: [
          {
            title: 'Is this the right address?',
            description:
              `We will send $${str(p.amountUsd)} USDC here. Read it once more before you say yes — ` +
              'a Solana address has no checksum, so one wrong character is a real address belonging ' +
              'to somebody else, and there is no way to get it back.',
            color: AMBER,
            // Whole, never shortened. A truncated address confirms nothing:
            // the middle is exactly where a typo hides.
            fields: [{ name: 'Sending to', value: str(p.walletAddress), inline: false }],
            footer: { text: 'Wrong? Put it in again at /claim/early — the last one you confirm wins.' },
          },
        ],
        components: [
          {
            type: 'row',
            components: [
              {
                type: 'button',
                customId: 'claim:confirm',
                label: 'Yes, that is mine',
                style: 'success',
                disabled: false,
              },
              {
                type: 'button',
                customId: 'claim:reject',
                label: 'No, let me fix it',
                style: 'secondary',
                disabled: false,
              },
            ],
          },
        ],
      };

    case 'claim_paid':
      return {
        content: null,
        embeds: [
          {
            title: `$${str(p.amountUsd)} sent`,
            description:
              'Thank you for testing yappy while it was still rough. The bug reports were worth more than the money.',
            color: GREEN,
            fields: p.txSignature
              ? [{ name: 'Transaction', value: str(p.txSignature), inline: false }]
              : [],
          },
        ],
      };

    case 'webhook_failing':
      return {
        content: null,
        embeds: [
          {
            title: 'A bot webhook has stopped answering',
            description:
              'Deliveries to this application have failed repeatedly. Events are being dropped once their retries are spent.',
            color: AMBER,
            fields: [
              { name: 'Bot', value: str(p.name), inline: true },
              { name: 'Failures in a row', value: str(p.failures, '?'), inline: true },
              { name: 'Last success', value: str(p.lastSuccessAt, 'not since I started counting'), inline: false },
            ],
            footer: { text: 'Check the endpoint is up and returning 2xx within five seconds.' },
          },
        ],
        components: [muteRow(job.userId)],
      };

    case 'webhook_test_result': {
      const ok = p.ok === true;
      return {
        content: null,
        embeds: [
          {
            title: ok ? 'Your webhook answered' : 'Your webhook did not answer',
            description: ok
              ? 'I sent a signed test delivery and your endpoint accepted it.'
              : 'I sent a signed test delivery and it did not come back 2xx.',
            color: ok ? GREEN : RED,
            fields: [
              { name: 'Bot', value: str(p.name), inline: true },
              { name: 'Result', value: str(p.detail), inline: true },
            ],
            footer: {
              text: ok
                ? 'Verify X-Yappy-Signature on every delivery before trusting the body.'
                : 'Deliveries time out at five seconds. Acknowledge first, work after.',
            },
          },
        ],
      };
    }

    case 'token_ageing':
      return {
        content: null,
        embeds: [
          {
            title: 'A bot token is getting old',
            description:
              'This token has not been rotated in a long time. Rotating is immediate and has no grace window, so do it when you can redeploy.',
            color: VIOLET,
            fields: [
              { name: 'Bot', value: str(p.name), inline: true },
              { name: 'Age', value: `${str(p.ageDays, '?')} days`, inline: true },
            ],
            footer: { text: 'Rotate from the portal, or POST /v1/apps/:id/token.' },
          },
        ],
        components: [muteRow(job.userId)],
      };

    default:
      return null;
  }
}

function renderStaff(job: YapperStaffJob): Card | null {
  const p = job.payload ?? {};

  switch (job.kind) {
    case 'digest': {
      const open = Number(p.open ?? 0);
      return {
        content: null,
        embeds: [
          {
            title: open === 0 ? 'Queue is clear' : `${open} open report${open === 1 ? '' : 's'}`,
            description: open === 0 ? 'Nothing waiting this morning.' : null,
            color: open === 0 ? GREEN : Number(p.priority ?? 0) > 0 ? RED : AMBER,
            fields: [
              { name: 'Priority', value: str(p.priority, '0'), inline: true },
              { name: 'Oldest', value: `${str(p.oldestHours, '0')}h`, inline: true },
              { name: 'Closed yesterday', value: str(p.closed, '0'), inline: true },
            ],
            footer: { text: 'Act from the cards in this channel, or the portal.' },
          },
        ],
      };
    }

    case 'backlog':
      return {
        content: null,
        embeds: [
          {
            title: 'Reports are ageing',
            description: 'These have been open longer than a day.',
            color: AMBER,
            fields: [
              { name: 'Over 24h', value: str(p.overdue, '0'), inline: true },
              { name: 'Oldest', value: `${str(p.oldestHours, '0')}h`, inline: true },
            ],
          },
        ],
      };

    case 'spike':
      return {
        content: null,
        embeds: [
          {
            title: 'Several reports about one account',
            description:
              'Independent reports about the same person in a short window. Worth looking at together rather than one at a time.',
            color: AMBER,
            fields: [
              { name: 'About', value: str(p.targetLabel), inline: true },
              { name: 'Reports', value: str(p.count, '?'), inline: true },
              { name: 'Window', value: '24h', inline: true },
            ],
            footer: { text: 'Use /lookup to see the account as staff.' },
          },
        ],
      };

    /**
     * Already a card by the time it gets here.
     *
     * Every other kind is rendered from a few scalars because the worker that
     * enqueues it only has scalars. This one is enqueued by the webhook route,
     * which holds the whole GitHub payload — and that payload is the one thing
     * that must not go on the queue, since it carries branch names, commit
     * messages and diffs that have no business sitting in `pgboss.job` for an
     * hour. `lib/gitlog.ts` reduces it to a card at the door, and this is the
     * pass-through.
     */
    case 'gitlog': {
      const embeds = Array.isArray(p.embeds) ? (p.embeds as EmbedInput[]) : [];
      if (embeds.length === 0) return null;
      const content = typeof p.content === 'string' ? p.content : null;
      /**
       * Content is the signal for "this one is worth an interruption".
       * `lib/gitlog.ts` writes a line of it for exactly two cards — a failed CI
       * run and a published release — and leaves it null for the steady stream
       * of commits, pull requests and issues. So the presence of content is
       * also the answer to whether this should reach a phone.
       */
      return { content, embeds, silent: content === null };
    }

    case 'priority_report':
      return {
        // Content, not just an embed: this is the one notification that should
        // survive being glanced at in a notification shade.
        content: 'A high-priority report just landed.',
        embeds: [
          {
            title: `Priority · ${REPORT_REASON_LABEL[p.reason as ReportReason] ?? str(p.reason)}`,
            description: 'Filed moments ago and pushed to the top of the queue. Its card is above.',
            color: RED,
            fields: [{ name: 'Reference', value: str(p.reportId).slice(0, 8), inline: true }],
          },
        ],
      };

    default:
      return null;
  }
}
