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
  newId,
  type EmbedInput,
  type InteractionResponse,
  type MessageComponentRow,
} from '@yappy/shared';
import type { FastifyInstance } from 'fastify';
import { disableAll } from './interactions.js';
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
  },
): Promise<void> {
  const expiresAt = new Date(Date.now() + PROMPT_TTL_SECONDS * 1000);
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
): Promise<{ state: string; data: Record<string, unknown> } | null> {
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
  return { state: row.state, data: row.data ?? {} };
}

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

/** Human wording for a privacy audience, used in both the card and buttons. */
const AUDIENCE_LABEL: Record<string, string> = {
  everyone: 'Anyone',
  contacts: 'People you follow',
  nobody: 'Nobody',
};

const privacyCard = (privacy: Partial<PrivacySettings>, userId: string): YapperReply => {
  const dm = String(privacy.whoCanDm ?? 'everyone');
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
        // where "which setting am I changing?" gets answered.
        footer: { text: 'The buttons below set who can DM you. It applies everywhere.' },
      },
    ],
    // Only the DM setting is offered as a button: it is the one people
    // actually want to change in a hurry, and a card with eight toggles is a
    // settings screen pretending to be a message.
    components: [
      {
        type: 'row',
        components: [
          {
            type: 'button',
            customId: 'privacy:dm:everyone',
            label: 'Anyone',
            style: dm === 'everyone' ? 'primary' : 'secondary',
            disabled: dm === 'everyone',
            onlyUserId: userId,
          },
          {
            type: 'button',
            customId: 'privacy:dm:contacts',
            label: 'People I follow',
            style: dm === 'contacts' ? 'primary' : 'secondary',
            disabled: dm === 'contacts',
            onlyUserId: userId,
          },
        ],
      },
    ],
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
        { name: 'Reason', value: String(data.reason ?? '—').slice(0, 1_024), inline: true },
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
          return await claimCode(app, botId, input, text);

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

        case 'report:reason': {
          await setPrompt(app, {
            botId,
            userId: input.senderId,
            conversationId: input.conversationId,
            state: 'report:proof',
            data: { ...pending.data, reason: text.slice(0, 1_000) },
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

        // 'report:confirm' and 'report:review' are answered by a button, not
        // by typing. Say so rather than silently swallowing the message.
        case 'report:confirm':
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
): Promise<YapperReply> {
  const claim = await claimGrant(app.db, input.senderId, code);

  if (!claim.ok) {
    await noteBadAttempt(app.db, input.senderId);
    // The question stays open on a wrong code — a typo should not mean
    // starting over.
    await setPrompt(app, {
      botId,
      userId: input.senderId,
      conversationId: input.conversationId,
      state: 'awaiting_code',
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

  if (input.customId.startsWith('privacy:dm:')) {
    return await setDmAudience(app, input.actorId, input.customId.split(':')[2] ?? '');
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
 * Change who may DM the presser, then re-render the card so the new state is
 * visible rather than merely claimed.
 *
 * Writes only the one key, merged over whatever else is in `privacy`: replacing
 * the object would silently reset every setting the person has chosen.
 */
async function setDmAudience(
  app: FastifyInstance,
  userId: string,
  audience: string,
): Promise<InteractionResponse> {
  if (!PRIVACY_AUDIENCES.includes(audience as (typeof PRIVACY_AUDIENCES)[number])) {
    return { kind: 'ack' };
  }

  const [updated] = await app.db
    .update(users)
    .set({ privacy: raw`coalesce(${users.privacy}, '{}'::jsonb) || ${JSON.stringify({ whoCanDm: audience })}::jsonb` as never })
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
      state: 'report:reason',
      data: pending.data,
    });
    const card = askCard(
      'What is it about?',
      `Tell me what @${String(pending.data.targetUsername ?? 'they')} did. One or two sentences is plenty.`,
    );
    return { kind: 'update', content: card.content, embeds: card.embeds, components: [] };
  }

  if (input.customId === 'report:submit') {
    const targetId = String(pending.data.targetId ?? '');
    if (!targetId) return { kind: 'ack' };

    const [row] = await app.db
      .insert(reports)
      .values({
        id: newId(),
        reporterId: input.actorId,
        targetType: 'user',
        targetId,
        reason: String(pending.data.reason ?? 'Not given').slice(0, 1_000),
        detail: pending.data.proof ? String(pending.data.proof).slice(0, 1_000) : null,
        // Frozen at submit time. The username can change, and a queue entry
        // that no longer names anyone recognisable is hard to action.
        evidence: {
          source: 'yapper',
          targetUsername: pending.data.targetUsername ?? null,
          proof: pending.data.proof ?? null,
        },
      })
      .returning({ id: reports.id });

    await clearPrompt(app, botId, input.actorId);

    // Surface it in the staff #reports channel. Not awaited: the card is the
    // team's notification, and the reporter should not wait on it.
    void userLabel(app, input.actorId)
      .then((reporterLabel) =>
        postReportCard(app, {
          reportId: row?.id ?? '',
          reason: String(pending.data.reason ?? 'other'),
          detail: pending.data.proof ? String(pending.data.proof) : null,
          targetLabel: `@${String(pending.data.targetUsername ?? 'unknown')}`,
          reporterLabel,
          priority: 0,
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
  const [reportsId, generalId] = await Promise.all([
    getSystemConversationId(app, 'staff_reports'),
    getSystemConversationId(app, 'staff_general'),
  ]);
  return conversationId === reportsId || conversationId === generalId;
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
