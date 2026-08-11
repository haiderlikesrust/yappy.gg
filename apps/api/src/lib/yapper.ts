import {
  and,
  applications,
  auditLog,
  botPrompts,
  conversationMembers,
  conversations,
  desc,
  eq,
  inArray,
  isNull,
  or,
  media,
  messages,
  sql as raw,
  reports,
  stickerPacks,
  stickers,
  userStickerPacks,
  users,
  type PrivacySettings,
} from '@yappy/db';
import { applyReportAction, getSystemConversationId, postReportCard, userLabel } from './staffspace.js';
import { Storage } from './storage.js';
import {
  AppError,
  BADGE_KINDS,
  LIMITS,
  PRIVACY_AUDIENCES,
  REPORT_REASONS,
  REPORT_REASON_LABEL,
  newId,
  primaryBadge,
  reportPriority,
  type EmbedInput,
  type InteractionResponse,
  type MessageButton,
  type MessageComponentRow,
  type ReportReason,
} from '@yappy/shared';
import type { FastifyInstance } from 'fastify';
import { disableAll } from './interactions.js';
import { changeUsername, checkUsername, publishProfileUpdate, setBio, setDisplayName } from './profile.js';
import { docsCard, errorCard, permsCard, requestWebhookTest, webhookCard } from './yapperDev.js';
import { claimGrant, confirmGrant, noteBadAttempt } from '../routes/portal.js';

/**
 * yapper — the first-party bot.
 *
 * Third-party bots receive events by holding a connection or a webhook, and
 * building that out is a real piece of work. yapper does not need it: it runs
 * inside this process, so a message addressed to it is dispatched directly
 * after the send transaction commits. Being first-party is the whole reason
 * that shortcut is legitimate, and it is deliberately not exposed as a
 * mechanism anyone else can use.
 *
 * It exists mainly to be the confirmation surface for developer-portal
 * sign-ins. See `device_grants` for why approval happens here rather than in
 * the browser.
 *
 * The conversation is a small state machine, not a command language. `/login`
 * asks for the code, the next message *is* the code, and the decision is a
 * button. Asking someone to compose `/login yes` was asking them to retype
 * something they had to read carefully, which is how you get a stale reply
 * approving a prompt the person has forgotten the details of.
 */

export const YAPPER_USERNAME = 'yapper';

/** How long yapper waits for an answer before a message is just a message. */
const PROMPT_TTL_SECONDS = 5 * 60;

/**
 * The report flow gets longer.
 *
 * It asks for a category, an account of what happened and a link to proof —
 * and the person answering has usually just been on the receiving end of
 * something. Five minutes is the right budget for "paste the code the portal
 * is showing you" and the wrong one for "describe what they did", where the
 * penalty for thinking about the wording is starting over.
 */
const REPORT_PROMPT_TTL_SECONDS = 30 * 60;

const VIOLET = '#8b7cff';
const AMBER = '#f5a524';
const GREEN = '#3dd68c';
const RED = '#ff6369';

/**
 * Declared so the composer can offer autocomplete. Kept beside the handler
 * that implements them, and written to the bot's `applications` row on boot,
 * so the two cannot drift.
 */
export const YAPPER_COMMANDS = [
  { name: 'help', description: 'What I can do', usage: '/help' },
  { name: 'login', description: 'Sign in to the developer portal', usage: '/login' },
  { name: 'whoami', description: 'Your account, as the server sees it', usage: '/whoami' },
  // Profile editing. Not a convenience: neither app can reach PATCH /users/me,
  // so until they can, this is the only way to change any of the three.
  { name: 'username', description: 'Check a username, and take it if it is free', usage: '/username paid' },
  { name: 'name', description: 'Change your display name', usage: '/name Haider' },
  { name: 'bio', description: 'Change your bio', usage: '/bio Building yappy' },
  { name: 'privacy', description: 'See and change who can reach you', usage: '/privacy' },
  { name: 'stickerpack', description: 'Make a sticker pack, or add to one', usage: '/stickerpack' },
  { name: 'apps', description: 'The bots you have built', usage: '/apps' },
  { name: 'status', description: 'Whether yappy is healthy right now', usage: '/status' },
  { name: 'report', description: 'Report someone to a moderator', usage: '/report' },
  { name: 'about', description: 'What yappy is', usage: '/about' },
  // Developer support. Every answer comes from docs/ or from the same
  // constants the server authorises with, so none of it can drift.
  { name: 'docs', description: 'Search the developer documentation', usage: '/docs webhooks' },
  { name: 'error', description: 'What an API error code means', usage: '/error rate_limited' },
  { name: 'perms', description: 'Decode or build a permission bitfield', usage: '/perms 4398046511111' },
  { name: 'webhook', description: 'Check and test your bot webhooks', usage: '/webhook' },
  // Staff only — filtered out of everyone else's autocomplete by the
  // commands endpoint, and refused at execution regardless.
  { name: 'reports', description: 'The open moderation queue', usage: '/reports', staffOnly: true },
  { name: 'lookup', description: 'A user, as staff see them', usage: '/lookup @someone', staffOnly: true },
  { name: 'announce', description: 'Send an announcement to everyone', usage: '/announce', staffOnly: true },
  {
    name: 'badge',
    description: 'Grant or take back a badge',
    usage: '/badge @someone verified',
    staffOnly: true,
  },
  { name: 'stats', description: 'The platform, right now', usage: '/stats', staffOnly: true },
  { name: 'queue', description: 'Background work: pending, failed, stuck', usage: '/queue', staffOnly: true },
  { name: 'group', description: 'A conversation, as staff see it', usage: '/group @handle', staffOnly: true },
  { name: 'unsuspend', description: 'Lift a suspension', usage: '/unsuspend @someone', staffOnly: true },
  { name: 'audit', description: 'What has been done to an account, and by whom', usage: '/audit @someone', staffOnly: true },
  { name: 'bot', description: 'A bot, as staff see it', usage: '/bot scanner', staffOnly: true },
  { name: 'find', description: 'Resolve an id, email, phone or handle', usage: '/find 019fee…', staffOnly: true },
  { name: 'ping', description: 'Check I am awake', usage: '/ping' },
  { name: 'cancel', description: 'Abandon what I last asked you', usage: '/cancel' },
];

/**
 * Publish `YAPPER_COMMANDS` onto the bot's application row.
 *
 * Written on boot rather than in the seeding script so the list cannot drift
 * from the handler: editing the switch above and forgetting the database is
 * the mistake this prevents. A no-op when yapper has not been created yet.
 */
export async function syncYapperCommands(app: FastifyInstance): Promise<void> {
  const botId = await getYapperUserId(app);
  if (!botId) return;
  await app.db
    .update(applications)
    .set({ commands: YAPPER_COMMANDS })
    .where(eq(applications.botUserId, botId));
}

export interface YapperReply {
  content: string | null;
  embeds?: EmbedInput[];
  components?: MessageComponentRow[];
}

/** "3d 4h", "12m". Coarse on purpose — nobody reads uptime to the second. */
function formatDuration(seconds: number): string {
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3_600);
  const m = Math.floor((seconds % 3_600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Cached after the first lookup: one row that never changes during a run. */
let cachedBotId: string | null = null;

export async function getYapperUserId(app: FastifyInstance): Promise<string | null> {
  if (cachedBotId) return cachedBotId;
  const [row] = await app.db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.username, YAPPER_USERNAME), eq(users.isBot, true), isNull(users.deletedAt)))
    .limit(1);
  cachedBotId = row?.id ?? null;
  return cachedBotId;
}

/**
 * Is this conversation a DM between the sender and yapper?
 *
 * Checked rather than assumed: a command typed where others can see it should
 * be ignored rather than acted on in front of an audience.
 *
 * Cached because this is now consulted on *every* message send, not only ones
 * beginning with a slash — the guided flow needs to recognise a bare code as
 * an answer. The answer is stable: a conversation's type never changes, and a
 * DM's two members are fixed at creation, so there is nothing to invalidate.
 * Bounded anyway, so a long-lived process cannot accumulate one entry per
 * conversation the instance has ever seen.
 */
const dmCache = new Map<string, boolean>();
const DM_CACHE_MAX = 5_000;

async function isYapperDm(app: FastifyInstance, conversationId: string, botId: string): Promise<boolean> {
  const cached = dmCache.get(conversationId);
  if (cached !== undefined) return cached;

  const [conversation] = await app.db
    .select({ type: conversations.type })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);

  let answer = false;
  if (conversation?.type === 'dm') {
    const [member] = await app.db
      .select({ userId: conversationMembers.userId })
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, botId),
          isNull(conversationMembers.leftAt),
        ),
      )
      .limit(1);
    answer = Boolean(member);
  }

  // Plain FIFO eviction. An LRU would be better if this were hot, but the
  // miss it protects against costs two indexed reads.
  if (dmCache.size >= DM_CACHE_MAX) {
    const oldest = dmCache.keys().next();
    if (!oldest.done) dmCache.delete(oldest.value);
  }
  dmCache.set(conversationId, answer);
  return answer;
}

// ─── The pending question ────────────────────────────────────────────────────

async function setPrompt(
  app: FastifyInstance,
  input: {
    botId: string;
    userId: string;
    conversationId: string;
    state: string;
    /** Carried between steps of a multi-step flow. */
    data?: Record<string, unknown>;
    /**
     * Keep an existing deadline instead of starting a new one.
     *
     * Re-arming the same question — a mistyped code, say — must not push the
     * expiry forward, or the TTL that is supposed to bound the question can
     * never be reached while the person is still talking.
     */
    expiresAt?: Date;
  },
): Promise<void> {
  // Keyed off the flow rather than passed in at every call site: the right TTL
  // is a property of what is being asked, and threading it through eight
  // callers is how one of them ends up with the wrong one.
  // Reports and sticker-building both take real time — a short code-entry TTL
  // would expire mid-flow.
  const ttl =
    input.state.startsWith('report:') || input.state.startsWith('sticker:')
      ? REPORT_PROMPT_TTL_SECONDS
      : PROMPT_TTL_SECONDS;
  const expiresAt = input.expiresAt ?? new Date(Date.now() + ttl * 1000);
  const data = input.data ?? {};
  await app.db
    .insert(botPrompts)
    .values({
      botUserId: input.botId,
      userId: input.userId,
      conversationId: input.conversationId,
      state: input.state,
      data,
      expiresAt,
    })
    .onConflictDoUpdate({
      target: [botPrompts.botUserId, botPrompts.userId],
      set: { conversationId: input.conversationId, state: input.state, data, expiresAt },
    });
}

async function clearPrompt(app: FastifyInstance, botId: string, userId: string): Promise<void> {
  await app.db
    .delete(botPrompts)
    .where(and(eq(botPrompts.botUserId, botId), eq(botPrompts.userId, userId)));
}

/** The live question, if there is one. Expired rows are swept as they surface. */
async function getPrompt(
  app: FastifyInstance,
  botId: string,
  userId: string,
  conversationId: string,
): Promise<{ state: string; data: Record<string, unknown>; expiresAt: Date } | null> {
  const [row] = await app.db
    .select()
    .from(botPrompts)
    .where(and(eq(botPrompts.botUserId, botId), eq(botPrompts.userId, userId)))
    .limit(1);

  if (!row) return null;
  if (row.expiresAt < new Date() || row.conversationId !== conversationId) {
    await clearPrompt(app, botId, userId);
    return null;
  }
  return { state: row.state, data: row.data ?? {}, expiresAt: row.expiresAt };
}

/**
 * What a device code looks like: two groups of four from a confusable-free
 * alphabet, as minted by `newUserCode`. The separating dash is optional because
 * people retype these by hand.
 *
 * Used to decide whether a message is an answer to "send me the code" at all.
 * Without it, every ordinary sentence typed after a bare `/login` was hashed as
 * a code, failed, and came back as "that code is not valid" — for as long as
 * the person kept talking.
 */
const CODE_SHAPE = /^[A-HJ-NP-Z2-9]{4}-?[A-HJ-NP-Z2-9]{4}$/i;

// ─── Cards ───────────────────────────────────────────────────────────────────

/** How many commands fit on one help page before it needs scrolling past. */
const HELP_PAGE_SIZE = 6;

/**
 * Paged help.
 *
 * The command list outgrew a single card — a wall of twenty entries is not help,
 * it is a directory. This shows six at a time, in the order they are declared
 * (which is roughly most-used first), with a footer that says where you are and
 * how to see the rest: `/help 2`.
 */
const helpCard = (page = 1): YapperReply => {
  // Staff commands stay out of the public help. Staff know where to look, and a
  // list of hidden commands is an invitation to probe them.
  const visible = YAPPER_COMMANDS.filter((c) => !c.staffOnly);
  const pages = Math.max(1, Math.ceil(visible.length / HELP_PAGE_SIZE));
  const current = Math.min(Math.max(page, 1), pages);
  const start = (current - 1) * HELP_PAGE_SIZE;
  const slice = visible.slice(start, start + HELP_PAGE_SIZE);

  const footer =
    current < pages
      ? `Page ${current}/${pages} · send /help ${current + 1} for more`
      : pages > 1
        ? `Page ${current}/${pages} · send /help 1 to start over`
        : undefined;

  return {
    content: null,
    embeds: [
      {
        title: current === 1 ? 'yapper' : `yapper · more commands`,
        description:
          current === 1 ? 'I sign you in to the developer portal. Start with /login.' : undefined,
        color: VIOLET,
        fields: slice.map((c) => ({ name: c.usage, value: c.description, inline: false })),
        ...(footer ? { footer: { text: footer } } : {}),
      },
    ],
  };
};

/**
 * The one card that matters.
 *
 * The client and the address sit directly above the buttons, because the whole
 * security value of this second step is that someone who was talked into
 * pasting a code sees a browser and a location that are not theirs at the
 * moment they are asked to commit.
 */
