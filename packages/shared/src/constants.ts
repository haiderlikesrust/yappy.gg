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
  /** A campfire is within the warning window. `value` is the ISO end time. */
  'campfire_ending',
  /**
   * Somebody screenshotted this conversation.
   *
   * Reported by the client, because the operating system is the only thing
   * that knows — which makes this a social signal and not a security control,
   * and it should never be described as one. A modified client will not
   * report, iOS and Android below 14 see different things, and a second phone
   * pointed at the screen sees everything and says nothing.
   */
  'screenshot_taken',
] as const;
export type SystemEvent = (typeof SYSTEM_EVENTS)[number];

export const PRESENCE_STATUSES = ['online', 'idle', 'dnd', 'offline'] as const;
export type PresenceStatus = (typeof PRESENCE_STATUSES)[number];

export const NOTIFICATION_LEVELS = ['all', 'mentions', 'none'] as const;
export type NotificationLevel = (typeof NOTIFICATION_LEVELS)[number];

/**
 * `notifications.sound` set to this means deliver the push without playing
 * anything. The banner still shows.
 *
 * A sentinel rather than `null`, because null already means "nothing set" and
 * is coalesced to the default sound in two separate places. Anything that does
 * not recognise this value falls back to the default sound, which is the safe
 * direction to fail: a notification that makes a noise someone did not expect
 * is a nuisance, one that stays silent when they wanted it is a missed message.
 */
export const SILENT_SOUND = 'none';

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
 * Campfire durations, in seconds — how long a temporary place lives.
 *
 * Capped at a week on purpose. The point of a campfire is that everyone can
 * hold the end date in their head; a month-long one is just a group that
 * deletes itself by surprise.
 */
/**
 * How long a live location may run, in seconds.
 *
 * Capped at eight hours, and deliberately short of a day. The failure mode of
 * this feature is not a leak, it is forgetting: somebody shares their position
 * with a group to meet a friend and never thinks about it again. Every option
 * here is one a person can hold in their head as "until roughly when".
 */
export const LIVE_LOCATION_DURATIONS = [900, 3_600, 28_800] as const;
export const LIVE_LOCATION_MAX_SECONDS = 28_800;

export const CAMPFIRE_DURATIONS = [3_600, 21_600, 43_200, 86_400, 259_200, 604_800] as const;
export const CAMPFIRE_MAX_SECONDS = 604_800;
/** How long before the end the group is told. One hour, or a tenth of a short one. */
export const CAMPFIRE_WARNING_SECONDS = 3_600;

/**
 * How much backlog a member who joins *from now on* can read.
 *
 * Applied only when the membership row is created, so changing it is never
 * retroactive in either direction.
 */
export const HISTORY_VISIBILITY = ['since_join', 'full'] as const;
export type HistoryVisibility = (typeof HISTORY_VISIBILITY)[number];

/**
 * The `history_start_seq` to stamp on a membership row being created now.
 *
 * One function rather than the ternary inlined at each join site, because
 * there are three of them (invite, public join, added by a member) and a
 * fourth that disagreed with the others would be a silent privacy bug.
 */
export function historyFloor(visibility: string, messageSeq: number): number {
  return visibility === 'full' ? 0 : messageSeq;
}

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
  /**
   * "Re-broadcast this message as it now stands."
   *
   * Consumed by the **API**, for the same reason as `yapper.dm`: publishing a
   * `message.update` means serialising a fully hydrated message, and hydration
   * lives in `MessageService`. The worker can finish a link preview but it
   * cannot describe the result in the shape a client expects — and a partial
   * payload on that event is worse than none, because both clients *replace*
   * the message they hold with whatever arrives.
   */
  'message.rehydrate',
  /**
   * One staff announcement, fanned out to every eligible account.
   *
   * Consumed by the **worker**, unlike its two siblings above: this job pages
   * the user table and enqueues a `yapper.dm` per person, which is exactly the
   * "decide who" work the worker owns. The API still does the saying.
   */
  'yapper.broadcast',
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
