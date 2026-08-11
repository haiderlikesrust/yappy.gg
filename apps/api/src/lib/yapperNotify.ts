import {
  and,
  blocks,
  conversationMembers,
  conversations,
  eq,
  isNull,
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
  | 'welcome'
  | 'new_device'
  | 'suspended'
  | 'report_closed'
  | 'webhook_failing'
  | 'webhook_test_result'
  | 'token_ageing'
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
  | 'bug_update';

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