const confirmCard = (input: { description: string; ip: string | null; userId: string }): YapperReply => ({
  content: 'Someone is trying to sign in to the developer portal.',
  embeds: [
    {
      title: 'Approve this sign-in?',
      description: 'Only approve this if it is you, right now, in this browser.',
      color: AMBER,
      fields: [
        { name: 'Client', value: input.description, inline: true },
        { name: 'Address', value: input.ip ?? 'unknown', inline: true },
      ],
      footer: { text: 'The portal manages applications only. It cannot read your messages.' },
    },
  ],
  components: [
    {
      type: 'row',
      components: [
        {
          type: 'button',
          customId: 'login:approve',
          label: 'Approve',
          style: 'success',
          disabled: false,
          onlyUserId: input.userId,
        },
        {
          type: 'button',
          customId: 'login:deny',
          label: 'Not me',
          style: 'danger',
          disabled: false,
          onlyUserId: input.userId,
        },
      ],
    },
  ],
});

/**
 * Human wording for a privacy audience, used in both the card and buttons.
 *
 * `contacts` was "People you follow", which is wrong in the direction that
 * matters: a one-way follow is not a contact, and someone who read that label
 * and followed a person would then find they still could not be added to a
 * group by them. The audience means a *mutual* follow, so the label says
 * Contacts and the card's footer says what a contact is.
 */
const AUDIENCE_LABEL: Record<string, string> = {
  everyone: 'Anyone',
  contacts: 'Contacts',
  nobody: 'Nobody',
};

/**
 * One row of audience buttons for one setting.
 *
 * Three up. Short labels on purpose — the clients render a row as equal cells
 * inside a 300pt cap, so three buttons leave about 68pt of text each, which
 * "Anyone", "Contacts" and "Nobody" fit and "People you follow" would not.
 */
const audienceRow = (
  key: 'dm' | 'groups',
  current: string,
  userId: string,
): MessageComponentRow => ({
  type: 'row',
  components: PRIVACY_AUDIENCES.map((audience) => ({
    type: 'button' as const,
    customId: `privacy:${key}:${audience}`,
    label: AUDIENCE_LABEL[audience] ?? audience,
    style: (current === audience ? 'primary' : 'secondary') as 'primary' | 'secondary',
    // The current setting is shown pressed and inert: pressing it would be a
    // write that changes nothing, and a button that does nothing invites a
    // second press to find out why.
    disabled: current === audience,
    onlyUserId: userId,
  })),
});

const privacyCard = (privacy: Partial<PrivacySettings>, userId: string): YapperReply => {
  const dm = String(privacy.whoCanDm ?? 'everyone');
  const groups = String(privacy.whoCanAddToGroups ?? 'contacts');
  return {
    content: null,
    embeds: [
      {
        title: 'Who can reach you',
        description: 'These apply everywhere, not just here.',
        color: VIOLET,
        fields: [
          { name: 'Direct messages', value: AUDIENCE_LABEL[dm] ?? dm, inline: true },
          {
            name: 'Adding you to groups',
            value: AUDIENCE_LABEL[String(privacy.whoCanAddToGroups ?? 'everyone')] ?? 'Anyone',
            inline: true,
          },
          {
            name: 'Calling you',
            value: AUDIENCE_LABEL[String(privacy.whoCanCall ?? 'everyone')] ?? 'Anyone',
            inline: true,
          },
          {
            name: 'Last seen',
            value: AUDIENCE_LABEL[String(privacy.whoCanSeeLastSeen ?? 'everyone')] ?? 'Anyone',
            inline: true,
          },
        ],
        // The buttons carry short labels so they do not wrap, so the footer is
        // where "which row am I pressing?" gets answered.
        footer: {
          text: 'First row: who can message you. Second: who can add you to groups. A contact is someone you follow who follows you back.',
        },
      },
    ],
    /**
     * Two settings, not one.
     *
     * The DM row was here alone on the reasoning that it is the one people want
     * to change in a hurry. Adding groups is not a change of heart about that —
     * it is that `whoCanAddToGroups` defaults to contacts, is settable nowhere
     * else in the product, and is therefore the setting most likely to be
     * silently stopping someone from doing the thing they are trying to do.
     * The other three audiences stay out; a card with eight toggles is a
     * settings screen pretending to be a message.
     */
    components: [audienceRow('dm', dm, userId), audienceRow('groups', groups, userId)],
  };
};

// ─── Profile ─────────────────────────────────────────────────────────────────

/**
 * The answer to "is @paid free?", with the way to take it attached.
 *
 * Check and claim in one card rather than two steps, because the gap between
 * them is where a name gets lost — and because `PATCH /users/me` has no client
 * UI on either platform, so a card that only reports availability would be
 * telling someone about a door they cannot open.
 *
 * The button carries no username. It says only *which branch runs*; the name
 * comes from the prompt row keyed to the presser, for the same reason the
 * report buttons do. A `customId` is client-supplied text and could name
 * anyone's handle.
 */
const usernameCard = (
  candidate: string,
  result: { available: boolean; reason?: string },
): YapperReply => {
  if (result.available) {
    return {
      content: null,
      embeds: [
        {
          title: `@${candidate} is free`,
          description: 'Take it and it becomes how people find you. Your old one goes back into the pool.',
          color: GREEN,
          fields: [],
          footer: { text: 'Changing again is limited — twice now, then about once a day.' },
        },
      ],
      components: [
        {
          type: 'row',
          components: [
            {
              type: 'button',
              customId: 'username:claim',
              label: 'Take it',
              style: 'success',
              disabled: false,
            },
          ],
        },
      ],
    };
  }

  // "Taken" and "no repeated separators" are different problems and deserve
  // different words. The second is fixable in the next message; the first is
  // not fixable at all, and suggesting alternatives would mostly teach people
  // to squat on the near misses.
  const taken = result.reason === 'Taken';
  return {
    content: null,
    embeds: [
      {
        title: taken ? `@${candidate} is taken` : `@${candidate} will not work`,
        description: taken
          ? 'Somebody already answers to that one.'
          : (result.reason ?? 'That is not a valid username.'),
        color: AMBER,
        fields: [],
        footer: { text: '3 to 32 characters — letters, numbers, dot and underscore.' },
      },
    ],
  };
};

const profileSavedCard = (title: string, value: string | null, note?: string): YapperReply => ({
  content: null,
  embeds: [
    {
      title,
      description: value ? value.slice(0, 500) : 'Cleared.',
      color: GREEN,
      fields: [],
      ...(note ? { footer: { text: note } } : {}),
    },
  ],
});

/**
 * A refusal from `lib/profile.ts`, in words.
 *
 * The outer handler turns any throw into "something went wrong", which is the
 * right answer for a bug and the wrong one for "that name is taken" or "you
 * have changed it twice today" — both of which are the system working, and
 * both of which the person can act on. Anything that is not an `AppError`
 * falls through to the generic path, because an unexpected exception is
 * exactly the thing not to paraphrase.
 */
function refusalCard(err: unknown): YapperReply | null {
  if (!(err instanceof AppError)) return null;

  const retry = err.retryAfter;
  const wait =
    retry === undefined
      ? null
      : retry >= 3_600
        ? `about ${Math.round(retry / 3_600)} hour${retry >= 5_400 ? 's' : ''}`
        : `about ${Math.max(1, Math.round(retry / 60))} minute${retry >= 90 ? 's' : ''}`;

  return {
    content: null,
    embeds: [
      {
        title: err.status === 429 ? 'Not just yet' : 'That did not work',
        description: err.status === 429 && wait ? `Try again in ${wait}.` : err.message,
        color: AMBER,
        fields: [],
      },
    ],
  };
}

async function applyDisplayName(
  app: FastifyInstance,
  userId: string,
  value: string,
): Promise<YapperReply> {
  try {
    const saved = await setDisplayName(app, userId, value);
    return profileSavedCard('Display name changed', saved, 'This is the name people see beside your messages.');
  } catch (err) {
    return refusalCard(err) ?? { content: 'I could not change that. Try again in a moment.' };
  }
}

async function applyBio(app: FastifyInstance, userId: string, value: string): Promise<YapperReply> {
  try {
    const saved = await setBio(app, userId, value);
    return profileSavedCard(saved ? 'Bio changed' : 'Bio cleared', saved);
  } catch (err) {
    return refusalCard(err) ?? { content: 'I could not change that. Try again in a moment.' };
  }
}

/**
 * The Take it button.
 *
 * The name comes from the prompt row, never from the `customId` — a button id
 * is client-supplied text, and letting it name the handle would let a crafted
 * press claim anything. Reading server-side state keyed to the presser is the
 * same rule the report buttons follow.
 *
 * The prompt is cleared whichever way this goes. A claim that failed because
 * somebody else took the name in the meantime must not leave a live button
 * that will fail identically on the next press.
 */
async function claimUsername(
  app: FastifyInstance,
  botId: string,
  input: { actorId: string; conversationId: string },
): Promise<InteractionResponse> {
  const pending = await getPrompt(app, botId, input.actorId, input.conversationId);
  if (!pending || pending.state !== 'username:claim') {
    return {
      kind: 'update',
      content: null,
      embeds: [
        {
          title: 'That has expired',
          description: 'Check the name again with /username and I will offer it fresh.',
          color: AMBER,
          fields: [],
        },
      ],
      components: [],
    };
  }

  const candidate = typeof pending.data.username === 'string' ? pending.data.username : '';
  await clearPrompt(app, botId, input.actorId);

  try {
    const { from, to } = await changeUsername(app, input.actorId, candidate);
    return {
      kind: 'update',
      content: null,
      embeds: [
        {
          title: `You are @${to}`,
          description: from
            ? `@${from} is no longer yours. Anyone who had it saved will see the new one.`
            : 'People can find you by that name now.',
          color: GREEN,
          fields: [],
          footer: { text: 'Old names are kept on record, so a handover can be traced.' },
        },
      ],
      components: [],
    };
  } catch (err) {
    const refusal = refusalCard(err);
    return {
      kind: 'update',
      content: refusal ? null : 'I could not take that name. Try again in a moment.',
      embeds: refusal?.embeds ?? [],
      components: [],
    };
  }
}

// ─── Reporting ───────────────────────────────────────────────────────────────

const askCard = (title: string, description: string, footer?: string): YapperReply => ({
  content: null,
  embeds: [
    {
      title,
      description,
      color: VIOLET,
      fields: [],
      ...(footer ? { footer: { text: footer } } : {}),
    },
  ],
});

const confirmTargetCard = (
  target: { id: string; username: string | null; displayName: string | null },
  userId: string,
): YapperReply => ({
  content: null,
  embeds: [
    {
      title: 'Is this who you mean?',
      description: `${target.displayName ?? 'No display name'} · @${target.username ?? 'unknown'}`,
      color: AMBER,
      fields: [],
      footer: { text: 'Reporting the wrong person wastes a moderator and clears nothing up.' },
    },
  ],
  components: [
    {
      type: 'row',
      components: [
        {
          type: 'button',
          customId: 'report:target-yes',
          label: 'Yes, that is them',
          style: 'primary',
          disabled: false,
          onlyUserId: userId,
        },
        {
          type: 'button',
          customId: 'report:cancel',
          label: 'Cancel',
          style: 'secondary',
          disabled: false,
          onlyUserId: userId,
        },
      ],
    },
  ],
});

/**
 * The category picker.
 *
 * Buttons rather than free text because the category is not a description —
 * it is the field triage sorts on. `reportPriority` reads it, the classifier
 * hook switches on it, and the staff card titles itself with it, so a sentence
 * typed into that slot is not a slower version of the right answer, it is the
 * wrong type. What the person wants to say in their own words is asked for
 * next, and stored as the report's detail.
 *
 * Laid out **two to a row**, four rows.
 *
 * Not because eight would not fit the five-row budget — it would, two rows of
 * four — but because the clients render a row as equal-width cells inside a
 * 300pt cap with 14pt of padding each. Four-up leaves about 42pt of text per
 * button, and both `ComponentRows` implementations carry the same warning that
 * *two*-up is already the tight case. "Impersonation" would clip to about six
 * characters, and a category button that reads "Imper…" is not a category
 * button.
 *
 * The bot is the one that has to know this: rows are the only layout control
 * the component protocol has, so a card that does not fit is a card the bot
 * built wrong, not a client that rendered it wrong.
 */
const reasonPickerCard = (userId: string): YapperReply => {
  const button = (reason: ReportReason): MessageButton => ({
    type: 'button',
    customId: `report:reason:${reason}`,
    label: REPORT_REASON_LABEL[reason],
    // The two that jump the queue are marked as the serious ones they are,
    // rather than sitting in a row of identical grey.
    style: reportPriority(reason) > 0 ? 'danger' : 'secondary',
    disabled: false,
    onlyUserId: userId,
  });

  return {
    content: null,
    embeds: [
      {
        title: 'What kind of problem is this?',
        description: 'Pick the closest one. You can explain in your own words next.',
        color: VIOLET,
        fields: [],
        footer: { text: 'If someone is in immediate danger, contact your local emergency services.' },
      },
    ],
    components: [0, 2, 4, 6].map((start) => ({
      type: 'row' as const,
      components: REPORT_REASONS.slice(start, start + 2).map(button),
    })),
  };
};

