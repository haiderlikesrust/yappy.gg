import { z } from 'zod';
import {
  CONVERSATION_TYPES,
  DISAPPEARING_PRESETS,
  LIMITS,
  MEMBER_ROLES,
  NOTIFICATION_LEVELS,
  PLATFORMS,
  PRESENCE_STATUSES,
  PRIVACY_AUDIENCES,
  RESERVED_USERNAMES,
} from './constants.js';

/** Every REST request body/query is validated by one of these. */

export const uuid = z.string().uuid();
export const isoDate = z.string().datetime({ offset: true });

export const username = z
  .string()
  .trim()
  .min(LIMITS.usernameMin)
  .max(LIMITS.usernameMax)
  .regex(/^[a-z0-9](?:[a-z0-9_.]*[a-z0-9])?$/i, 'Letters, numbers, dot and underscore only')
  .refine((v) => !v.includes('..') && !v.includes('__'), 'No repeated separators')
  .refine((v) => !RESERVED_USERNAMES.has(v.toLowerCase()), 'That username is reserved');

export const e164 = z.string().regex(/^\+[1-9]\d{6,14}$/, 'Must be an E.164 phone number');

/**
 * Emoji used as a reaction. Deliberately permissive on codepoints (new Unicode
 * releases ship faster than we redeploy) but bounded in length so nobody
 * reacts with a 400-character ZWJ bomb.
 */
export const reactionEmoji = z.string().min(1).max(64);

export const cursorPagination = z.object({
  limit: z.coerce.number().int().min(1).max(LIMITS.pageSizeMax).default(LIMITS.pageSizeDefault),
  /** Opaque cursor from a previous page. */
  cursor: z.string().max(256).optional(),
});

/** Message history paginates on `seq`, not on a cursor blob — it is stable and
 *  lets the client ask for an exact window around a jumped-to message. */
export const messageHistoryQuery = z.object({
  limit: z.coerce.number().int().min(1).max(LIMITS.pageSizeMax).default(LIMITS.pageSizeDefault),
  before: z.coerce.number().int().positive().optional(),
  after: z.coerce.number().int().nonnegative().optional(),
  /** Centre the window on a message — used by "jump to message" and search results. */
  around: z.coerce.number().int().positive().optional(),
  includeDeleted: z.coerce.boolean().default(false),
});

// ─── Auth ────────────────────────────────────────────────────────────────────

export const clientInfo = z.object({
  platform: z.enum(PLATFORMS),
  version: z.string().max(32),
  os: z.string().max(64).optional(),
  device: z.string().max(64).optional(),
  /** Set at login so the very first push lands without a second round trip. */
  pushToken: z.string().max(512).optional(),
});

export const requestOtpBody = z
  .object({
    phone: e164.optional(),
    email: z.string().email().max(254).toLowerCase().optional(),
    purpose: z.enum(['login', 'verify_phone', 'verify_email', 'delete_account']).default('login'),
  })
  .refine((v) => Boolean(v.phone) !== Boolean(v.email), 'Provide exactly one of phone or email');

export const verifyOtpBody = z
  .object({
    phone: e164.optional(),
    email: z.string().email().max(254).toLowerCase().optional(),
    code: z.string().regex(/^\d{6}$/),
    client: clientInfo,
  })
  .refine((v) => Boolean(v.phone) !== Boolean(v.email), 'Provide exactly one of phone or email');

export const oauthBody = z.object({
  provider: z.enum(['apple', 'google']),
  /** Identity token from the native SDK — verified server-side against the JWKS. */
  idToken: z.string().min(16),
  /** Apple only returns the name on the very first authorisation. */
  fullName: z.string().max(LIMITS.displayNameMax).optional(),
  client: clientInfo,
});

export const refreshBody = z.object({ refreshToken: z.string().min(16) });

export const completeProfileBody = z.object({
  username,
  displayName: z.string().trim().min(1).max(LIMITS.displayNameMax),
  avatarMediaId: uuid.nullish(),
});

// ─── Users ───────────────────────────────────────────────────────────────────

