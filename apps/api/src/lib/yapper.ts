import {
  and,
  applications,
  botPrompts,
  conversationMembers,
  conversations,
  desc,
  eq,
  inArray,
  isNull,
  sql as raw,
  reports,
  users,
  type PrivacySettings,
} from '@yappy/db';
import { applyReportAction, getSystemConversationId, postReportCard, userLabel } from './staffspace.js';
import {
  PRIVACY_AUDIENCES,
  REPORT_REASONS,
  REPORT_REASON_LABEL,
  newId,
  reportPriority,
  type EmbedInput,
  type InteractionResponse,
  type MessageButton,
  type MessageComponentRow,
  type ReportReason,
} from '@yappy/shared';
import type { FastifyInstance } from 'fastify';
import { disableAll } from './interactions.js';
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
  { name: 'privacy', description: 'See and change who can reach you', usage: '/privacy' },
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
  const ttl = input.state.startsWith('report:') ? REPORT_PROMPT_TTL_SECONDS : PROMPT_TTL_SECONDS;
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

const helpCard = (): YapperReply => ({
  content: null,
  embeds: [
    {
      title: 'yapper',
      description: 'I sign you in to the developer portal. Start with /login.',
      color: VIOLET,
      // Staff commands stay out of the public help. Staff know where to look,
      // and a list of hidden commands is an invitation to probe them.
      fields: YAPPER_COMMANDS.filter((c) => !c.staffOnly).map((c) => ({
        name: c.usage,
        value: c.description,
        inline: false,
      })),
    },
  ],
});

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
  input: { conversationId: string; senderId: string; content: string | null },
): Promise<YapperReply | null> {
  const text = input.content?.trim();
  if (!text) return null;

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

        // These are answered by a button, not by typing. Say so rather than
        // silently swallowing the message.
        case 'report:confirm':
        case 'report:category':
        case 'report:review':
          return { content: 'Use the buttons above, or /cancel.' };
      }
    }

    if (!text.startsWith('/')) return null;

    const [command, ...rest] = text.split(/\s+/);

    switch (command?.toLowerCase()) {
      case '/help':
      case '/start':
        return helpCard();

      case '/cancel': {
        if (!pending) return { content: 'Nothing to cancel.' };
        await clearPrompt(app, botId, input.senderId);
        return { content: 'Cancelled.' };
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

  if (input.customId.startsWith('webhook:test:')) {
    const card = await requestWebhookTest(app, input.actorId, input.customId.split(':')[2] ?? '');
    return { kind: 'update', content: card.content, embeds: card.embeds, components: card.components };
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