const reviewReportCard = (
  data: Record<string, unknown>,
  userId: string,
): YapperReply => ({
  content: null,
  embeds: [
    {
      title: 'Send this report?',
      description: 'A moderator will see exactly this.',
      color: AMBER,
      fields: [
        { name: 'About', value: `@${String(data.targetUsername ?? 'unknown')}`, inline: true },
        {
          name: 'Category',
          value: REPORT_REASON_LABEL[data.reason as ReportReason] ?? String(data.reason ?? '—'),
          inline: true,
        },
        { name: 'What happened', value: String(data.detail ?? '—').slice(0, 1_024), inline: false },
        { name: 'Proof', value: (data.proof ? String(data.proof) : 'None given').slice(0, 1_024), inline: false },
      ],
      footer: { text: 'Nothing has been sent yet.' },
    },
  ],
  components: [
    {
      type: 'row',
      components: [
        {
          type: 'button',
          customId: 'report:submit',
          label: 'Submit',
          style: 'danger',
          disabled: false,
          onlyUserId: userId,
        },
        {
          type: 'button',
          customId: 'report:cancel',
          label: 'Cancel',
          style: 'secondary',
          disabled: false,
          onlyUserId: userId,
        },
      ],
    },
  ],
});

/**
 * Resolve `@name` (or a bare name) to an account.
 *
 * Refuses yourself and refuses bots: both are almost always a mistyped
 * username, and a report against either is noise a moderator has to read.
 */
async function resolveTarget(
  app: FastifyInstance,
  raw: string,
  reporterId: string,
): Promise<
  | { ok: true; user: { id: string; username: string | null; displayName: string | null } }
  | { ok: false; reason: string }
> {
  const handle = raw.trim().replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{2,32}$/.test(handle)) {
    return { ok: false, reason: 'That does not look like a username. Send it like @someone, or /cancel.' };
  }

  const [found] = await app.db
    .select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      isBot: users.isBot,
    })
    .from(users)
    .where(and(eq(users.username, handle), isNull(users.deletedAt)))
    .limit(1);

  if (!found) return { ok: false, reason: `I cannot find @${handle}. Check the spelling, or /cancel.` };
  if (found.id === reporterId) return { ok: false, reason: 'That is you. Send someone else, or /cancel.' };
  if (found.isBot) {
    return { ok: false, reason: 'That is a bot. Report the person operating it instead, or /cancel.' };
  }
  return { ok: true, user: found };
}

const outcomeCard = (approved: boolean, detail: string): YapperReply => ({
  content: null,
  embeds: [
    {
      title: approved ? 'Signed in' : 'Rejected',
      description: detail,
      color: approved ? GREEN : RED,
      fields: [],
    },
  ],
  components: [],
});

// ─── Sticker packs ─────────────────────────────────────────────────────────

/** The first emoji in a caption, and whatever text is left as the name. */
const EMOJI_RE =
  /(\p{Extended_Pictographic}(‍\p{Extended_Pictographic})*|\p{Emoji_Presentation})/u;

function parseStickerCaption(caption: string): { emoji: string | null; name: string | null } {
  const trimmed = caption.trim();
  const match = trimmed.match(EMOJI_RE);
  const emoji = match?.[0] ?? null;
  const name = (emoji ? trimmed.replace(emoji, '') : trimmed).trim();
  return { emoji, name: name.length > 0 ? name.slice(0, 40) : null };
}

/** A URL-safe, unique-ish slug for a pack, from its name plus a short suffix. */
function packSlug(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return `${base || 'pack'}-${newId().slice(0, 6)}`;
}

/** `/stickerpack [name]` — open the flow, or jump straight in with a name. */
async function startStickerPack(
  app: FastifyInstance,
  botId: string,
  userId: string,
  conversationId: string,
  argument: string,
): Promise<YapperReply> {
  // A name on the command line skips the menu entirely.
  if (argument.trim()) {
    return createPackAndPrompt(app, botId, userId, conversationId, argument.trim());
  }

  const mine = await app.db
    .select({ id: stickerPacks.id, name: stickerPacks.name })
    .from(stickerPacks)
    .where(and(eq(stickerPacks.authorId, userId), isNull(stickerPacks.deletedAt)))
    .orderBy(desc(stickerPacks.createdAt))
    .limit(9);

  if (mine.length === 0) {
    await setPrompt(app, { botId, userId, conversationId, state: 'sticker:name' });
    return {
      content: null,
      embeds: [
        {
          title: 'New sticker pack',
          description: 'Send a name for your pack, and I will start it. /cancel to stop.',
          color: VIOLET,
          fields: [],
        },
      ],
    };
  }

  await setPrompt(app, {
    botId,
    userId,
    conversationId,
    state: 'sticker:choose',
    data: { packs: mine },
  });
  return {
    content: null,
    embeds: [
      {
        title: 'Sticker packs',
        description: 'Send a number to add to a pack, or a new name to start another.',
        color: VIOLET,
        fields: mine.map((p, i) => ({ name: `${i + 1}. ${p.name}`, value: '​', inline: false })),
        footer: { text: '/cancel to stop' },
      },
    ],
  };
}

/** Create the pack row (owned by the user) and move to the add step. */
async function createPackAndPrompt(
  app: FastifyInstance,
  botId: string,
  userId: string,
  conversationId: string,
  name: string,
): Promise<YapperReply> {
  const cleanName = name.slice(0, 40);
  const [pack] = await app.db
    .insert(stickerPacks)
    .values({ id: newId(), slug: packSlug(cleanName), name: cleanName, authorId: userId })
    .returning();

  // The author gets it installed, same as the REST create path.
  await app.db
    .insert(userStickerPacks)
    .values({ userId, packId: pack!.id })
    .onConflictDoNothing();

  await setPrompt(app, {
    botId,
    userId,
    conversationId,
    state: 'sticker:add',
    data: { packId: pack!.id, packName: cleanName, count: 0 },
  });
  return {
    content: null,
    embeds: [
      {
        title: `${cleanName} · created`,
        description:
          'Now send a sticker: attach an image, and put the emoji it stands for in the caption (with an optional name). Send /done when finished.',
        color: VIOLET,
        fields: [],
      },
    ],
  };
}

/** `sticker:choose` — a number picks an existing pack; anything else is a name. */
async function chooseStickerPack(
  app: FastifyInstance,
  botId: string,
  userId: string,
  conversationId: string,
  text: string,
  data: Record<string, unknown>,
): Promise<YapperReply> {
  const packs = (data.packs as Array<{ id: string; name: string }> | undefined) ?? [];
  const index = Number.parseInt(text.trim(), 10);
  if (Number.isFinite(index) && index >= 1 && index <= packs.length) {
    const chosen = packs[index - 1]!;
    await setPrompt(app, {
      botId,
      userId,
      conversationId,
      state: 'sticker:add',
      data: { packId: chosen.id, packName: chosen.name, count: 0 },
    });
    return {
      content: `Adding to ${chosen.name}. Send a sticker — an image with an emoji caption — or /done.`,
    };
  }
  // Not a number → treat it as a new pack name.
  return createPackAndPrompt(app, botId, userId, conversationId, text);
}

/**
 * `sticker:add` — turn an attached image into a sticker in the current pack.
 *
 * The uploaded image lives in the private attachment bucket; a sticker is
 * served publicly, so the object is copied into the public bucket under a fresh
 * sticker-purpose media row before the sticker is inserted. The pack is the
 * user's, so ownership is never yapper's.
 */
async function addSticker(
  app: FastifyInstance,
  botId: string,
  userId: string,
  conversationId: string,
  caption: string,
  attachmentIds: string[],
  data: Record<string, unknown>,
): Promise<YapperReply> {
  const packId = String(data.packId ?? '');
  const packName = String(data.packName ?? 'your pack');
  const count = Number(data.count ?? 0);
  // An image that arrived without its emoji, parked while we ask for it.
  const parkedMediaId = typeof data.pendingMediaId === 'string' ? data.pendingMediaId : null;

  const { emoji, name } = parseStickerCaption(caption);

  if (attachmentIds.length === 0 && /^done$/i.test(caption.trim())) {
    await clearPrompt(app, botId, userId);
    return { content: `Saved ${count} ${count === 1 ? 'sticker' : 'stickers'} to ${packName}.` };
  }

  // Clients send the picture and its caption however they like — some as one
  // message, some as two. The flow accepts both halves in either order: an
  // emoji on its own claims the parked image, an image on its own gets parked.
  // Demanding both in one message put people in a loop where each half of the
  // answer was rejected for missing the other half.
  const mediaId = attachmentIds[0] ?? (emoji ? parkedMediaId : null);

  if (!mediaId) {
    return { content: 'Attach an image to add it as a sticker, or send /done.' };
  }

  if (!emoji) {
    // The emoji is required and drives emoji→sticker suggestions; without it a
    // sticker is unfindable. Park the image and ask for just the missing half.
    await setPrompt(app, {
      botId,
      userId,
      conversationId,
      state: 'sticker:add',
      data: { packId, packName, count, pendingMediaId: mediaId },
    });
    return {
      content: 'Got the image. Now send the emoji it stands for — add a name after it if you like.',
    };
  }

  const [pack] = await app.db
    .select()
    .from(stickerPacks)
    .where(and(eq(stickerPacks.id, packId), isNull(stickerPacks.deletedAt)))
    .limit(1);
  if (!pack || pack.authorId !== userId) {
    await clearPrompt(app, botId, userId);
    return { content: 'That pack is no longer available. Start again with /stickerpack.' };
  }
  if (pack.stickerCount >= LIMITS.stickersPerPack) {
    await clearPrompt(app, botId, userId);
    return { content: `${packName} is full (${LIMITS.stickersPerPack} stickers). Send /stickerpack to start another.` };
  }

  // Read the source image the user just uploaded. A fresh upload sits at
  // 'processing' until the worker cuts its thumbnail — that is a fine source
  // for a sticker, and requiring 'ready' here rejected anyone who sent the
  // image quickly. Confirmed and not failed/quarantined is the real bar.
  const [source] = await app.db
    .select()
    .from(media)
    .where(and(eq(media.id, mediaId), eq(media.ownerId, userId), isNull(media.deletedAt)))
    .limit(1);
  if (
    !source ||
    !source.confirmedAt ||
    source.status === 'failed' ||
    source.status === 'quarantined' ||
    !source.mimeType.startsWith('image/')
  ) {
    return { content: 'That does not look like an image. Attach a picture to make a sticker.' };
  }

  // Promote it into the public sticker bucket.
  const ext = source.mimeType.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png';
  const destBucket = Storage.bucketFor('sticker');
  const destKey = Storage.buildKey('sticker', userId, ext);
  try {
    await app.storage.copyObject({
      fromBucket: source.bucket,
      fromKey: source.objectKey,
      toBucket: destBucket,
      toKey: destKey,
      mimeType: source.mimeType,
    });
  } catch (err) {
    app.log.error({ err }, 'sticker copy failed');
    return { content: 'Something went wrong saving that sticker. Try again.' };
  }

  const [stickerMedia] = await app.db
    .insert(media)
    .values({
      id: newId(),
      ownerId: userId,
      purpose: 'sticker',
      status: 'ready',
      bucket: destBucket,
      objectKey: destKey,
      mimeType: source.mimeType,
      size: source.size,
      width: source.width,
      height: source.height,
      confirmedAt: new Date(),
    })
    .returning();

  await app.db.insert(stickers).values({
    id: newId(),
    packId,
    mediaId: stickerMedia!.id,
    emoji,
    name,
    position: pack.stickerCount,
  });
  await app.db
    .update(stickerPacks)
    .set({ stickerCount: pack.stickerCount + 1, updatedAt: new Date() })
    .where(eq(stickerPacks.id, packId));

  await setPrompt(app, {
    botId,
    userId,
    conversationId,
    state: 'sticker:add',
    data: { packId, packName, count: count + 1 },
  });
  return { content: `Added ${emoji} to ${packName}. Send another, or /done.` };
}

// ─── Messages ────────────────────────────────────────────────────────────────

/**
 * Handle one message sent to yapper. Returns the reply, or null if this is not
 * for the bot.
 *
 * Never throws into the caller: this runs after a message has already been
 * accepted, and a bot that fails must not turn a delivered message into an
 * error for the person who sent it.
 */