export const updateMeBody = z.object({
  displayName: z.string().trim().min(1).max(LIMITS.displayNameMax).optional(),
  username: username.optional(),
  bio: z.string().max(LIMITS.bioMax).nullish(),
  avatarMediaId: uuid.nullish(),
  bannerMediaId: uuid.nullish(),
  pronouns: z.string().max(32).nullish(),
  birthday: z.string().date().nullish(),
  /**
   * The group whose logo shows beside your name. Null clears it. The server
   * still checks that the group affiliated you — this only expresses consent,
   * it does not grant anything.
   */
  affiliationConversationId: uuid.nullish(),
});

export const updateSettingsBody = z.object({
  privacy: z
    .object({
      whoCanDm: z.enum(PRIVACY_AUDIENCES).optional(),
      whoCanAddToGroups: z.enum(PRIVACY_AUDIENCES).optional(),
      whoCanSeeLastSeen: z.enum(PRIVACY_AUDIENCES).optional(),
      whoCanSeeAvatar: z.enum(PRIVACY_AUDIENCES).optional(),
      whoCanCall: z.enum(PRIVACY_AUDIENCES).optional(),
      readReceipts: z.boolean().optional(),
      typingIndicators: z.boolean().optional(),
      discoverableByPhone: z.boolean().optional(),
      discoverableByUsername: z.boolean().optional(),
    })
    .optional(),
  notifications: z
    .object({
      dm: z.enum(NOTIFICATION_LEVELS).optional(),
      groups: z.enum(NOTIFICATION_LEVELS).optional(),
      calls: z.boolean().optional(),
      reactions: z.boolean().optional(),
      /** Hide message text on the lock screen. */
      showPreview: z.boolean().optional(),
      sound: z.string().max(64).nullish(),
      quietHours: z
        .object({
          enabled: z.boolean(),
          start: z.string().regex(/^\d{2}:\d{2}$/),
          end: z.string().regex(/^\d{2}:\d{2}$/),
          timezone: z.string().max(64),
        })
        .nullish(),
    })
    .optional(),
  appearance: z
    .object({
      theme: z.enum(['system', 'light', 'dark']).optional(),
      accent: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
      fontScale: z.number().min(0.8).max(1.6).optional(),
      reduceMotion: z.boolean().optional(),
    })
    .optional(),
  locale: z.string().max(16).optional(),
});

export const presenceBody = z.object({
  status: z.enum(PRESENCE_STATUSES),
  customStatus: z.string().max(128).nullish(),
  expiresAt: isoDate.nullish(),
});

// ─── Social graph ────────────────────────────────────────────────────────────

export const contactSyncBody = z.object({
  /** SHA-256 of the E.164 number, salted server-side — raw numbers never land
   *  in a log. See docs/ARCHITECTURE.md §Privacy. */
  phoneHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(5_000),
});

