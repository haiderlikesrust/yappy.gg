/**
 * `space` is a container, not a chat: it holds channels and owns the
 * membership and roles they inherit. It never carries messages of its own —
 * upgrading a group moves that group's history into its first channel, so
 * "does this row have a timeline?" has one answer per type rather than
 * depending on how the row came to exist.
 */
export const CONVERSATION_TYPES = ['dm', 'group', 'channel', 'space'] as const;
export type ConversationType = (typeof CONVERSATION_TYPES)[number];

export const MEMBER_ROLES = ['owner', 'admin', 'moderator', 'member', 'restricted'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export const MESSAGE_TYPES = [
  'text',
  'image',
  'video',
  'audio', // voice note
  'file',
  'sticker',
  'gif',
  'location',
  'contact',
  'poll',
  'call', // call started / ended / missed summary card
  'system', // "X added Y", "X changed the group name", …
] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

export const SYSTEM_EVENTS = [
  'member_joined',
  'member_left',
  'member_added',
  'member_removed',
  'member_promoted',
  'member_demoted',
  'title_changed',
  'avatar_changed',
  'description_changed',
  'message_pinned',
  'conversation_created',
  'disappearing_changed',
  /** This group became a space; the history you are reading moved here. */
  'upgraded_to_space',
  'channel_created',
] as const;
export type SystemEvent = (typeof SYSTEM_EVENTS)[number];

export const PRESENCE_STATUSES = ['online', 'idle', 'dnd', 'offline'] as const;
export type PresenceStatus = (typeof PRESENCE_STATUSES)[number];

export const NOTIFICATION_LEVELS = ['all', 'mentions', 'none'] as const;
export type NotificationLevel = (typeof NOTIFICATION_LEVELS)[number];

export const CALL_STATES = ['ringing', 'active', 'ended'] as const;
export type CallState = (typeof CALL_STATES)[number];

export const CALL_PARTICIPANT_STATES = [
  'invited',
  'ringing',
  'joined',
  'left',
  'declined',
  'missed',
  'busy',
] as const;
export type CallParticipantState = (typeof CALL_PARTICIPANT_STATES)[number];

export const PLATFORMS = ['ios', 'android', 'web', 'desktop'] as const;
export type Platform = (typeof PLATFORMS)[number];

/** Who is allowed to start a DM with you / see your last-seen. */
export const PRIVACY_AUDIENCES = ['everyone', 'contacts', 'nobody'] as const;
export type PrivacyAudience = (typeof PRIVACY_AUDIENCES)[number];

/**
 * Identity marks, for both people and groups.
 *
 * Deliberately three, and deliberately not purchasable. A badge is a claim the
 * platform makes about who someone is, so the moment it can be bought it stops
 * carrying information — the failure mode is well documented elsewhere.
 *
 *   verified — this is who they say they are
 *   partner  — an official yappy partner programme member
 *   staff    — works on yappy
 *
 * Granting is an operator action (see scripts/grant-badge.mjs). There is no
 * self-service endpoint on purpose.
 */
export const BADGE_KINDS = ['verified', 'partner', 'staff'] as const;
export type BadgeKind = (typeof BADGE_KINDS)[number];

// ─── Limits ──────────────────────────────────────────────────────────────────
// Kept in shared so the mobile client enforces the same numbers locally and
// never round-trips a request the server is going to reject.

export const LIMITS = {
  messageLength: 8_000,
  /** Total characters across every text field of one embed, Discord-style.
   *  Per-field caps alone would still allow a 30 KB card. */
  embedTotalChars: 6_000,
  captionLength: 1_024,
  usernameMin: 3,
  usernameMax: 32,
  displayNameMax: 64,
  bioMax: 280,
  conversationTitleMax: 128,
  conversationDescriptionMax: 1_024,
  groupMembersMax: 5_000,
  roleNameMax: 40,
  /** Per conversation. Enough for any real hierarchy, low enough that the
   *  member-list role join stays a small in-memory group-by. */
  rolesPerConversation: 50,
  rolesPerMember: 20,
  /** Channels in one space. */
  channelsPerSpace: 100,
  attachmentsPerMessage: 10,
  pinnedPerConversation: 50,
  reactionsPerMessage: 50, // distinct emoji, not total
  pollOptions: 12,
  editWindowSeconds: 48 * 60 * 60,
  typingTtlSeconds: 8,
  presenceTtlSeconds: 60,
  pageSizeDefault: 50,
  pageSizeMax: 100,
  bulkFetchMax: 100,
  stickersPerPack: 120,
  installedPacksMax: 200,
} as const;

/** Disappearing-message presets, in seconds. `0` disables. */
export const DISAPPEARING_PRESETS = [0, 3_600, 86_400, 604_800, 2_592_000, 7_776_000] as const;

/**
 * Background queues.
 *
 * Listed here rather than inline at each `send`/`work` call because pg-boss v10
 * requires a queue to exist before either side touches it — and the API
 * (producer) and worker (consumer) start independently, in either order. Both
 * create the full set on boot, which is idempotent.
 */
export const QUEUES = [
  'push.fanout',
  'push.call',
  'push.reaction',
  'media.process',
  'media.quarantine',
  'link.preview',
  'bot.event',
  'bot.webhook_test',
  'call.ring_timeout',
  'account.purge',
  'moderation.triage',
  'message.scheduled_send',
  /**
   * Something yapper says without being spoken to first.
   *
   * Consumed by the **API**, not the worker, which is the exception to the
   * usual split: posting a message means allocating a `seq`, publishing the
   * realtime event and enqueuing push fan-out, and all of that lives in the
   * API's MessageService. The worker decides *when* something is worth saying
   * and enqueues it; the API decides how to say it and says it.
   */
  'yapper.dm',
  'yapper.staff',
  'cron.push_drain',
  'cron.sweep_fast',
  'cron.sweep_slow',
  'cron.hourly',
  'cron.daily',
] as const;

export type QueueName = (typeof QUEUES)[number];

// ─── Reports ─────────────────────────────────────────────────────────────────

/**
 * Why something was reported.
 *
 * One list, used by the REST report body, by yapper's guided flow and by the
 * staff card's labels. It lives here rather than inline in the zod schema
 * because a *category* is what triage sorts on: the priority function below
 * and the classifier hook both switch on these values, and a second list that
 * drifted from this one would mean a report filed one way jumps the queue
 * while the identical report filed another way does not.
 */
export const REPORT_REASONS = [
  'spam',
  'harassment',
  'csam',
  'violence',
  'self_harm',
  'illegal',
  'impersonation',
  'other',
] as const;

export type ReportReason = (typeof REPORT_REASONS)[number];

/** Human wording, for the reporter's buttons and the moderator's card. */
export const REPORT_REASON_LABEL: Record<ReportReason, string> = {
  spam: 'Spam',
  harassment: 'Harassment',
  csam: 'CSAM',
  violence: 'Violence',
  self_harm: 'Self-harm',
  illegal: 'Illegal',
  impersonation: 'Impersonation',
  other: 'Other',
};

/**
 * Where a report lands in the queue, from its category alone.
 *
 * CSAM and credible self-harm jump it unconditionally; everything else is
 * ordered by age. Deliberately a pure function of the reason so that every
 * surface which can file a report — the REST endpoint, yapper, and whatever
 * comes next — produces the same number for the same category without having
 * to remember to.
 */
export function reportPriority(reason: string): number {
  if (reason === 'csam') return 100;
  if (reason === 'self_harm') return 80;
  return 0;
}

/** Reserved usernames that cannot be claimed. */
export const RESERVED_USERNAMES = new Set([
  'admin',
  'administrator',
  'support',
  'help',
  'yappy',
  'system',
  'root',
  'api',
  'me',
  'settings',
  'about',
  'legal',
  'privacy',
  'terms',
  'security',
  'billing',
  'moderator',
  'mod',
  'staff',
  'official',
  'everyone',
  'here',
  'null',
  'undefined',
]);