export async function handleYapperMessage(
  app: FastifyInstance,
  input: {
    conversationId: string;
    senderId: string;
    content: string | null;
    /** Media ids on the message — how an image reaches the sticker flow. */
    attachmentIds?: string[];
  },
): Promise<YapperReply | null> {
  const text = input.content?.trim() ?? '';
  const hasAttachment = (input.attachmentIds?.length ?? 0) > 0;
  // A bare image is only interesting mid-sticker-flow; otherwise a message with
  // no text is nothing for the bot to answer.
  if (!text && !hasAttachment) return null;

  const botId = await getYapperUserId(app);
  if (!botId || botId === input.senderId) return null;

  const inDm = await isYapperDm(app, input.conversationId, botId);
  const inStaffChannel = !inDm && (await isStaffChannel(app, input.conversationId));
  if (!inDm && !inStaffChannel) return null;

  // In the staff channels yapper answers *only* staff commands. /login or
  // /privacy typed in #general should be ignored, not acted on in front of
  // the whole team — the personal commands belong in a DM.
  if (inStaffChannel) {
    if (!text.startsWith('/')) return null;
    const [command, ...rest] = text.split(/\s+/);
    const name = command?.toLowerCase();
    if (name !== '/reports' && name !== '/lookup') return null;
    if (!(await isStaffUser(app, input.senderId))) return null;
    return name === '/reports'
      ? await reportsCard(app)
      : await lookupCard(app, rest[0] ?? '');
  }

  try {
    const pending = await getPrompt(app, botId, input.senderId, input.conversationId);

    // An answer to a live question wins over command parsing, except for the
    // escape hatch — otherwise someone stuck in a prompt cannot get out.
    if (pending && !text.startsWith('/')) {
      switch (pending.state) {
        case 'awaiting_code':
          // Only something shaped like a code is an answer. Anything else is
          // just a message, and falls through to be ignored the way any other
          // plain sentence in this DM would be.
          if (!CODE_SHAPE.test(text.trim())) break;
          return await claimCode(app, botId, input, text, pending.expiresAt);

        case 'report:user': {
          const target = await resolveTarget(app, text, input.senderId);
          if (!target.ok) return { content: target.reason };
          await setPrompt(app, {
            botId,
            userId: input.senderId,
            conversationId: input.conversationId,
            state: 'report:confirm',
            data: {
              targetId: target.user.id,
              targetUsername: target.user.username,
              targetName: target.user.displayName,
            },
          });
          return confirmTargetCard(target.user, input.senderId);
        }

        case 'report:detail': {
          await setPrompt(app, {
            botId,
            userId: input.senderId,
            conversationId: input.conversationId,
            state: 'report:proof',
            data: { ...pending.data, detail: text.slice(0, 1_000) },
          });
          return askCard(
            'Any proof?',
            'Paste a link to the message, or describe where to find it. Send "skip" if you have none.',
            'A report without something to check is much harder to act on.',
          );
        }

        case 'report:proof': {
          // null, not the words "None given" — that string is for the card.
          // Storing it as the report's detail would put display text into the
          // moderation queue and read as though someone typed it.
          const proof = /^skip$/i.test(text) ? null : text.slice(0, 1_000);
          const data = { ...pending.data, proof };
          await setPrompt(app, {
            botId,
            userId: input.senderId,
            conversationId: input.conversationId,
            state: 'report:review',
            data,
          });
          return reviewReportCard(data, input.senderId);
        }

        case 'sticker:name':
          return await createPackAndPrompt(app, botId, input.senderId, input.conversationId, text)

        case 'sticker:choose':
          return await chooseStickerPack(app, botId, input.senderId, input.conversationId, text, pending.data)

        case 'sticker:add':
          return await addSticker(
            app,
            botId,
            input.senderId,
            input.conversationId,
            text,
            input.attachmentIds ?? [],
            pending.data,
          )

        /**
         * The announcement, collected one field at a time.
         *
         * Re-checked for staff at every step, not just at `/announce`: a prompt
         * outlives the command that opened it, and someone whose staff flag was
         * revoked mid-flow must not be able to finish.
         */
        case 'announce:title': {
          if (!(await isStaffUser(app, input.senderId))) {
            await clearPrompt(app, botId, input.senderId);
            return null;
          }
          await setPrompt(app, {
            botId,
            userId: input.senderId,
            conversationId: input.conversationId,
            state: 'announce:body',
            data: { ...pending.data, title: text.slice(0, 200) },
          });
          return askCard(
            'Now the message',
            'The body of the announcement. Plain text — write it the way you want it read.',
            'Up to 2000 characters.',
          );
        }

        case 'announce:body': {
          if (!(await isStaffUser(app, input.senderId))) {
            await clearPrompt(app, botId, input.senderId);
            return null;
          }
          await setPrompt(app, {
            botId,
            userId: input.senderId,
            conversationId: input.conversationId,
            state: 'announce:footer',
            data: { ...pending.data, body: text.slice(0, 2_000) },
          });
          return askCard(
            'A footer?',
            'The small line under the message — a version number, a date, a link. Send "skip" for none.',
            'This is the last thing I will ask.',
          );
        }

        case 'announce:footer': {
          if (!(await isStaffUser(app, input.senderId))) {
            await clearPrompt(app, botId, input.senderId);
            return null;
          }
          const footer = /^skip$/i.test(text) ? null : text.slice(0, 200);
          const data = { ...pending.data, footer };
          await setPrompt(app, {
            botId,
            userId: input.senderId,
            conversationId: input.conversationId,
            state: 'announce:review',
            data,
          });
          return await reviewAnnouncementCard(app, data, input.senderId);
        }

        case 'profile:name':
          await clearPrompt(app, botId, input.senderId);
          return await applyDisplayName(app, input.senderId, text);

        case 'profile:bio':
          await clearPrompt(app, botId, input.senderId);
          return await applyBio(app, input.senderId, text);

        // These are answered by a button, not by typing. Say so rather than
        // silently swallowing the message.
        case 'report:confirm':
        case 'report:category':
        case 'report:review':
        case 'username:claim':
        case 'announce:audience':
        case 'announce:review':
          return { content: 'Use the buttons above, or /cancel.' };
      }
    }

    if (!text.startsWith('/')) return null;

    const [command, ...rest] = text.split(/\s+/);
    /**
     * Everything after the command, with its own spacing intact.
     *
     * `rest.join(' ')` would flatten a bio's line breaks and double spaces into
     * single ones — fine for a code or a username, wrong for prose the person
     * wrote deliberately.
     */
    const argument = text.slice(command?.length ?? 0).trim();

    switch (command?.toLowerCase()) {
      case '/help':
      case '/start': {
        const page = Number.parseInt(argument, 10);
        return helpCard(Number.isFinite(page) ? page : 1);
      }

      case '/cancel': {
        if (!pending) return { content: 'Nothing to cancel.' };
        await clearPrompt(app, botId, input.senderId);
        return { content: 'Cancelled.' };
      }

      case '/stickerpack':
        return startStickerPack(app, botId, input.senderId, input.conversationId, argument);

      case '/done': {
        if (pending?.state === 'sticker:add') {
          await clearPrompt(app, botId, input.senderId);
          const count = Number(pending.data.count ?? 0);
          const name = String(pending.data.packName ?? 'your pack');
          return {
            content:
              count > 0
                ? `Saved ${count} ${count === 1 ? 'sticker' : 'stickers'} to ${name}. Open the sticker picker to use them.`
                : `${name} has no stickers yet — send an image with an emoji caption to add one, or /cancel.`,
          };
        }
        return { content: 'Nothing to finish.' };
      }

      case '/report': {
        await setPrompt(app, {
          botId,
          userId: input.senderId,
          conversationId: input.conversationId,
          state: 'report:user',
        });
        return askCard(
          'Who are you reporting?',
          'Send their username, like @someone.',
          'Reports go to a human moderator. /cancel stops this at any point.',
        );
      }

      case '/ping': {
        // Honest about what it measures: the bot is in-process, so this says
        // the API is answering, not that the network is fast.
        return { content: 'Here. The API answered this in-process, so if you saw it, it is up.' };
      }

      case '/username': {
        const candidate = argument.replace(/^@/, '');
        if (!candidate) {
          const [me] = await app.db
            .select({ username: users.username })
            .from(users)
            .where(eq(users.id, input.senderId))
            .limit(1);
          return {
            content: me?.username
              ? `You are @${me.username}. Send /username <name> to see if another one is free.`
              : 'You have no username yet. Send /username <name> to check one.',
          };
        }

        const result = await checkUsername(app, candidate);
        // Only arm the claim when there is something to claim. A prompt left
        // behind by a failed check would make the *next* button press act on a
        // name the person has since moved on from.
        if (result.available && result.normalised) {
          await setPrompt(app, {
            botId,
            userId: input.senderId,
            conversationId: input.conversationId,
            state: 'username:claim',
            data: { username: result.normalised },
          });
        } else {
          await clearPrompt(app, botId, input.senderId);
        }
        return usernameCard(result.normalised ?? candidate.slice(0, 32), result);
      }

      case '/name': {
        if (argument) return await applyDisplayName(app, input.senderId, argument);
        await setPrompt(app, {
          botId,
          userId: input.senderId,
          conversationId: input.conversationId,
          state: 'profile:name',
        });
        return askCard(
          'What should people call you?',
          `Send it here. Up to ${LIMITS.displayNameMax} characters, and it does not have to be unique.`,
          '/cancel if you have changed your mind.',
        );
      }

      case '/bio': {
        if (argument) return await applyBio(app, input.senderId, argument);
        await setPrompt(app, {
          botId,
          userId: input.senderId,
          conversationId: input.conversationId,
          state: 'profile:bio',
        });
        return {
          content: null,
          embeds: [
            {
              title: 'Send me your new bio',
              description: `Up to ${LIMITS.bioMax} characters. It shows on your profile to anyone who can see it.`,
              color: VIOLET,
              fields: [],
              footer: { text: '/cancel if you have changed your mind.' },
            },
          ],
          components: [
            {
              type: 'row',
              components: [
                {
                  type: 'button',
                  customId: 'bio:clear',
                  label: 'Clear it instead',
                  style: 'secondary',
                  disabled: false,
                  onlyUserId: input.senderId,
                },
              ],
            },
          ],
        };
      }

      case '/whoami': {
        const [me] = await app.db
          .select({
            id: users.id,
            username: users.username,
            displayName: users.displayName,
            badge: users.badge,
            isVerified: users.isVerified,
            createdAt: users.createdAt,
          })
          .from(users)
          .where(eq(users.id, input.senderId))
          .limit(1);
        if (!me) return { content: 'I cannot find your account, which should not be possible.' };

        return {
          content: null,
          embeds: [
            {
              title: me.displayName ?? me.username ?? 'You',
              description: me.username ? `@${me.username}` : 'No username set.',
              color: VIOLET,
              fields: [
                { name: 'User ID', value: me.id, inline: false },
                {
                  name: 'Joined',
                  value: me.createdAt.toISOString().slice(0, 10),
                  inline: true,
                },
                {
                  name: 'Badge',
                  value: me.badge ?? (me.isVerified ? 'verified' : 'none'),
                  inline: true,
                },
              ],
            },
          ],
        };
      }

      case '/privacy': {
        const [me] = await app.db
          .select({ privacy: users.privacy })
          .from(users)
          .where(eq(users.id, input.senderId))
          .limit(1);
        return privacyCard(me?.privacy ?? {}, input.senderId);
      }

      case '/apps': {
        const owned = await app.db
          .select({
            name: applications.name,
            tokenPrefix: applications.tokenPrefix,
            botUsername: users.username,
            revokedAt: applications.revokedAt,
          })
          .from(applications)
          .leftJoin(users, eq(users.id, applications.botUserId))
          .where(eq(applications.ownerId, input.senderId))
          .limit(20);

        const live = owned.filter((a) => !a.revokedAt);
        if (live.length === 0) {
          return {
            content: null,
            embeds: [
              {
                title: 'You have not built a bot yet',
                description:
                  'Sign in to the developer portal with /login and you can create one there.',
                color: VIOLET,
                fields: [],
              },
            ],
          };
        }

        return {
          content: null,
          embeds: [
            {
              title: live.length === 1 ? 'Your bot' : `Your ${live.length} bots`,
              color: VIOLET,
              // Never the token, only its prefix. A chat message is stored,
              // synced, backed up and screenshotted; it is the last place a
              // credential should be repeated back to someone.
              fields: live.map((a) => ({
                name: a.name,
                value: `@${a.botUsername ?? 'unknown'} · ${a.tokenPrefix}…`,
                inline: false,
              })),
              footer: { text: 'Tokens are only shown once, when you create them.' },
            },
          ],
        };
      }

      case '/status': {
        // Measured, not asserted. A status command that always says "healthy"
        // is worse than no status command.
        const startedAt = Date.now();
        await app.db.execute(raw`select 1`);
        const dbMs = Date.now() - startedAt;

        return {
          content: null,
          embeds: [
            {
              title: 'yappy is up',
              color: dbMs < 100 ? GREEN : AMBER,
              fields: [
                { name: 'Database', value: `responded in ${dbMs} ms`, inline: true },
                {
                  name: 'API uptime',
                  value: formatDuration(process.uptime()),
                  inline: true,
                },
              ],
              footer: { text: 'Reported by the instance that handled this message.' },
            },
          ],
        };
      }

      case '/reports': {
        if (!(await isStaffUser(app, input.senderId))) {
          return { content: `I don't know ${command}. Try /help.` };
        }
        return await reportsCard(app);
      }

      case '/lookup': {
        // The refusal is byte-identical to an unknown command on purpose:
        // a non-staff account probing for staff commands learns nothing,
        // not even that the commands exist.
        if (!(await isStaffUser(app, input.senderId))) {
          return { content: `I don't know ${command}. Try /help.` };
        }
        return await lookupCard(app, rest[0] ?? '');
      }

      case '/badge': {
        if (!(await isStaffUser(app, input.senderId))) {
          return { content: `I don't know ${command}. Try /help.` };
        }
        return await badgeCommand(app, input.senderId, rest);
      }

      case '/stats': {
        if (!(await isStaffUser(app, input.senderId))) {
          return { content: `I don't know ${command}. Try /help.` };
        }
        return await statsCard(app);
      }

      case '/queue': {
        if (!(await isStaffUser(app, input.senderId))) {
          return { content: `I don't know ${command}. Try /help.` };
        }
        return await queueCard(app);
      }

      case '/group': {
        if (!(await isStaffUser(app, input.senderId))) {
          return { content: `I don't know ${command}. Try /help.` };
        }
        // The whole remainder, because group names have spaces in them and
        // taking the first word would search for "the".
        return await groupCard(app, rest.join(' '));
      }

      case '/unsuspend': {
        if (!(await isStaffUser(app, input.senderId))) {
          return { content: `I don't know ${command}. Try /help.` };
        }
        return await unsuspendCommand(app, input.senderId, rest[0] ?? '');
      }

      case '/audit': {
        if (!(await isStaffUser(app, input.senderId))) {
          return { content: `I don't know ${command}. Try /help.` };
        }
        return await auditCard(app, rest[0] ?? '');
      }

      case '/bot': {
        if (!(await isStaffUser(app, input.senderId))) {
          return { content: `I don't know ${command}. Try /help.` };
        }
        return await botCard(app, rest.join(' '));
      }

      case '/find': {
        if (!(await isStaffUser(app, input.senderId))) {
          return { content: `I don't know ${command}. Try /help.` };
        }
        return await findCard(app, rest.join(' '));
      }

      case '/announce': {
        if (!(await isStaffUser(app, input.senderId))) {
          return { content: `I don't know ${command}. Try /help.` };
        }
        await setPrompt(app, {
          botId,
          userId: input.senderId,
          conversationId: input.conversationId,
          state: 'announce:audience',
          data: {},
        });
        return audiencePickerCard(input.senderId);
      }

      case '/docs':
        return docsCard(rest.join(' '));

      case '/error':
        return errorCard(rest[0] ?? '');

      case '/perms':
        return permsCard(rest);

      case '/webhook':
        return await webhookCard(app, input.senderId);

      case '/about': {
        return {
          content: null,
          embeds: [
            {
              title: 'yappy',
              description:
                'A group chat where the group is the point: presence, a media wall, pins and drop-in voice, with no public feed to perform for.',
              color: VIOLET,
              fields: [
                { name: 'Bot', value: '@yapper, first-party', inline: true },
                { name: 'Site', value: 'yappy.gg', inline: true },
              ],
              footer: { text: 'I only act in this conversation. I am not in your groups.' },
            },
          ],
        };
      }

      case '/login': {
        // `/login ABCD-EFGH` stays supported: the portal prints a code, and
        // someone who has it in hand should not be made to answer a question
        // to use it.
        const inline = rest[0]?.trim();
        if (inline) return await claimCode(app, botId, input, inline);

        await setPrompt(app, {
          botId,
          userId: input.senderId,
          conversationId: input.conversationId,
          state: 'awaiting_code',
        });
        return {
          content: null,
          embeds: [
            {
              title: 'Send me the code',
              description:
                'The developer portal is showing a code like ABCD-EFGH. Send it here and I will tell you what is asking to sign in.',
              color: VIOLET,
              fields: [],
              footer: { text: '/cancel if you did not mean to start this.' },
            },
          ],
        };
      }

      default:
        return { content: `I don't know ${command}. Try /help.` };
    }
  } catch (err) {
    app.log.error({ err }, 'yapper command failed');
    return { content: 'Something went wrong handling that. Try again in a moment.' };
  }
}