export const searchUsersQuery = z.object({
  q: z.string().trim().min(1).max(64),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

// ─── Conversations ───────────────────────────────────────────────────────────

export const createConversationBody = z
  .object({
    type: z.enum(CONVERSATION_TYPES),
    /** For a DM: exactly one other user. For a group: the initial roster. */
    memberIds: z.array(uuid).max(LIMITS.groupMembersMax).default([]),
    title: z.string().trim().max(LIMITS.conversationTitleMax).nullish(),
    description: z.string().max(LIMITS.conversationDescriptionMax).nullish(),
    avatarMediaId: uuid.nullish(),
    disappearingSeconds: z.union([z.literal(0), z.number().int().positive()]).default(0),
  })
  .superRefine((v, ctx) => {
    if (v.type === 'dm' && v.memberIds.length !== 1) {
      ctx.addIssue({ code: 'custom', message: 'A DM needs exactly one other member', path: ['memberIds'] });
    }
    if (v.type !== 'dm' && !v.title) {
      ctx.addIssue({ code: 'custom', message: 'Group and channel need a title', path: ['title'] });
    }
  });

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Expected #RRGGBB');

/**
 * Group flair. Validated server-side because it is rendered on *other people's*
 * screens — the conversation list — so a malformed value must not be able to
 * break every member's home screen.
 */
export const conversationAppearance = z.object({
  accent: hexColor.nullish(),
  /** Two stops, rendered as a linear gradient ring/title on clients. */
  gradient: z.tuple([hexColor, hexColor]).nullish(),
  effect: z.enum(['none', 'glow', 'shimmer']).default('none'),
  /** Short flair emoji shown beside the title. */
  emoji: z.string().max(16).nullish(),
});

export const updateConversationBody = z.object({
  title: z.string().trim().min(1).max(LIMITS.conversationTitleMax).optional(),
  description: z.string().max(LIMITS.conversationDescriptionMax).nullish(),
  avatarMediaId: uuid.nullish(),
  /** Null clears all flair. */
  appearance: conversationAppearance.nullable().optional(),
  disappearingSeconds: z
    .number()
    .int()
    .refine((v) => (DISAPPEARING_PRESETS as readonly number[]).includes(v), 'Unsupported duration')
    .optional(),
  slowModeSeconds: z.number().int().min(0).max(21_600).optional(),
  /** Bitfield as a decimal string — see permissions.ts. */
  basePermissions: z.string().regex(/^\d+$/).optional(),
  isPublic: z.boolean().optional(),
});

/** Per-user, per-conversation state. Never broadcast to other members. */
export const conversationStateBody = z.object({
  notificationLevel: z.enum(NOTIFICATION_LEVELS).optional(),
  mutedUntil: isoDate.nullish(),
  isPinned: z.boolean().optional(),
  isArchived: z.boolean().optional(),
  nickname: z.string().max(LIMITS.displayNameMax).nullish(),
  draft: z.string().max(LIMITS.messageLength).nullish(),
});

export const addMembersBody = z.object({ userIds: z.array(uuid).min(1).max(200) });

export const updateMemberBody = z.object({
  role: z.enum(MEMBER_ROLES).optional(),
  allow: z.string().regex(/^\d+$/).optional(),
  deny: z.string().regex(/^\d+$/).optional(),
  mutedUntil: isoDate.nullish(),
  /** Only meaningful on a badged group; see BADGE_KINDS. */
  isAffiliate: z.boolean().optional(),
});

// ─── Spaces & channels ───────────────────────────────────────────────────────

export const createChannelBody = z.object({
  title: z.string().trim().min(1).max(LIMITS.conversationTitleMax),
  description: z.string().max(LIMITS.conversationDescriptionMax).nullish(),
  position: z.number().int().min(0).max(10_000).default(0),
  /**
   * Read-only for ordinary members — an #announcements channel. Expressed as a
   * lowered base rather than a separate channel kind, so the permission model
   * stays the only thing that decides who can speak.
   */
  isAnnouncement: z.boolean().default(false),
});

/** The complete ordered list, not a delta — see the route for why. */
export const reorderChannelsBody = z.object({
  channelIds: z.array(uuid).min(1).max(LIMITS.channelsPerSpace),
});

export const upgradeToSpaceBody = z.object({
  /** What the group's existing history becomes. */
  firstChannelTitle: z.string().trim().min(1).max(LIMITS.conversationTitleMax).default('general'),
});

// ─── Named roles ─────────────────────────────────────────────────────────────

/**
 * Permissions arrive as a decimal string, the same way they are serialised
 * out. A client that sends a number loses precision above 2^53 and would
 * silently drop ADMINISTRATOR, which lives at bit 62.
 */
const permissionBits = z.string().regex(/^\d+$/, 'Expected a decimal permission bitfield');

export const createRoleBody = z.object({
  name: z.string().trim().min(1).max(LIMITS.roleNameMax),
  color: hexColor.nullish(),
  permissions: permissionBits.default('0'),
  position: z.number().int().min(0).max(1_000).default(0),
  isHoisted: z.boolean().default(false),
  isMentionable: z.boolean().default(false),
});

export const updateRoleBody = z.object({
  name: z.string().trim().min(1).max(LIMITS.roleNameMax).optional(),
  color: hexColor.nullish(),
  permissions: permissionBits.optional(),
  position: z.number().int().min(0).max(1_000).optional(),
  isHoisted: z.boolean().optional(),
  isMentionable: z.boolean().optional(),
});

/** Full replacement, not a delta — makes the UI's "save" idempotent. */
export const setMemberRolesBody = z.object({
  roleIds: z.array(uuid).max(LIMITS.rolesPerMember),
});

export const createInviteBody = z.object({
  maxUses: z.number().int().min(0).max(10_000).default(0),
  expiresInSeconds: z.number().int().min(60).max(2_592_000).nullish(),
});

// ─── Messages ────────────────────────────────────────────────────────────────

// ─── Embeds ──────────────────────────────────────────────────────────────────

/**
 * Rich embeds, Discord-shaped.
 *
 * Two kinds end up in the same array on the wire: `link` embeds the worker
 * builds by unfurling a pasted URL, and `rich` embeds a bot posts deliberately.
 * Clients render them identically, which is the point — a bot's card should not
 * look like a second-class citizen next to a YouTube preview.
 */
const embedUrl = z.string().url().max(2_048);

export const embedField = z.object({
  name: z.string().trim().min(1).max(256),
  value: z.string().trim().min(1).max(1_024),
  /** Lay two or three side by side instead of stacking. */
  inline: z.boolean().default(false),
});

export const embedInput = z
  .object({
    title: z.string().max(256).nullish(),
    description: z.string().max(4_096).nullish(),
    url: embedUrl.nullish(),
    /** Accent bar down the left edge. */
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Expected #RRGGBB').nullish(),
    author: z
      .object({
        name: z.string().trim().min(1).max(256),
        url: embedUrl.nullish(),
        iconUrl: embedUrl.nullish(),
      })
      .nullish(),
    fields: z.array(embedField).max(25).default([]),
    image: z.object({ url: embedUrl }).nullish(),
    thumbnail: z.object({ url: embedUrl }).nullish(),
    footer: z
      .object({ text: z.string().trim().min(1).max(2_048), iconUrl: embedUrl.nullish() })
      .nullish(),
    timestamp: isoDate.nullish(),
  })
  .superRefine((v, ctx) => {
    // Per-field caps still allow a 30 KB embed built from 25 maxed-out fields.
    // One total budget is what actually bounds the payload.
    const total =
      (v.title?.length ?? 0) +
      (v.description?.length ?? 0) +
      (v.author?.name.length ?? 0) +
      (v.footer?.text.length ?? 0) +
      v.fields.reduce((sum, f) => sum + f.name.length + f.value.length, 0);
    if (total > LIMITS.embedTotalChars) {
      ctx.addIssue({ code: 'custom', message: `Embed exceeds ${LIMITS.embedTotalChars} characters` });
    }
    const hasContent =
      v.title || v.description || v.author || v.image || v.thumbnail || v.footer || v.fields.length > 0;
    if (!hasContent) ctx.addIssue({ code: 'custom', message: 'Embed is empty' });
  });

export type EmbedInput = z.infer<typeof embedInput>;

// ─── Interactive components ──────────────────────────────────────────────────

/**
 * Buttons attached to a bot's message.
 *
 * The alternative — "reply /login yes" — asks someone to retype a command they
 * have to read carefully, and gets typos and stale replies to old prompts. A
 * button carries its own identity, so a press is unambiguous about *which*
 * prompt it answers.
 *
 * Shaped like Discord's rows because the constraint behind that shape is real:
 * a phone is narrow, and five buttons is already more than fits comfortably.
 *
 * `customId` is opaque to us and echoed back to the bot on press. It is not a
 * capability — pressing is authorised by conversation membership and by
 * `onlyUserId`, never by knowing the id.
 */
export const messageButton = z.object({
  type: z.literal('button'),
  /** Echoed back to the bot. Bots encode their own routing in it. */
  customId: z.string().min(1).max(100),
  label: z.string().trim().min(1).max(80),
  style: z.enum(['primary', 'secondary', 'success', 'danger']).default('secondary'),
  /** Rendered greyed and refused server-side. Used to retire a spent prompt. */
  disabled: z.boolean().default(false),
  /**
   * Restricts the press to one person. Set on anything consequential posted
   * where others can see it: without it, any member of the conversation could
   * answer a prompt addressed to someone else.
   */
  onlyUserId: uuid.nullish(),
});

export const messageComponentRow = z.object({
  type: z.literal('row'),
  components: z.array(messageButton).min(1).max(5),
});

export const messageComponents = z.array(messageComponentRow).max(5);

export type MessageButton = z.infer<typeof messageButton>;
export type MessageComponentRow = z.infer<typeof messageComponentRow>;

/** What a bot sends back when one of its buttons is pressed. */
export const interactionResponse = z.object({
  /**
   * `update` rewrites the message the button is on — the right default for a
   * prompt, which should stop looking pressable once it has been answered.
   * `reply` posts a new message. `ack` does neither.
   */
  kind: z.enum(['update', 'reply', 'ack']).default('ack'),
  content: z.string().max(LIMITS.messageLength).nullish(),
  embeds: z.array(embedInput).max(10).optional(),
  components: messageComponents.optional(),
});

export type InteractionResponse = z.infer<typeof interactionResponse>;

export const messageEntity = z.discriminatedUnion('type', [
  z.object({ type: z.literal('mention'), offset: z.number().int().min(0), length: z.number().int().positive(), userId: uuid }),
  z.object({ type: z.literal('mention_all'), offset: z.number().int().min(0), length: z.number().int().positive() }),
  z.object({ type: z.literal('link'), offset: z.number().int().min(0), length: z.number().int().positive(), url: z.string().url().max(2_048) }),
  z.object({ type: z.literal('bold'), offset: z.number().int().min(0), length: z.number().int().positive() }),
  z.object({ type: z.literal('italic'), offset: z.number().int().min(0), length: z.number().int().positive() }),
  z.object({ type: z.literal('strike'), offset: z.number().int().min(0), length: z.number().int().positive() }),
  z.object({ type: z.literal('spoiler'), offset: z.number().int().min(0), length: z.number().int().positive() }),
  z.object({ type: z.literal('code'), offset: z.number().int().min(0), length: z.number().int().positive() }),
  z.object({ type: z.literal('pre'), offset: z.number().int().min(0), length: z.number().int().positive(), language: z.string().max(32).nullish() }),
]);

export const sendMessageBody = z
  .object({
    /**
     * Client-generated idempotency key. The client renders the message
     * optimistically under this id, and a retry after a flaky send returns the
     * original message instead of duplicating it.
     */
    nonce: z.string().min(8).max(64),
    type: z
      .enum(['text', 'image', 'video', 'audio', 'file', 'sticker', 'gif', 'location', 'contact', 'poll'])
      .default('text'),
    content: z.string().max(LIMITS.messageLength).nullish(),
    entities: z.array(messageEntity).max(200).optional(),
    attachmentIds: z.array(uuid).max(LIMITS.attachmentsPerMessage).optional(),
    replyToId: uuid.nullish(),
    /** Set to start or continue a thread. */
    threadRootId: uuid.nullish(),
    stickerId: uuid.nullish(),
    /** Bots and webhooks only — see the check in MessageService.send. */
    embeds: z.array(embedInput).max(10).optional(),
    /** Bots only, same reasoning as embeds. */
    components: messageComponents.optional(),
    gif: z
      .object({
        provider: z.enum(['tenor', 'giphy']),
        id: z.string().max(128),
        url: z.string().url().max(2_048),
        previewUrl: z.string().url().max(2_048),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        title: z.string().max(256).optional(),
      })
      .nullish(),
    location: z
      .object({
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        name: z.string().max(256).nullish(),
        /** Non-null turns this into a live location that expires. */
        liveUntil: isoDate.nullish(),
      })
      .nullish(),
    contact: z
      .object({ name: z.string().max(128), phone: e164.nullish(), userId: uuid.nullish() })
      .nullish(),
    poll: z
      .object({
        question: z.string().trim().min(1).max(512),
        options: z.array(z.string().trim().min(1).max(128)).min(2).max(LIMITS.pollOptions),
        multiSelect: z.boolean().default(false),
        anonymous: z.boolean().default(false),
        closesAt: isoDate.nullish(),
      })
      .nullish(),
    /** Overrides the conversation default for this one message. */
    expiresInSeconds: z.number().int().positive().max(31_536_000).nullish(),
    silent: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    const hasBody =
      (v.content && v.content.trim().length > 0) ||
      (v.attachmentIds?.length ?? 0) > 0 ||
      v.stickerId ||
      v.gif ||
      v.location ||
      v.contact ||
      v.poll ||
      // A bot posting a card and nothing else is a complete message.
      (v.embeds?.length ?? 0) > 0;
    if (!hasBody) ctx.addIssue({ code: 'custom', message: 'Message is empty', path: ['content'] });
    if (v.type === 'sticker' && !v.stickerId)
      ctx.addIssue({ code: 'custom', message: 'stickerId required', path: ['stickerId'] });
    if (v.type === 'gif' && !v.gif) ctx.addIssue({ code: 'custom', message: 'gif required', path: ['gif'] });
    if (v.type === 'poll' && !v.poll) ctx.addIssue({ code: 'custom', message: 'poll required', path: ['poll'] });
  });

export const editMessageBody = z.object({
  content: z.string().max(LIMITS.messageLength).nullish(),
  entities: z.array(messageEntity).max(200).optional(),
  attachmentIds: z.array(uuid).max(LIMITS.attachmentsPerMessage).optional(),
});

export const deleteMessageQuery = z.object({
  /** false = remove for me only; true = remove for everyone (needs permission). */
  forEveryone: z.coerce.boolean().default(true),
});

export const forwardMessagesBody = z.object({
  messageIds: z.array(uuid).min(1).max(30),
  toConversationIds: z.array(uuid).min(1).max(20),
  /** Strip attribution — "forwarded from" is hidden. */
  hideSender: z.boolean().default(false),
  comment: z.string().max(LIMITS.captionLength).nullish(),
});

export const reactionBody = z.object({
  emoji: reactionEmoji.optional(),
  /** Custom/sticker reactions. Exactly one of emoji or stickerId. */
  stickerId: uuid.optional(),
}).refine((v) => Boolean(v.emoji) !== Boolean(v.stickerId), 'Provide exactly one of emoji or stickerId');

export const pollVoteBody = z.object({ optionIds: z.array(uuid).min(0).max(LIMITS.pollOptions) });

export const readAckBody = z.object({ seq: z.coerce.number().int().nonnegative() });

// ─── Media ───────────────────────────────────────────────────────────────────

export const createUploadBody = z.object({
  filename: z.string().max(255),
  mimeType: z.string().max(128),
  size: z.number().int().positive().max(LIMITS.pageSizeMax * 100_000_000),
  purpose: z.enum(['attachment', 'avatar', 'conversation_avatar', 'sticker', 'banner', 'voice']),
  width: z.number().int().positive().nullish(),
  height: z.number().int().positive().nullish(),
  durationMs: z.number().int().positive().nullish(),
  /** Precomputed on-device so the placeholder renders before the bytes land. */
  blurhash: z.string().max(64).nullish(),
  /** Normalised 0-100 amplitude buckets for voice-note waveforms. */
  waveform: z.array(z.number().int().min(0).max(100)).max(256).nullish(),
  /** SHA-256 of the file — enables server-side dedupe of the same GIF sent 400 times. */
  checksum: z.string().regex(/^[a-f0-9]{64}$/).nullish(),
});

// ─── Bots ────────────────────────────────────────────────────────────────────

export const createBotBody = z.object({
  name: z.string().trim().min(1).max(LIMITS.displayNameMax),
  /** The bot's @handle. Shares the human namespace — one directory, no
   *  impersonating an existing account with a lookalike bot. */
  username,
  description: z.string().max(LIMITS.bioMax).nullish(),
  isPublic: z.boolean().default(false),
});

export const updateBotBody = z.object({
  name: z.string().trim().min(1).max(LIMITS.displayNameMax).optional(),
  description: z.string().max(LIMITS.bioMax).nullish(),
  isPublic: z.boolean().optional(),
});

// ─── Stickers & GIFs ─────────────────────────────────────────────────────────

export const gifSearchQuery = z.object({
  q: z.string().trim().max(128).default(''),
  limit: z.coerce.number().int().min(1).max(50).default(30),
  pos: z.string().max(64).optional(),
  locale: z.string().max(16).default('en_US'),
  contentFilter: z.enum(['off', 'low', 'medium', 'high']).default('medium'),
});

export const createStickerPackBody = z.object({
  name: z.string().trim().min(1).max(64),
  slug: z.string().regex(/^[a-z0-9-]{3,48}$/),
  coverMediaId: uuid.nullish(),
  isAnimated: z.boolean().default(false),
});

export const addStickerBody = z.object({
  mediaId: uuid,
  emoji: z.string().min(1).max(16),
  name: z.string().max(64).nullish(),
});

// ─── Calls ───────────────────────────────────────────────────────────────────

export const startCallBody = z.object({
  conversationId: uuid.nullish(),
  /** Ad-hoc call without a conversation (e.g. from a profile). */
  inviteUserIds: z.array(uuid).max(64).default([]),
  mode: z.enum(['audio', 'video']).default('audio'),
  nonce: z.string().min(8).max(64),
});

export const joinCallBody = z.object({
  /** Publish intent — the SFU token is scoped to this. */
  publishAudio: z.boolean().default(true),
  publishVideo: z.boolean().default(false),
  deviceId: uuid.optional(),
});

export const callActionBody = z.object({
  reason: z.enum(['declined', 'busy', 'hangup', 'timeout', 'ended_by_host']).default('hangup'),
});

// ─── Devices & push ──────────────────────────────────────────────────────────

export const registerPushBody = z.object({
  platform: z.enum(PLATFORMS),
  token: z.string().min(8).max(512),
  /** iOS needs a separate token for CallKit/VoIP pushes. */
  voipToken: z.string().max(512).nullish(),
  /** Android: FCM sender-scoped; iOS: bundle id. */
  environment: z.enum(['production', 'sandbox']).default('production'),
});

// ─── Search & moderation ─────────────────────────────────────────────────────

export const searchMessagesQuery = z.object({
  q: z.string().trim().min(1).max(256),
  conversationId: uuid.optional(),
  fromUserId: uuid.optional(),
  hasAttachment: z.coerce.boolean().optional(),
  type: z.enum(['image', 'video', 'audio', 'file', 'gif', 'sticker', 'poll']).optional(),
  before: isoDate.optional(),
  after: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
  cursor: z.string().max(256).optional(),
});

export const reportBody = z.object({
  targetType: z.enum(['user', 'message', 'conversation', 'sticker_pack']),
  targetId: uuid,
  reason: z.enum(['spam', 'harassment', 'csam', 'violence', 'self_harm', 'illegal', 'impersonation', 'other']),
  detail: z.string().max(2_000).nullish(),
  /** Extra context the moderator sees. */
  messageIds: z.array(uuid).max(20).optional(),
});

export const blockBody = z.object({ userId: uuid });

// ─── E2EE key distribution ───────────────────────────────────────────────────
// The transport for keys, not the crypto itself — see docs/ARCHITECTURE.md.

export const publishKeysBody = z.object({
  deviceId: uuid,
  identityKey: z.string().max(256),
  signedPreKey: z.object({ id: z.number().int(), key: z.string().max(256), signature: z.string().max(512) }),
  oneTimePreKeys: z.array(z.object({ id: z.number().int(), key: z.string().max(256) })).max(200),
});

export const claimKeysBody = z.object({ userIds: z.array(uuid).min(1).max(64) });