/** Shared by `/login <code>` and the answer to "send me the code". */
async function claimCode(
  app: FastifyInstance,
  botId: string,
  input: { conversationId: string; senderId: string },
  code: string,
  /** The deadline already running, when this is a retry of a live question. */
  expiresAt?: Date,
): Promise<YapperReply> {
  const claim = await claimGrant(app.db, input.senderId, code);

  if (!claim.ok) {
    await noteBadAttempt(app.db, input.senderId);
    // The question stays open on a wrong code — a typo should not mean
    // starting over — but on the *original* deadline, not a fresh one.
    await setPrompt(app, {
      botId,
      userId: input.senderId,
      conversationId: input.conversationId,
      state: 'awaiting_code',
      expiresAt,
    });
    return { content: `${claim.reason} Send another code, or /cancel.` };
  }

  await clearPrompt(app, botId, input.senderId);
  return confirmCard({ description: claim.description, ip: claim.ip, userId: input.senderId });
}

// ─── Announcements ───────────────────────────────────────────────────────────

type Audience = 'staff' | 'everyone';

/**
 * Who an announcement reaches.
 *
 * `staff` exists to be the dry run. It renders through the identical path, so
 * what the team sees is byte-for-byte what everyone would have got — which is
 * worth far more than a preview that merely resembles the real thing.
 *
 * Bots are excluded from both: a DM to a webhook's bot account is a message
 * nobody will ever read, and it would fire that bot's webhook.
 */
const audienceWhere = (audience: Audience) =>
  audience === 'staff'
    ? raw`u.deleted_at is null and u.is_bot = false and u.is_staff = true`
    : raw`u.deleted_at is null and u.is_bot = false
          and (u.suspended_until is null or u.suspended_until < now())`;

/**
 * How many people this would actually reach.
 *
 * Counts the audience, not the deliverable set: `deliverYapperDm` still drops
 * anyone who has turned announcements off or blocked yapper, and reproducing
 * those checks here would be a second copy of a rule that must not drift. So
 * the number on the card is an upper bound, and it says so.
 */
async function countAudience(app: FastifyInstance, audience: Audience): Promise<number> {
  const rows = (await app.db.execute(
    raw`select count(*)::int as n from users u where ${audienceWhere(audience)}`,
  )) as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

/**
 * Roughly how many lines the body will occupy on a phone.
 *
 * Deliberately crude. The point is not accuracy, it is to catch the case that
 * cannot be fixed afterwards: apps already installed cap an embed body at eight
 * lines and ellipsise the rest, and no server change or app release reaches a
 * message that has already been delivered. So the warning has to happen here,
 * while the text can still be shortened.
 *
 * 38 characters per line is the narrow case (a small phone in a DM bubble),
 * and hard line breaks count for themselves because a paragraph gap costs a
 * line of the same budget.
 */
const OLD_CLIENT_LINE_CAP = 8;

function estimateRenderedLines(body: string): number {
  return body
    .split('\n')
    .reduce((total, line) => total + Math.max(1, Math.ceil(line.length / 38)), 0);
}

const audiencePickerCard = (userId: string): YapperReply => ({
  content: null,
  embeds: [
    {
      title: 'Who is this for?',
      description:
        'Staff first is the safe habit — it renders exactly the same way, so you see the real thing before anyone else does.',
      color: AMBER,
      fields: [],
      footer: { text: 'Nothing is sent until you confirm.' },
    },
  ],
  components: [
    {
      type: 'row',
      components: [
        {
          type: 'button',
          customId: 'announce:aud:staff',
          label: 'Staff only',
          style: 'secondary',
          disabled: false,
          onlyUserId: userId,
          staffOnly: true,
        },
        {
          type: 'button',
          customId: 'announce:aud:everyone',
          label: 'Everyone',
          style: 'danger',
          disabled: false,
          onlyUserId: userId,
          staffOnly: true,
        },
      ],
    },
  ],
});

/**
 * The confirmation.
 *
 * Two embeds: the announcement exactly as it will arrive, and beneath it the
 * blast radius. Showing the real card rather than a summary of it is the whole
 * point — a typo is visible here or it is visible to everyone.
 */
async function reviewAnnouncementCard(
  app: FastifyInstance,
  data: Record<string, unknown>,
  userId: string,
): Promise<YapperReply> {
  const audience = (data.audience === 'everyone' ? 'everyone' : 'staff') as Audience;
  const count = await countAudience(app, audience);
  const footer = typeof data.footer === 'string' ? data.footer : '';
  const truncated = estimateRenderedLines(String(data.body ?? ''));

  return {
    content: null,
    embeds: [
      {
        author: { name: 'Announcement' },
        title: String(data.title ?? 'An update from yappy'),
        description: String(data.body ?? ''),
        color: VIOLET,
        fields: [],
        ...(footer ? { footer: { text: footer } } : {}),
      },
      {
        title: audience === 'everyone' ? 'This goes to everyone' : 'This goes to staff only',
        description:
          audience === 'everyone'
            ? `Up to **${count}** people will get this as a direct message from me. There is no undo.`
            : `**${count}** staff accounts. Nobody else sees it.`,
        color: audience === 'everyone' ? RED : AMBER,
        // The one problem that cannot be fixed after sending. Newer apps show
        // the whole thing; every app already installed stops at eight lines and
        // ellipsises the rest, and no release reaches a delivered message.
        fields:
          truncated > OLD_CLIENT_LINE_CAP
            ? [
                {
                  name: 'Older apps will cut this short',
                  value:
                    `Your message is about ${truncated} lines. Apps that have not updated show the first ` +
                    `${OLD_CLIENT_LINE_CAP} and then an ellipsis, so put anything that must be read near the top, ` +
                    `or shorten it.`,
                  inline: false,
                },
              ]
            : [],
        footer: {
          text: 'Anyone who has turned announcements off, or blocked me, is skipped — so the real number is lower.',
        },
      },
    ],
    components: [
      {
        type: 'row',
        components: [
          {
            type: 'button',
            customId: 'announce:send',
            label: audience === 'everyone' ? 'Send to everyone' : 'Send to staff',
            style: 'danger',
            disabled: false,
            onlyUserId: userId,
            staffOnly: true,
          },
          {
            type: 'button',
            customId: 'announce:cancel',
            label: 'Cancel',
            style: 'secondary',
            disabled: false,
            onlyUserId: userId,
            staffOnly: true,
          },
        ],
      },
    ],
  };
}

/**
 * A press on one of the announcement buttons.
 *
 * Staff is re-checked here as well as on the button's own `staffOnly` flag.
 * The flag is enforced generically by `pressButton` against the presser, which
 * is the real gate; this is the belt to its braces, and it costs one indexed
 * read on the least frequent action in the product.
 */
async function handleAnnounceButton(
  app: FastifyInstance,
  botId: string,
  input: { actorId: string; conversationId: string; customId: string },
): Promise<InteractionResponse> {
  if (!(await isStaffUser(app, input.actorId))) return { kind: 'ack' };

  const pending = await getPrompt(app, botId, input.actorId, input.conversationId);

  if (input.customId === 'announce:cancel') {
    await clearPrompt(app, botId, input.actorId);
    return {
      kind: 'update',
      content: null,
      embeds: [{ title: 'Cancelled', description: 'Nothing was sent.', color: AMBER, fields: [] }],
      components: [],
    };
  }

  if (input.customId.startsWith('announce:aud:')) {
    const audience: Audience = input.customId.endsWith('everyone') ? 'everyone' : 'staff';
    await setPrompt(app, {
      botId,
      userId: input.actorId,
      conversationId: input.conversationId,
      state: 'announce:title',
      data: { ...(pending?.data ?? {}), audience },
    });
    return {
      kind: 'update',
      content: null,
      embeds: [
        {
          title: 'What is the headline?',
          description: 'The bold line at the top of the card. Keep it short.',
          color: VIOLET,
          fields: [],
          footer: {
            text: audience === 'everyone' ? 'Audience: everyone' : 'Audience: staff only',
          },
        },
      ],
      components: [],
    };
  }

  if (input.customId !== 'announce:send') return { kind: 'ack' };

  if (!pending || pending.state !== 'announce:review') {
    return {
      kind: 'update',
      content: null,
      embeds: [
        {
          title: 'That draft is gone',
          description: 'It expired or was cancelled. Start again with /announce.',
          color: AMBER,
          fields: [],
        },
      ],
      components: [],
    };
  }

  const data = pending.data ?? {};
  const audience = (data.audience === 'everyone' ? 'everyone' : 'staff') as Audience;

  /**
   * One id for the whole broadcast, and it is the idempotency key.
   *
   * It becomes each recipient's message nonce downstream, so a fan-out job that
   * dies halfway and is retried resolves every already-sent message to the one
   * that exists and only the remainder are new. Without it a pg-boss retry
   * would message the first half of the user table twice.
   */
  const broadcastId = newId();

  await app.db.insert(auditLog).values({
    id: newId(),
    userId: input.actorId,
    action: 'announcement.send',
    // The full text, not a summary. The question asked after a bad send is
    // always "what exactly went out", and a truncated record cannot answer it.
    metadata: {
      broadcastId,
      audience,
      title: String(data.title ?? ''),
      body: String(data.body ?? ''),
      footer: typeof data.footer === 'string' ? data.footer : null,
    },
  });

  await app.boss.send('yapper.broadcast', {
    broadcastId,
    audience,
    actorId: input.actorId,
    title: String(data.title ?? ''),
    body: String(data.body ?? ''),
    footer: typeof data.footer === 'string' ? data.footer : null,
  });

  await clearPrompt(app, botId, input.actorId);

  const { recipients, eta } = await estimateBroadcast(app, audience);

  return {
    kind: 'update',
    content: null,
    embeds: [
      {
        title: 'On its way',
        description:
          audience === 'everyone'
            ? 'I am delivering it now, one person at a time.'
            : 'Sent to staff. Run /announce again to send the same thing to everyone.',
        color: GREEN,
        fields: [
          { name: 'Going to', value: `${recipients.toLocaleString('en-GB')} people`, inline: true },
          { name: 'Should finish in', value: eta, inline: true },
          { name: 'Reference', value: broadcastId, inline: false },
        ],
        footer: { text: 'Recorded in the audit log.' },
      },
    ],
    components: [],
  };
}

/**
 * Sustained delivery rate, messages per second.
 *
 * Measured rather than guessed: 213 announcements drained in 88 seconds on one
 * API instance, which is 2.4/s. Rounded down, because an estimate that comes in
 * early is a pleasant surprise and one that comes in late is a bug report.
 *
 * It is the *API* that sets this, not the worker — the worker only decides who
 * gets one, and `yapper.dm` is consumed by the API because posting a message
 * needs the message service. So more API instances means a faster send and this
 * number becomes conservative rather than wrong.
 */
const DELIVERY_PER_SECOND = 2;

/**
 * How many people, and how long.
 *
 * "A few minutes" was true for a few thousand and quietly false for more, and
 * the question staff actually have before pressing send is whether this is a
 * coffee or an afternoon. The count uses the same predicate as the fan-out, so
 * the number shown is the number of jobs that will be enqueued rather than a
 * rough headcount of the users table.
 */
async function estimateBroadcast(
  app: FastifyInstance,
  audience: Audience,
): Promise<{ recipients: number; eta: string }> {
  const rows = (await app.db.execute(
    audience === 'staff'
      ? raw`select count(*)::int as n from users
             where deleted_at is null and is_bot = false and is_staff = true`
      : raw`select count(*)::int as n from users
             where deleted_at is null and is_bot = false
               and (suspended_until is null or suspended_until < now())`,
  )) as unknown as Array<{ n: number }>;

  const recipients = rows[0]?.n ?? 0;
  return { recipients, eta: roughDuration(Math.ceil(recipients / DELIVERY_PER_SECOND)) };
}

/**
 * A duration a person can act on.
 *
 * Deliberately coarse. Nobody waiting on a broadcast wants "4 minutes and 12
 * seconds" — they want to know whether to stay on this screen, and the honest
 * precision of an estimate is about one significant figure anyway.
 */
function roughDuration(seconds: number): string {
  if (seconds < 45) return 'under a minute';
  const minutes = Math.round(seconds / 60);
  if (minutes <= 1) return 'about a minute';
  if (minutes < 60) return `about ${minutes} minutes`;
  const hours = seconds / 3_600;
  if (hours < 1.75) return 'about an hour';
  return `about ${Math.round(hours)} hours`;
}

// ─── Buttons ─────────────────────────────────────────────────────────────────

/**
 * A press on one of yapper's buttons. Returns null if the button is not one of
 * yapper's, which is how `dispatch` decides whether this bot owns it.
 */
export async function handleYapperInteraction(
  app: FastifyInstance,
  input: { botId: string; actorId: string; conversationId: string; messageId: string; customId: string },
): Promise<InteractionResponse | null> {
  const botId = await getYapperUserId(app);
  if (!botId || botId !== input.botId) return null;

  if (input.customId.startsWith('privacy:')) {
    const [, setting, audience] = input.customId.split(':');
    return await setAudience(app, input.actorId, setting ?? '', audience ?? '');
  }

  if (input.customId === 'notify:off') {
    return await setAnnouncements(app, input.actorId, false);
  }

  if (input.customId === 'username:claim') {
    return await claimUsername(app, botId, input);
  }

  if (input.customId === 'bio:clear') {
    await clearPrompt(app, botId, input.actorId);
    const card = await applyBio(app, input.actorId, '');
    return { kind: 'update', content: card.content, embeds: card.embeds, components: [] };
  }

  if (input.customId.startsWith('webhook:test:')) {
    const card = await requestWebhookTest(app, input.actorId, input.customId.split(':')[2] ?? '');
    return { kind: 'update', content: card.content, embeds: card.embeds, components: card.components };
  }

  if (input.customId.startsWith('announce:')) {
    return await handleAnnounceButton(app, botId, input);
  }

  if (input.customId.startsWith('report:')) {
    return await handleReportButton(app, botId, input);
  }

  if (input.customId.startsWith('modreport:')) {
    return await handleModReportButton(app, input);
  }

  if (!input.customId.startsWith('login:')) return null;

  const approve = input.customId === 'login:approve';

  try {
    const result = await confirmGrant(app.db, input.actorId, approve);

    // Even a failed confirmation retires the prompt. The grant is gone or
    // expired; leaving a live Approve button on screen would only produce the
    // same error again.
    if (!result.ok) {
      return {
        kind: 'update',
        content: null,
        embeds: [
          {
            title: 'That request is no longer waiting',
            description: result.message,
            color: RED,
            fields: [],
          },
        ],
        components: [],
      };
    }

    const card = outcomeCard(approve, result.message);
    return {
      kind: 'update',
      content: card.content,
      embeds: card.embeds,
      components: card.components,
    };
  } catch (err) {
    app.log.error({ err }, 'yapper interaction failed');
    return { kind: 'ack' };
  }
}

/**
 * Change one of the presser's audiences, then re-render the card so the new
 * state is visible rather than merely claimed.
 *
 * Writes only the one key, merged over whatever else is in `privacy`: replacing
 * the object would silently reset every setting the person has chosen.
 *
 * Both the setting and the audience come out of a `customId`, which arrives
 * from a client and could say anything — so each is checked against a fixed
 * list rather than interpolated. Without the first check this would be a
 * write-any-privacy-key primitive with the column name supplied by the caller.
 */
const AUDIENCE_SETTINGS: Record<string, keyof PrivacySettings> = {
  dm: 'whoCanDm',
  groups: 'whoCanAddToGroups',
};

async function setAudience(
  app: FastifyInstance,
  userId: string,
  setting: string,
  audience: string,
): Promise<InteractionResponse> {
  const key = AUDIENCE_SETTINGS[setting];
  if (!key) return { kind: 'ack' };
  if (!PRIVACY_AUDIENCES.includes(audience as (typeof PRIVACY_AUDIENCES)[number])) {
    return { kind: 'ack' };
  }

  const [updated] = await app.db
    .update(users)
    .set({
      privacy:
        raw`coalesce(${users.privacy}, '{}'::jsonb) || ${JSON.stringify({ [key]: audience })}::jsonb` as never,
    })
    .where(eq(users.id, userId))
    .returning({ privacy: users.privacy });

  const card = privacyCard(updated?.privacy ?? {}, userId);
  return {
    kind: 'update',
    content: card.content,
    embeds: card.embeds,
    components: card.components,
  };
}

/**
 * Turn the optional unprompted DMs off (or back on).
 *
 * Merged over the existing object rather than written whole, for the same
 * reason `setDmAudience` is: replacing `notifications` would silently reset
 * every other choice the person has made.
 *
 * Security notices are unaffected and the card says so, because a switch that
 * appears to cover more than it does is worse than no switch — someone who
 * believes they have silenced everything reads the next sign-in alert as spam
 * rather than as the warning it is.
 */
async function setAnnouncements(
  app: FastifyInstance,
  userId: string,
  on: boolean,
): Promise<InteractionResponse> {
  await app.db
    .update(users)
    .set({
      notifications:
        raw`coalesce(${users.notifications}, '{}'::jsonb) || ${JSON.stringify({ announcements: on })}::jsonb` as never,
    })
    .where(eq(users.id, userId));

  return {
    kind: 'update',
    content: null,
    embeds: [
      {
        title: on ? 'Tips back on' : 'That is off now',
        description: on
          ? 'I will send the occasional useful note again.'
          : 'I will not send tips, welcome notes or bot housekeeping again.',
        color: VIOLET,
        fields: [],
        footer: {
          text: 'Sign-in alerts and account notices still arrive — those are not tips.',
        },
      },
    ],
    components: [],
  };
}

/**
 * The two decision points in the report flow.
 *
 * Both read the prompt row rather than trusting anything encoded in the
 * button: a `customId` arrives from the client and could say anything, so the
 * only thing it is allowed to select is *which branch runs*. Who is being
 * reported, and why, comes from server-side state keyed to the presser.
 */
async function handleReportButton(
  app: FastifyInstance,
  botId: string,
  input: { actorId: string; conversationId: string; customId: string },
): Promise<InteractionResponse> {
  const pending = await getPrompt(app, botId, input.actorId, input.conversationId);

  if (input.customId === 'report:cancel') {
    await clearPrompt(app, botId, input.actorId);
    return {
      kind: 'update',
      content: null,
      embeds: [{ title: 'Cancelled', description: 'Nothing was sent.', color: VIOLET, fields: [] }],
      components: [],
    };
  }

  if (!pending) {
    return {
      kind: 'update',
      content: null,
      embeds: [
        {
          title: 'That report is no longer open',
          description: 'It expired or was already sent. Start again with /report.',
          color: RED,
          fields: [],
        },
      ],
      components: [],
    };
  }

  if (input.customId === 'report:target-yes') {
    await setPrompt(app, {
      botId,
      userId: input.actorId,
      conversationId: input.conversationId,
      state: 'report:category',
      data: pending.data,
    });
    const card = reasonPickerCard(input.actorId);
    return { kind: 'update', content: card.content, embeds: card.embeds, components: card.components };
  }

  if (input.customId.startsWith('report:reason:')) {
    const reason = input.customId.slice('report:reason:'.length);
    // The customId arrived from a client and could say anything. It selects a
    // branch and nothing else — an unrecognised category is dropped rather
    // than written through to a column that triage reads.
    if (!REPORT_REASONS.includes(reason as ReportReason)) return { kind: 'ack' };

    await setPrompt(app, {
      botId,
      userId: input.actorId,
      conversationId: input.conversationId,
      state: 'report:detail',
      data: { ...pending.data, reason },
    });
    const card = askCard(
      'What happened?',
      `Tell me what @${String(pending.data.targetUsername ?? 'they')} did. One or two sentences is plenty.`,
      reportPriority(reason) > 0
        ? 'This category is reviewed ahead of the queue.'
        : undefined,
    );
    return { kind: 'update', content: card.content, embeds: card.embeds, components: [] };
  }

  if (input.customId === 'report:submit') {
    const targetId = String(pending.data.targetId ?? '');
    if (!targetId) return { kind: 'ack' };

    // Re-validated at submit, not trusted from the prompt row: the category
    // decides the priority and the classifier's branch, so it gets checked at
    // the point it is written rather than only where it was chosen.
    const reason: ReportReason = REPORT_REASONS.includes(pending.data.reason as ReportReason)
      ? (pending.data.reason as ReportReason)
      : 'other';
    const detail = pending.data.detail ? String(pending.data.detail).slice(0, 1_000) : null;
    const proof = pending.data.proof ? String(pending.data.proof).slice(0, 1_000) : null;
    const priority = reportPriority(reason);

    // The same snapshot POST /reports takes. A report whose subject has since
    // changed their name — or deleted the account — is otherwise unactionable
    // by the time anyone reads it.
    const [subject] = await app.db
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        bio: users.bio,
      })
      .from(users)
      .where(eq(users.id, targetId))
      .limit(1);

    const [row] = await app.db
      .insert(reports)
      .values({
        id: newId(),
        reporterId: input.actorId,
        targetType: 'user',
        targetId,
        reason,
        detail,
        // Frozen at submit time. The username can change, and a queue entry
        // that no longer names anyone recognisable is hard to action.
        evidence: {
          source: 'yapper',
          targetUsername: pending.data.targetUsername ?? null,
          proof,
          ...(subject ? { user: subject } : {}),
        },
        priority,
      })
      .returning({ id: reports.id });

    await clearPrompt(app, botId, input.actorId);

    // The classifier hook, same as the REST path. Without this a CSAM report
    // filed here would sit in the queue at whatever pace the team happened to
    // be reading it, while the identical report filed from the client would
    // have been shouted about the moment it landed.
    await app.enqueue('moderation.triage', { reportId: row?.id ?? '', reason });

    // Surface it in the staff #reports channel. Not awaited: the card is the
    // team's notification, and the reporter should not wait on it.
    void userLabel(app, input.actorId)
      .then((reporterLabel) =>
        postReportCard(app, {
          reportId: row?.id ?? '',
          reason,
          detail,
          targetLabel: `@${String(pending.data.targetUsername ?? 'unknown')}`,
          reporterLabel,
          priority,
        }),
      )
      .catch((err) => app.log.warn({ err }, 'report card post failed'));

    return {
      kind: 'update',
      content: null,
      embeds: [
        {
          title: 'Report sent',
          description: 'A moderator will look at it. You will not be told who handled it.',
          color: GREEN,
          fields: [
            // Short reference: enough to quote in a follow-up, not the full id.
            { name: 'Reference', value: (row?.id ?? '').slice(0, 8), inline: true },
          ],
          footer: { text: 'If you are in danger, contact your local emergency services.' },
        },
      ],
      components: [],
    };
  }

  return { kind: 'ack' };
}

// ─── Staff ───────────────────────────────────────────────────────────────────

async function isStaffUser(app: FastifyInstance, userId: string): Promise<boolean> {
  const [row] = await app.db
    .select({ isStaff: users.isStaff })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .limit(1);
  return Boolean(row?.isStaff);
}

/** Is this one of the staff space's channels? Cached lookups, three ids. */
async function isStaffChannel(app: FastifyInstance, conversationId: string): Promise<boolean> {
  const ids = await Promise.all([
    getSystemConversationId(app, 'staff_reports'),
    getSystemConversationId(app, 'staff_general'),
    getSystemConversationId(app, 'staff_gitlog'),
  ]);
  return ids.some((id) => id !== null && id === conversationId);
}

/** The open queue, newest-priority-first, as a card. */
async function reportsCard(app: FastifyInstance): Promise<YapperReply> {
  const open = await app.db
    .select()
    .from(reports)
    .where(inArray(reports.status, ['open', 'reviewing']))
    .orderBy(desc(reports.priority), reports.createdAt)
    .limit(5);

  const totalRows = (await app.db.execute(
    raw`select count(*)::int as total from reports where status in ('open','reviewing')`,
  )) as unknown as Array<{ total: number }>;
  const total = totalRows[0]?.total ?? 0;

  if (total === 0) {
    return {
      content: null,
      embeds: [
        { title: 'Queue is clear', description: 'No open reports.', color: GREEN, fields: [] },
      ],
    };
  }

  const fields = await Promise.all(
    open.map(async (r) => ({
      name: `${r.reason} · ${r.id.slice(0, 8)}${r.priority >= 80 ? ' · PRIORITY' : ''}`,
      value:
        r.targetType === 'user'
          ? `About ${await userLabel(app, r.targetId)}`
          : `About a ${r.targetType}`,
      inline: false,
    })),
  );

  return {
    content: null,
    embeds: [
      {
        title: `${total} open report${total === 1 ? '' : 's'}`,
        description: total > 5 ? 'The five most urgent. The portal has the rest.' : null,
        color: AMBER,
        fields,
        footer: { text: 'Act from the cards in #reports, or the portal.' },
      },
    ],
  };
}

/** A user as staff see them. More than the public profile, deliberately. */
/**
 * Grant or take back a badge.
 *
 * `/badge @someone` lists what they hold. `/badge @someone beta` toggles it —
 * one verb rather than a grant and a revoke, because the state is visible in
 * the same breath and "the opposite of what it is" is what staff actually mean.
 *
 * Badges are a claim the platform makes about a person, so every change is
 * written to the audit log with who did it. The single `badge` column is
 * recomputed from the set on every change, which is what keeps already-shipped
 * clients — which know nothing about the array — showing the most significant
 * mark instead of nothing.
 */
async function badgeCommand(
  app: FastifyInstance,
  actorId: string,
  rest: string[],
): Promise<YapperReply> {
  const handle = (rest[0] ?? '').trim().replace(/^@/, '');
  if (!/^[A-Za-z0-9_.]{2,32}$/.test(handle)) {
    return {
      content: null,
      embeds: [
        {
          title: 'Badges',
          description: 'Give me a username, and a badge to toggle.',
          color: VIOLET,
          fields: [
            { name: 'See what someone holds', value: '/badge @someone', inline: false },
            { name: 'Grant or take back', value: '/badge @someone beta', inline: false },
            { name: 'The set', value: BADGE_KINDS.join(', '), inline: false },
          ],
        },
      ],
    };
  }

  const [target] = await app.db
    .select()
    .from(users)
    .where(and(eq(users.username, handle), isNull(users.deletedAt)))
    .limit(1);
  if (!target) return { content: `No account named @${handle}.` };

  const held = ((target.badges as string[] | null) ?? []).filter((b) =>
    (BADGE_KINDS as readonly string[]).includes(b),
  );

  const wanted = (rest[1] ?? '').trim().toLowerCase();
  if (!wanted) {
    return {
      content: null,
      embeds: [
        {
          title: `@${handle}`,
          description: held.length ? held.join(', ') : 'No badges.',
          color: VIOLET,
          fields: [{ name: 'Toggle one', value: `/badge @${handle} <badge>`, inline: false }],
        },
      ],
    };
  }

  if (!(BADGE_KINDS as readonly string[]).includes(wanted)) {
    return { content: `There is no "${wanted}" badge. Try: ${BADGE_KINDS.join(', ')}.` };
  }

  const granting = !held.includes(wanted);
  const next = granting ? [...held, wanted] : held.filter((b) => b !== wanted);

  await app.db
    .update(users)
    .set({
      badges: next,
      // Kept in step by the same write. `primaryBadge` is the one place that
      // decides which mark speaks for somebody, so the column and the array
      // cannot disagree about it.
      badge: primaryBadge(next),
    })
    .where(eq(users.id, target.id));

  await app.db.insert(auditLog).values({
    id: newId(),
    userId: actorId,
    action: granting ? 'badge.grant' : 'badge.revoke',
    metadata: { targetId: target.id, username: handle, badge: wanted, badges: next },
  });

  // Live, everywhere. A badge that needs a restart to appear is a badge that
  // has not been granted yet, as far as anyone looking is concerned.
  await publishProfileUpdate(app, target.id);

  // They should hear it from us rather than notice it. Keyed on the pair so a
  // grant, a revoke and a re-grant are three separate notices.
  await app.enqueue('yapper.dm', {
    userId: target.id,
    kind: 'badge_changed',
    dedupe: `${wanted}_${granting ? 'on' : 'off'}_${target.id}`,
    payload: { badge: wanted, granted: granting },
  });

  return {
    content: null,
    embeds: [
      {
        title: granting ? 'Granted' : 'Taken back',
        // No markdown. An embed description is drawn as plain text on both
        // clients, so asterisks arrive as asterisks — the emphasis has to come
        // from the layout instead, which is what the fields below are for.
        description: `@${handle} ${granting ? 'now holds' : 'no longer holds'} ${wanted}.`,
        color: granting ? GREEN : AMBER,
        fields: [
          { name: 'Holds', value: next.length ? next.join(', ') : 'nothing', inline: false },
          { name: 'Shown as', value: primaryBadge(next) ?? 'none', inline: true },
        ],
        footer: { text: 'Recorded in the audit log.' },
      },
    ],
  };
}

/**
 * The platform, right now.
 *
 * The question staff actually open a dashboard for, answered in the place they
 * already are. One query rather than six round trips, because a stats card that
 * takes two seconds gets asked for less often than one that does not.
 *
 * Today's numbers are the ones worth showing: totals only ever go up and stop
 * meaning anything, while "new today" and "sent today" are how you notice
 * something has gone wrong before anyone reports it.
 */
async function statsCard(app: FastifyInstance): Promise<YapperReply> {
  const rows = (await app.db.execute(raw`
    select
      (select count(*) from users where deleted_at is null and is_bot = false) as people,
      (select count(*) from users
        where deleted_at is null and is_bot = false and created_at > now() - interval '24 hours') as joined,
      (select count(*) from users
        where deleted_at is null and is_bot = false and suspended_until > now()) as suspended,
      (select count(*) from presence where expires_at > now()) as online,
      (select count(*) from messages where created_at > now() - interval '24 hours') as messages,
      (select count(*) from conversations
        where deleted_at is null and type in ('group','space')) as groups,
      (select count(*) from reports where status = 'open') as reports,
      (select count(*) from applications where revoked_at is null) as bots
  `)) as unknown as Array<Record<string, string | number>>;

  const n = (key: string) => Number(rows[0]?.[key] ?? 0).toLocaleString('en-GB');

  return {
    content: null,
    embeds: [
      {
        title: 'yappy, right now',
        color: VIOLET,
        fields: [
          { name: 'People', value: n('people'), inline: true },
          { name: 'Joined today', value: n('joined'), inline: true },
          { name: 'Online', value: n('online'), inline: true },
          { name: 'Messages today', value: n('messages'), inline: true },
          { name: 'Groups', value: n('groups'), inline: true },
          { name: 'Bots', value: n('bots'), inline: true },
          { name: 'Open reports', value: n('reports'), inline: true },
          { name: 'Suspended', value: n('suspended'), inline: true },
        ],
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

/**
 * Background work: what is waiting, what failed, what is stuck.
 *
 * "Is it just slow, or is it broken?" is the first question of every incident,
 * and until now the only way to answer it was to open a database. Pushes,
 * announcements, media processing and bot webhooks all run through pg-boss, so
 * one look at its queues covers most of what can silently stop.
 *
 * Green when nothing is failing and nothing has been waiting long. Amber the
 * moment either is true — the numbers are on the card, and the colour is what
 * makes somebody read them.
 */
async function queueCard(app: FastifyInstance): Promise<YapperReply> {
  const rows = (await app.db.execute(raw`
    select name,
           count(*) filter (where state = 'created') as waiting,
           count(*) filter (where state = 'active') as running,
           count(*) filter (where state = 'failed'
             and created_on > now() - interval '1 hour') as failed,
           extract(epoch from now() - min(created_on) filter (where state = 'created'))::int as oldest
      from pgboss.job
     where created_on > now() - interval '24 hours'
       and name not like '\\_\\_pgboss\\_\\_%'
     group by name
     having count(*) filter (where state in ('created','active','failed')) > 0
     order by count(*) filter (where state = 'failed') desc, name
     limit 12
  `)) as unknown as Array<{
    name: string;
    waiting: string;
    running: string;
    failed: string;
    oldest: number | null;
  }>;

  if (rows.length === 0) {
    return {
      content: null,
      embeds: [
        {
          title: 'Queues are clear',
          description: 'Nothing waiting, nothing running, nothing failed in the last hour.',
          color: GREEN,
          fields: [],
        },
      ],
    };
  }

  const failing = rows.some((r) => Number(r.failed) > 0);
  // Two minutes. Below that a backlog is just throughput; above it something
  // is not draining.
  const stuck = rows.some((r) => (r.oldest ?? 0) > 120);

  return {
    content: null,
    embeds: [
      {
        title: failing || stuck ? 'Queues need a look' : 'Queues are moving',
        color: failing || stuck ? AMBER : GREEN,
        fields: rows.map((r) => ({
          name: r.name,
          value: [
            `${Number(r.waiting)} waiting`,
            `${Number(r.running)} running`,
            Number(r.failed) > 0 ? `${Number(r.failed)} failed` : null,
            (r.oldest ?? 0) > 120 ? `oldest ${formatDuration(r.oldest ?? 0)}` : null,
          ]
            .filter(Boolean)
            .join(' · '),
          inline: false,
        })),
        footer: { text: 'Failures counted over the last hour.' },
      },
    ],
  };
}

/**
 * A conversation, as staff see it.
 *
 * Reports name groups, and there was no way to look one up — the only lookup
 * yapper had took a username. Accepts a handle or an id, because a report gives
 * you an id and a person gives you a handle.
 *
 * Deliberately no message content. This answers "what is this place and who
 * runs it", which is what a moderator needs before deciding anything; reading
 * a private group's messages is a different act with a different threshold, and
 * it should not be one command away from a handle.
 */
async function groupCard(app: FastifyInstance, rawRef: string): Promise<YapperReply> {
  const ref = rawRef.trim().replace(/^[@#]/, '');
  if (!ref) return { content: 'Give me a name, a handle or an id: /group weekend plans' };

  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref);

  /**
   * Name first, because that is what anybody actually has.
   *
   * This took a handle or an id, which sounded reasonable and was useless: most
   * groups have no handle — a handle is a thing public groups opt into — and an
   * id appears nowhere in either app. So the only way to use the command was to
   * already have queried the database, which is the thing it exists to avoid.
   *
   * An id and a handle still work, since a report gives you one and a person
   * gives you the other. A name is the third way in and the common one.
   */
  const matches = isUuid
    ? await app.db
        .select()
        .from(conversations)
        .where(and(eq(conversations.id, ref), isNull(conversations.deletedAt)))
        .limit(1)
    : await app.db
        .select()
        .from(conversations)
        .where(
          and(
            or(
              eq(conversations.handle, ref),
              // Not a DM: those have no title and are nobody's to browse.
              and(
                inArray(conversations.type, ['group', 'space', 'channel']),
                raw`${conversations.title} ilike ${'%' + ref + '%'}`,
              ),
            ),
            isNull(conversations.deletedAt),
          ),
        )
        // Biggest first: with several matches, the one somebody means is
        // almost always the one with the most people in it.
        .orderBy(desc(conversations.memberCount))
        .limit(8);

  if (matches.length === 0) return { content: `No conversation matching "${ref}".` };

  // More than one, so let them pick rather than guessing at it.
  if (matches.length > 1) {
    return {
      content: null,
      embeds: [
        {
          title: `${matches.length} matches for "${ref}"`,
          description: 'Run /group with the id of the one you want.',
          color: VIOLET,
          fields: matches.map((c) => ({
            name: `${c.title ?? 'Untitled'} · ${c.memberCount} members`,
            value: c.id,
            inline: false,
          })),
        },
      ],
    };
  }

  const row = matches[0]!;

  const [owner] = row.ownerId
    ? await app.db.select().from(users).where(eq(users.id, row.ownerId)).limit(1)
    : [undefined];

  const counts = (await app.db.execute(raw`
    select
      (select count(*) from messages where conversation_id = ${row.id}::uuid) as messages,
      (select count(*) from reports
        where target_type = 'conversation' and target_id = ${row.id}::uuid) as reports
  `)) as unknown as Array<{ messages: string; reports: string }>;

  return {
    content: null,
    embeds: [
      {
        title: row.title ?? 'Untitled',
        description: row.description ?? null,
        color: Number(counts[0]?.reports ?? 0) > 0 ? AMBER : VIOLET,
        fields: [
          { name: 'Type', value: row.type, inline: true },
          { name: 'Members', value: String(row.memberCount), inline: true },
          { name: 'Messages', value: Number(counts[0]?.messages ?? 0).toLocaleString('en-GB'), inline: true },
          { name: 'Visibility', value: row.isPublic ? 'Public' : 'Private', inline: true },
          { name: 'Handle', value: row.handle ? `#${row.handle}` : '—', inline: true },
          { name: 'Reports', value: String(Number(counts[0]?.reports ?? 0)), inline: true },
          {
            name: 'Owner',
            value: owner ? `${owner.displayName ?? '?'} (@${owner.username ?? '?'})` : 'none',
            inline: false,
          },
          { name: 'Created', value: row.createdAt.toISOString().slice(0, 10), inline: true },
          { name: 'Id', value: row.id, inline: false },
        ],
      },
    ],
  };
}

/**
 * Lift a suspension.
 *
 * Suspending is reachable from a report's buttons; lifting one was reachable
 * from nowhere at all, which made every suspension effectively permanent unless
 * somebody opened the database. The asymmetry was the bug.
 *
 * There is deliberately no `/suspend` to match. Suspending through a report
 * ties the action to the thing that prompted it, and a free-standing suspend
 * from a chat message is a policy decision rather than a helper command.
 */
async function unsuspendCommand(
  app: FastifyInstance,
  actorId: string,
  rawHandle: string,
): Promise<YapperReply> {
  const handle = rawHandle.trim().replace(/^@/, '');
  if (!/^[A-Za-z0-9_.]{2,32}$/.test(handle)) {
    return { content: 'Give me a username: /unsuspend @someone' };
  }

  const [target] = await app.db
    .select()
    .from(users)
    .where(and(eq(users.username, handle), isNull(users.deletedAt)))
    .limit(1);
  if (!target) return { content: `No account named @${handle}.` };

  if (!target.suspendedUntil || target.suspendedUntil <= new Date()) {
    return { content: `@${handle} is not suspended.` };
  }

  await app.db
    .update(users)
    .set({ suspendedUntil: null, suspensionReason: null })
    .where(eq(users.id, target.id));

  await app.db.insert(auditLog).values({
    id: newId(),
    userId: actorId,
    action: 'user.unsuspend',
    metadata: {
      targetId: target.id,
      username: handle,
      wasUntil: target.suspendedUntil.toISOString(),
      wasReason: target.suspensionReason,
    },
  });

  return {
    content: null,
    embeds: [
      {
        title: 'Suspension lifted',
        description: `@${handle} can post again.`,
        color: GREEN,
        fields: [
          { name: 'Was until', value: target.suspendedUntil.toISOString().slice(0, 16).replace('T', ' '), inline: true },
          { name: 'Reason given', value: target.suspensionReason ?? '—', inline: false },
        ],
        footer: { text: 'Recorded in the audit log.' },
      },
    ],
  };
}

/** Audit actions, in words. Unknown ones show their raw name rather than
 *  nothing — a new action added elsewhere should still be readable here. */
function auditLabel(action: string): string {
  switch (action) {
    case 'badge.grant': return 'Badge granted';
    case 'badge.revoke': return 'Badge taken back';
    case 'user.unsuspend': return 'Suspension lifted';
    case 'announcement.send': return 'Announcement sent';
    case 'password.changed': return 'Password changed';
    case 'session.created': return 'Signed in';
    case 'session.revoked_all': return 'Signed out everywhere';
    case 'session.refresh_reuse_detected': return 'Refresh token reused — session killed';
    default: return action;
  }
}

/**
 * What has been done to an account, and by whom.
 *
 * The audit log is written from seven places and was read from none, which is
 * an accountability trail that exists in theory. Granting badges and lifting
 * suspensions from a chat made that worse: powerful, reversible, invisible.
 *
 * Both directions, because they answer different questions. Things done *to*
 * this account is the moderation history — "who gave them that badge". Things
 * done *by* it matters when the account is staff, and is the other half of the
 * same accountability.
 *
 * The actor is on the row. An audit entry that says what happened but not who
 * did it is a log, not an audit.
 */
async function auditCard(app: FastifyInstance, rawHandle: string): Promise<YapperReply> {
  const handle = rawHandle.trim().replace(/^@/, '');
  if (!/^[A-Za-z0-9_.]{2,32}$/.test(handle)) {
    return { content: 'Give me a username: /audit @someone' };
  }

  const [target] = await app.db
    .select()
    .from(users)
    .where(and(eq(users.username, handle), isNull(users.deletedAt)))
    .limit(1);
  if (!target) return { content: `No account named @${handle}.` };

  // One query for both directions, with the actor's name joined on so the card
  // does not have to resolve a second set of ids afterwards.
  const rows = (await app.db.execute(raw`
    select a.action,
           a.created_at,
           a.metadata,
           a.user_id = ${target.id}::uuid as by_them,
           u.username as actor
      from audit_log a
      left join users u on u.id = a.user_id
     where a.user_id = ${target.id}::uuid
        or a.metadata->>'targetId' = ${target.id}
     order by a.created_at desc
     limit 12
  `)) as unknown as Array<{
    action: string;
    created_at: string;
    metadata: Record<string, unknown> | null;
    by_them: boolean;
    actor: string | null;
  }>;

  if (rows.length === 0) {
    return {
      content: null,
      embeds: [
        {
          title: `@${handle}`,
          description: 'Nothing in the audit log for this account.',
          color: VIOLET,
          fields: [],
        },
      ],
    };
  }

  return {
    content: null,
    embeds: [
      {
        title: `Audit · @${handle}`,
        description: `The last ${rows.length}, newest first.`,
        color: VIOLET,
        fields: rows.map((r) => {
          const when = new Date(r.created_at).toISOString().slice(0, 16).replace('T', ' ');
          // A badge grant names the badge; everything else says who did it.
          const detail = typeof r.metadata?.badge === 'string' ? ` · ${r.metadata.badge}` : '';
          const who = r.by_them
            ? 'by them'
            : r.actor
              ? `by @${r.actor}`
              : 'by the system';
          return {
            name: `${auditLabel(r.action)}${detail}`,
            value: `${when} · ${who}`,
            inline: false,
          };
        }),
      },
    ],
  };
}

/**
 * A bot, as staff see it.
 *
 * The two questions a misbehaving bot raises are "whose is it" and "is it even
 * reachable", and both were a database query away. yapper already *sends* a
 * notice when a webhook starts failing, so the failure count was being kept and
 * never shown to the person who has to act on it.
 *
 * Matched on the bot's username or its application name, because a report names
 * the account and the owner names the app.
 */
async function botCard(app: FastifyInstance, rawRef: string): Promise<YapperReply> {
  const ref = rawRef.trim().replace(/^@/, '');
  if (!ref) return { content: 'Give me a bot name: /bot scanner' };

  const rows = await app.db
    .select({ application: applications, bot: users })
    .from(applications)
    .innerJoin(users, eq(users.id, applications.botUserId))
    .where(
      and(
        isNull(applications.revokedAt),
        or(
          eq(users.username, ref),
          raw`${applications.name} ilike ${'%' + ref + '%'}`,
        ),
      ),
    )
    .limit(6);

  if (rows.length === 0) return { content: `No bot matching "${ref}".` };

  if (rows.length > 1) {
    return {
      content: null,
      embeds: [
        {
          title: `${rows.length} bots match "${ref}"`,
          description: 'Run /bot with the exact @username.',
          color: VIOLET,
          fields: rows.map((r) => ({
            name: r.application.name,
            value: `@${r.bot.username ?? '?'}`,
            inline: false,
          })),
        },
      ],
    };
  }

  const { application, bot } = rows[0]!;
  const [owner] = await app.db
    .select()
    .from(users)
    .where(eq(users.id, application.ownerId))
    .limit(1);

  const failing = application.webhookFailureCount > 0;

  return {
    content: null,
    embeds: [
      {
        title: application.name,
        description: application.description ?? null,
        // Amber when its webhook is failing: that is the state somebody is
        // usually here about.
        color: failing ? AMBER : VIOLET,
        fields: [
          { name: 'Account', value: `@${bot.username ?? '?'}`, inline: true },
          { name: 'Listed', value: application.isPublic ? 'Publicly' : 'Private', inline: true },
          { name: 'Commands', value: String((application.commands as unknown[] | null)?.length ?? 0), inline: true },
          {
            name: 'Owner',
            value: owner ? `${owner.displayName ?? '?'} (@${owner.username ?? '?'})` : 'unknown',
            inline: false,
          },
          {
            name: 'Delivery',
            value: application.webhookUrl
              ? `Webhook${failing ? ` · ${application.webhookFailureCount} failures` : ' · healthy'}`
              : 'Gateway (dials out)',
            inline: true,
          },
          {
            name: 'Last used',
            value: application.lastUsedAt
              ? `${formatDuration(Math.floor((Date.now() - application.lastUsedAt.getTime()) / 1000))} ago`
              : 'never',
            inline: true,
          },
          {
            name: 'Token issued',
            value: application.tokenIssuedAt.toISOString().slice(0, 10),
            inline: true,
          },
          // The URL last and on its own line: it is the longest thing here and
          // the one somebody copies.
          ...(application.webhookUrl
            ? [{ name: 'Webhook URL', value: application.webhookUrl, inline: false }]
            : []),
          { name: 'Id', value: application.id, inline: false },
        ],
      },
    ],
  };
}

/**
 * Resolve anything.
 *
 * Staff get handed ids — from a log line, an error report, a support message —
 * and had no way to find out what one *was*. Every other lookup needed you to
 * already know: `/lookup` takes a username, `/group` a name, `/bot` a bot.
 *
 * So this takes whatever is in front of you and answers the question before it:
 * what is this? A uuid is checked against everything that has one, in the order
 * staff are most likely to be holding, and then handed to the command that
 * already knows how to render it.
 *
 * Email and phone are here because a support conversation starts with one and
 * neither is searchable anywhere else. They are matched exactly — a partial
 * search over contact details is a different thing, and not one to build by
 * accident.
 */
async function findCard(app: FastifyInstance, rawRef: string): Promise<YapperReply> {
  const ref = rawRef.trim();
  if (!ref) return { content: 'Give me an id, an email, a phone number or a @handle.' };

  if (ref.startsWith('@')) return await lookupCard(app, ref);

  if (ref.includes('@') && ref.includes('.')) {
    const [byEmail] = await app.db
      .select({ username: users.username })
      .from(users)
      .where(and(eq(users.email, ref.toLowerCase()), isNull(users.deletedAt)))
      .limit(1);
    return byEmail?.username
      ? await lookupCard(app, byEmail.username)
      : { content: `No account with that email.` };
  }

  if (/^\+?[0-9]{6,15}$/.test(ref)) {
    const [byPhone] = await app.db
      .select({ username: users.username })
      .from(users)
      .where(and(eq(users.phone, ref.startsWith('+') ? ref : `+${ref}`), isNull(users.deletedAt)))
      .limit(1);
    return byPhone?.username
      ? await lookupCard(app, byPhone.username)
      : { content: `No account with that number.` };
  }

  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref);
  if (!isUuid) return await lookupCard(app, ref);

  // A user id.
  const [user] = await app.db.select().from(users).where(eq(users.id, ref)).limit(1);
  if (user?.username) return await lookupCard(app, user.username);
  if (user) return { content: `That is an account with no username (id ${ref}).` };

  // A conversation id.
  const [conversation] = await app.db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.id, ref))
    .limit(1);
  if (conversation) return await groupCard(app, ref);

  // An application id.
  const [application] = await app.db
    .select({ botUserId: applications.botUserId })
    .from(applications)
    .where(eq(applications.id, ref))
    .limit(1);
  if (application) {
    const [botUser] = await app.db
      .select({ username: users.username })
      .from(users)
      .where(eq(users.id, application.botUserId))
      .limit(1);
    if (botUser?.username) return await botCard(app, botUser.username);
  }

  /**
   * A message id.
   *
   * Says where it is and who sent it, and stops there. The content is not
   * printed: a moderator holding an id from a report can already read it in
   * context, and a command that prints any message into a staff chat from its
   * id alone is a different power than the rest of this list.
   */
  const [message] = await app.db
    .select({ message: messages, sender: users })
    .from(messages)
    .leftJoin(users, eq(users.id, messages.senderId))
    .where(eq(messages.id, ref))
    .limit(1);
  if (message) {
    return {
      content: null,
      embeds: [
        {
          title: 'A message',
          color: VIOLET,
          fields: [
            { name: 'Type', value: message.message.type, inline: true },
            { name: 'Sent', value: message.message.createdAt.toISOString().slice(0, 16).replace('T', ' '), inline: true },
            { name: 'Deleted', value: message.message.deletedAt ? 'Yes' : 'No', inline: true },
            {
              name: 'From',
              value: message.sender ? `@${message.sender.username ?? '?'}` : 'the system',
              inline: false,
            },
            { name: 'In conversation', value: message.message.conversationId, inline: false },
          ],
          footer: { text: 'Run /group with that conversation id.' },
        },
      ],
    };
  }

  // A media id.
  const [item] = await app.db.select().from(media).where(eq(media.id, ref)).limit(1);
  if (item) {
    return {
      content: null,
      embeds: [
        {
          title: 'A file',
          color: item.status === 'quarantined' ? AMBER : VIOLET,
          fields: [
            { name: 'Purpose', value: item.purpose, inline: true },
            { name: 'Type', value: item.mimeType, inline: true },
            { name: 'Status', value: item.status, inline: true },
            { name: 'Size', value: `${Math.round(item.size / 1024)} KB`, inline: true },
            { name: 'Uploaded', value: item.createdAt.toISOString().slice(0, 10), inline: true },
          ],
        },
      ],
    };
  }

  return { content: `Nothing in the database has the id ${ref}.` };
}

async function lookupCard(app: FastifyInstance, rawHandle: string): Promise<YapperReply> {
  const handle = rawHandle.trim().replace(/^@/, '');
  if (!/^[A-Za-z0-9_.]{2,32}$/.test(handle)) {
    return { content: 'Give me a username: /lookup @someone' };
  }

  const [u] = await app.db
    .select()
    .from(users)
    .where(and(eq(users.username, handle), isNull(users.deletedAt)))
    .limit(1);
  if (!u) return { content: `No account named @${handle}.` };

  const againstRows = (await app.db.execute(
    raw`select count(*)::int as against from reports
         where target_type = 'user' and target_id = ${u.id}::uuid`,
  )) as unknown as Array<{ against: number }>;
  const against = againstRows[0]?.against ?? 0;

  const suspended = u.suspendedUntil && u.suspendedUntil > new Date();

  return {
    content: null,
    embeds: [
      {
        title: `${u.displayName ?? u.username} (@${u.username})`,
        description: suspended
          ? `SUSPENDED until ${u.suspendedUntil!.toISOString().slice(0, 10)} — ${u.suspensionReason ?? 'no reason recorded'}`
          : null,
        color: suspended ? RED : VIOLET,
        fields: [
          { name: 'User ID', value: u.id, inline: false },
          { name: 'Email', value: u.email ?? 'none', inline: true },
          { name: 'Joined', value: u.createdAt.toISOString().slice(0, 10), inline: true },
          { name: 'Reports against', value: String(against), inline: true },
          ...(u.isBot ? [{ name: 'Kind', value: 'bot', inline: true }] : []),
          ...(u.isStaff ? [{ name: 'Staff', value: 'yes', inline: true }] : []),
        ],
      },
    ],
  };
}

/** A press on a report card in #reports. */
async function handleModReportButton(
  app: FastifyInstance,
  input: { actorId: string; customId: string },
): Promise<InteractionResponse> {
  const [, action, reportId] = input.customId.split(':');
  if (!reportId || !['resolve', 'dismiss', 'suspend'].includes(action ?? '')) {
    return { kind: 'ack' };
  }

  // Defence in depth: pressButton already refused non-staff via `staffOnly`,
  // but this handler must hold on its own — routing logic changes, invariants
  // should not have to.
  if (!(await isStaffUser(app, input.actorId))) return { kind: 'ack' };

  const result = await applyReportAction(app, {
    reportId,
    actorId: input.actorId,
    action: action as 'resolve' | 'dismiss' | 'suspend',
    suspendDays: 7,
    skipCardRewrite: true,
  });

  if (!result.ok) {
    // Raced another staff member (or the portal). Their write already retired
    // the card; do nothing rather than overwrite their outcome with ours.
    return { kind: 'ack' };
  }

  const actor = await userLabel(app, input.actorId);
  return {
    kind: 'update',
    content: null,
    embeds: [
      {
        title: action === 'suspend' ? 'Suspended' : action === 'dismiss' ? 'Dismissed' : 'Resolved',
        description: `${result.message} — ${actor}`,
        color: action === 'suspend' ? RED : action === 'dismiss' ? '#726c8c' : GREEN,
        fields: [{ name: 'Reference', value: reportId.slice(0, 8), inline: true }],
      },
    ],
    components: [],
  };
}

export { disableAll };
