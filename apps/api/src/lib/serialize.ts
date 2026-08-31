import type {
  Call,
  Conversation,
  ConversationMember,
  GroupPet,
  Media,
  Message,
  Sticker,
  StickerPack,
  User,
} from '@yappy/db';
import { users } from '@yappy/db';
import { has, Permission, serializePermissions } from '@yappy/shared';
import { env } from '../env.js';
import type { InviteCard } from './invitecards.js';

/**
 * Wire shapes.
 *
 * Two rules enforced here rather than at each call site:
 *   1. No database row is ever spread into a response. Adding a column must
 *      never accidentally publish it — `passwordHash` and `phoneHash` live one
 *      typo away from the user object.
 *   2. Timestamps are ISO 8601 strings with an offset. Millisecond epochs are
 *      smaller but every client then re-implements timezone handling.
 */

/**
 * A public-bucket object's address.
 *
 * Takes a key and assumes the public bucket, which is true for every caller —
 * avatars, banners, stickers and emoji all live there by `Storage.bucketFor`.
 * It is worth being explicit that the assumption is load-bearing: hand this a
 * key from the private bucket and it returns a URL that resolves to a 404,
 * cheerfully, with no way for the caller to notice. The dedupe in
 * `POST /media/uploads` is what keeps a private object from ever reaching a
 * public purpose in the first place.
 */
export const mediaUrl = (key: string): string => `${env.S3_PUBLIC_BASE_URL}/${key}`;

/**
 * Where a client should fetch this object.
 *
 * Avatars, banners and stickers live in the public bucket and are served
 * straight from it. Message attachments do not: whether you may see them
 * depends on conversation membership, which a bucket cannot evaluate. Those go
 * through an authorised route on this API, which is also the seam where a
 * signed-CDN URL would replace the proxy in production.
 */
export const objectUrl = (bucket: string, key: string, mediaId: string): string =>
  bucket === env.S3_BUCKET_PUBLIC
    ? mediaUrl(key)
    : `${env.PUBLIC_API_URL}/v1/media/${mediaId}/content`;

/**
 * The group a person is displaying as their affiliation. Flattened rather than
 * nesting a whole conversation: this rides along on every message sender, so it
 * pays to keep it to the four fields a client can actually render.
 */
export interface Affiliation {
  id: string;
  title: string | null;
  avatarUrl: string | null;
  badge: string | null;
}

/** What the affiliation join produces before URLs are built. */
export interface AffiliationRow {
  id: string | null;
  title?: string | null;
  avatarKey?: string | null;
  badge?: string | null;
}

export function toAffiliation(row?: AffiliationRow | null): Affiliation | null {
  // A group that lost its own badge stops conferring one. Checked here rather
  // than at each call site so no query can forget it.
  if (!row?.id || !row.badge) return null;
  return {
    id: row.id,
    title: row.title ?? null,
    avatarUrl: row.avatarKey ? mediaUrl(row.avatarKey) : null,
    badge: row.badge,
  };
}

export interface PublicUser {
  id: string;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  isBot: boolean;
  isVerified: boolean;
  /** The most significant one, for clients that show a single mark. */
  badge: string | null;
  /** Everything they hold. See BADGE_KINDS. */
  badges: string[];
  /** Null unless the caller's query joined it — most list endpoints do not. */
  affiliation: Affiliation | null;
}

/**
 * Where the viewer and this account stand with each other.
 *
 * A property of the *pair*, not of the user, but it rides on the user payload
 * for the same reason `presence` does: the profile screen needs it at the same
 * moment, and a second round trip to render one button is a button that
 * flickers.
 *
 * `canAddToGroups` is the server's real answer rather than something the client
 * infers from `isMutual`. The rule it reflects is the target's
 * `whoCanAddToGroups` audience, which defaults to contacts but may be anything
 * — so a client deriving "mutual therefore addable" would be confidently wrong
 * for everyone who changed the setting, in both directions.
 */
export interface Relationship {
  /** The viewer follows this account. */
  following: boolean;
  /** This account follows the viewer. */
  followedBy: boolean;
  /** Both directions. This is what the privacy settings call a contact. */
  isMutual: boolean;
  /** Whether the viewer may add this account to a group right now. */
  canAddToGroups: boolean;
}

export interface FullUser extends PublicUser {
  bio: string | null;
  pronouns: string | null;
  bannerUrl: string | null;
  /** Profile flair — the gradient the header wears when there is no banner. */
  flair: { gradient?: string[] } | null;
  presence: {
    status: string;
    customStatus: string | null;
    lastSeenAt: string | null;
  };
  /** Absent when the user is looking at themselves. */
  relationship?: Relationship;
  /**
   * Rooms the viewer shares with this account — the social proof a
   * group-first app actually has, instead of follower counts. Absent on your
   * own profile, where the answer is "all of them".
   */
  mutualGroups?: { count: number; preview: Array<{ id: string; title: string | null; emoji: string | null }> };
  createdAt: string;
}

type UserRow = Partial<User> & { id: string };

/**
 * Exactly the columns `toPublicUser` reads.
 *
 * `UserRow` is `Partial<User>`, which is what makes a narrowed select
 * convenient — and what makes forgetting a column silent. A select that omits
 * one still compiles and still returns a `PublicUser`, with that field at its
 * default rather than its value.
 *
 * That is not hypothetical: `badges` was added to the schema and to this
 * function, and the nine hand-written column lists feeding it were not
 * updated. Multi-badge worked on the profile screen, which selects the whole
 * row, and nowhere else — every name in a chat list, member list, follower
 * list, search result and message came back with an empty array.
 *
 * Spread it rather than listing columns by hand:
 *
 *   .select({ ...publicUserColumns, avatarKey: media.objectKey })
 */
export const publicUserColumns = {
  id: users.id,
  username: users.username,
  displayName: users.displayName,
  isBot: users.isBot,
  isVerified: users.isVerified,
  badge: users.badge,
  badges: users.badges,
} as const;

export function toPublicUser(
  u: UserRow,
  avatarKey?: string | null,
  affiliation?: AffiliationRow | null,
): PublicUser {
  return {
    id: u.id,
    username: u.username ?? null,
    displayName: u.displayName ?? null,
    avatarUrl: avatarKey ? mediaUrl(avatarKey) : null,
    isBot: u.isBot ?? false,
    isVerified: u.isVerified ?? false,
    badge: u.badge ?? null,
    badges: (u.badges as string[] | null) ?? [],
    affiliation: toAffiliation(affiliation),
  };
}

export interface PresenceVisibility {
  /** False when the viewer fails the owner's `whoCanSeeLastSeen` audience. */
  canSeeLastSeen: boolean;
}

export function toFullUser(
  u: User,
  opts: {
    avatarKey?: string | null;
    bannerKey?: string | null;
    affiliation?: AffiliationRow | null;
    relationship?: Relationship;
    mutualGroups?: FullUser['mutualGroups'];
  } & PresenceVisibility,
): FullUser {
  return {
    ...toPublicUser(u, opts.avatarKey, opts.affiliation),
    bio: u.bio,
    pronouns: u.pronouns,
    bannerUrl: opts.bannerKey ? mediaUrl(opts.bannerKey) : null,
    flair: u.flair ?? null,
    ...(opts.relationship ? { relationship: opts.relationship } : {}),
    ...(opts.mutualGroups ? { mutualGroups: opts.mutualGroups } : {}),
    presence: {
      // Hiding last-seen but leaking "online" defeats the setting entirely, so
      // the whole presence block collapses together — including the custom
      // status, which used to escape the gate. "At the gym until 6" is a
      // stronger disclosure than the green dot it was sitting next to.
      status: opts.canSeeLastSeen ? u.presenceStatus : 'offline',
      customStatus: opts.canSeeLastSeen ? u.customStatus : null,
      lastSeenAt: opts.canSeeLastSeen ? (u.lastSeenAt?.toISOString() ?? null) : null,
    },
    createdAt: u.createdAt.toISOString(),
  };
}

/** The private view of your own account — includes everything settings-related. */
export function toSelf(
  u: User,
  avatarKey?: string | null,
  bannerKey?: string | null,
  affiliation?: AffiliationRow | null,
) {
  return {
    ...toFullUser(u, { avatarKey, bannerKey, affiliation, canSeeLastSeen: true }),
    phone: u.phone,
    phoneVerified: Boolean(u.phoneVerifiedAt),
    email: u.email,
    emailVerified: Boolean(u.emailVerifiedAt),
    birthday: u.birthday,
    privacy: u.privacy,
    notifications: u.notifications,
    appearance: u.appearance,
    locale: u.locale,
    suspendedUntil: u.suspendedUntil?.toISOString() ?? null,
  };
}

export function toMedia(m: Media) {
  return {
    id: m.id,
    url: objectUrl(m.bucket, m.objectKey, m.id),
    thumbnailUrl: m.thumbnailKey
      ? m.bucket === env.S3_BUCKET_PUBLIC
        ? mediaUrl(m.thumbnailKey)
        : `${env.PUBLIC_API_URL}/v1/media/${m.id}/content?variant=thumb`
      : null,
    mimeType: m.mimeType,
    size: m.size,
    width: m.width,
    height: m.height,
    durationMs: m.durationMs,
    blurhash: m.blurhash,
    waveform: m.waveform,
    filename: m.filename,
    status: m.status,
    variants: m.variants,
  };
}

export interface MessageExtras {
  /** This device's copy of an encrypted body. */
  ciphertext?: string | null;
  attachments?: Array<{ media: Media; caption: string | null; isSpoiler: boolean; position: number }>;
  sender?: UserRow | null;
  senderAvatarKey?: string | null;
  senderAffiliation?: AffiliationRow | null;
  /**
   * The sender's name colour in *this* conversation. Roles are per-conversation
   * so this cannot live on the user object — the same person is "Maintainer
   * green" in one group and unstyled in another.
   */
  senderRoleColor?: string | null;
  senderRoleName?: string | null;
  /** Emoji this viewer has reacted with — drives the highlighted state. */
  myReactions?: string[];
  /**
   * Display names for the people a system line is about, keyed by id.
   *
   * "Alex added Sam" is stored as ids, and clients resolved them against the
   * member roster they had loaded. That produced two visible failures: the
   * roster arrives after the timeline does, so every system line flashed
   * "Someone added someone" for as long as the members request took; and
   * somebody who has since left the group is not in the roster at all, so
   * their line said "someone" permanently.
   *
   * Resolved here instead, where the ids came from. Costs nothing on a page
   * with no system messages.
   */
  systemNames?: Record<string, string> | null;
  /**
   * Names and colours for the roles this message mentions.
   *
   * The entity carries a role id, because a role can be renamed and a
   * mention frozen as `@Premium` would keep saying that after the role
   * became `@Supporter`. Resolving it here is the same trade as
   * `systemNames`: a client would otherwise need the space's whole role
   * list loaded before it could draw a message, and the phones do not load
   * one at all.
   */
  mentionedRoles?: Record<string, { name: string; color: string | null }> | null;
  /** Titles for #channel signposts, resolved only for channels this reader
   *  can see — an unresolved id renders as the text it was typed as. */
  mentionedChannels?: Record<string, { title: string }> | null;
  /**
   * Pictures for the group's own emoji named in `entities`, keyed by id.
   *
   * Resolved against this conversation and its space, so a message
   * forwarded in from elsewhere keeps its ids and resolves to nothing —
   * and renders as the `:name:` still sitting in the text rather than
   * borrowing a picture from a group the reader was never in.
   */
  customEmojis?: Record<string, { name: string; url: string; animated: boolean }> | null;
  /**
   * Forward attribution with a name attached. The hydrators build this; the
   * bare-id fallback in `toMessage` exists only for callers that never see
   * forwarded rows.
   */
  forwardedFrom?: { userId: string; username: string | null; displayName: string | null } | null;
  /**
   * The sticker itself, resolved from `stickerId` by the hydrators. A bare id
   * was all the payload used to carry, which made a sticker renderable only by
   * clients that happened to have its pack installed — everyone else drew an
   * invisible square.
   */
  sticker?: { id: string; emoji: string; name: string | null; url: string } | null;
  replyTo?: { id: string; seq: number; senderId: string | null; preview: string | null; type: string } | null;
  poll?: {
    id: string;
    question: string;
    multiSelect: boolean;
    isAnonymous: boolean;
    closesAt: string | null;
    closedAt: string | null;
    totalVoters: number;
    options: Array<{ id: string; label: string; position: number; voteCount: number }>;
    myVotes: string[];
  } | null;
  isPinned?: boolean;
  /** Unfurled links, merged into the same `embeds` array as bot-authored ones. */
  linkPreviews?: Array<{
    url: string;
    title: string | null;
    description: string | null;
    siteName: string | null;
    imageKey?: string | null;
    /** Set when the URL is a yappy invite. See lib/invitecards.ts. */
    invite?: InviteCard | null;
  }>;
}

export function toMessage(m: Message, extras: MessageExtras = {}) {
  const deleted = Boolean(m.deletedAt);
  return {
    id: m.id,
    conversationId: m.conversationId,
    seq: m.seq,
    type: m.type,
    // A deleted message keeps its slot in the sequence — clients need the
    // tombstone to render "this message was deleted" without a gap.
    content: deleted ? null : m.content,
    /**
     * Encrypted messages carry a fixed notice in `content` and their real
     * body in `ciphertext` — the one addressed to the asking device, or null
     * when this device was not a recipient (it joined later, or the sender
     * had no session for it). A client that finds null says so rather than
     * showing an empty bubble.
     */
    isEncrypted: m.isEncrypted,
    ciphertext: deleted ? null : (extras.ciphertext ?? null),
    entities: deleted ? null : m.entities,
    sender: extras.sender
      ? toPublicUser(extras.sender, extras.senderAvatarKey, extras.senderAffiliation)
      : null,
    senderId: m.senderId,
    senderRoleColor: extras.senderRoleColor ?? null,
    senderRoleName: extras.senderRoleName ?? null,
    replyTo: extras.replyTo ?? null,
    threadRootId: m.threadRootId,
    threadReplyCount: m.threadReplyCount,
    threadLastReplyAt: m.threadLastReplyAt?.toISOString() ?? null,
    title: m.title,
    forwardedFrom:
      extras.forwardedFrom ?? (m.forwardedFromUserId ? { userId: m.forwardedFromUserId } : null),
    attachments: deleted
      ? []
      : (extras.attachments ?? []).map((a) => ({
          ...toMedia(a.media),
          caption: a.caption,
          isSpoiler: a.isSpoiler,
          position: a.position,
        })),
    stickerId: m.stickerId,
    sticker: deleted ? null : (extras.sticker ?? null),
    gif: deleted ? null : m.gif,
    location: deleted ? null : m.location,
    contact: deleted ? null : m.contact,
    poll: extras.poll ?? null,
    /**
     * One array, two origins. `rich` cards come from a bot; `link` cards are
     * what the worker made of a URL someone pasted. Clients render both the
     * same way, and the `type` is there so a client can style provenance if it
     * wants to — not so it can hide one of them.
     */
    embeds: deleted
      ? []
      : [
          ...(((m.embeds as Record<string, unknown>[] | null) ?? []).map((e) => ({ type: 'rich', ...e }))),
          ...(extras.linkPreviews ?? []).map((p) => ({
            type: 'link' as const,
            url: p.url,
            title: p.title,
            description: p.description,
            provider: p.siteName,
            image: p.imageKey ? { url: mediaUrl(p.imageKey) } : null,
            /**
             * Purely additive, and null on every link that is not one of ours.
             *
             * The `type` stays `link` rather than becoming `invite` for the
             * same reason: a client that has not been taught this field — every
             * build in the wild, including the one in App Review — keeps
             * matching on `link` and keeps drawing the card it draws today,
             * from the title and description that are still right there. A new
             * type would have fallen through their switch and rendered nothing.
             */
            invite: p.invite ?? null,
          })),
        ],
    /** Interactive rows. Dropped on delete along with everything else a
     *  tombstone must not keep offering. */
    components: deleted ? [] : ((m.components as unknown[] | null) ?? []),
    callSummary: m.callSummary,
    system: m.system,
    /** Names for the ids inside `system`. Null on everything else. */
    systemNames: extras.systemNames ?? null,
    /** Names for the role ids inside `entities`. Null when none are named. */
    mentionedRoles: extras.mentionedRoles ?? null,
    mentionedChannels: extras.mentionedChannels ?? null,
    /** Pictures for the emoji ids inside `entities`. Null when none are named. */
    customEmojis: extras.customEmojis ?? null,
    reactions: deleted ? {} : m.reactionCounts,
    myReactions: extras.myReactions ?? [],
    isPinned: extras.isPinned ?? false,
    silent: m.silent,
    editedAt: m.editedAt?.toISOString() ?? null,
    expiresAt: m.expiresAt?.toISOString() ?? null,
    deletedAt: m.deletedAt?.toISOString() ?? null,
    createdAt: m.createdAt.toISOString(),
    nonce: m.nonce,
  };
}

export interface ConversationAppearance {
  accent?: string | null;
  gradient?: [string, string] | null;
  effect?: string;
  emoji?: string | null;
}

export interface ConversationExtras {
  member?: ConversationMember;
  permissions?: bigint;
  avatarKey?: string | null;
  /** For DMs the client renders the other person, not a group title. */
  otherUser?: PublicUser | null;
  unreadCount?: number;
  lastMessage?: ReturnType<typeof toMessage> | null;
  activeCall?: { id: string; mode: string; participantCount: number } | null;
  memberPreview?: PublicUser[];
  /** Members online right now — the list's pulse. Groups only. */
  hereCount?: number;
  /** Overrides the row's own count — a channel reports its space's. */
  memberCount?: number;
  /** The space's name, so a channel header can say where it lives. */
  parentTitle?: string | null;
  /** The group's pet row, when the list query joined it. */
  pet?: GroupPet | null;
}

/**
 * The pet as the wire sees it. Stage is a threshold over fed days; mood is
 * derived from the conversation's own last activity, so it decays hour by
 * hour without a sweeper ever touching the row. Both computed here so every
 * surface tells the same story about the same creature.
 */
export function toPet(pet: GroupPet, lastMessageAt: Date | null) {
  const fedDays = pet.fedDays;
  const stage =
    fedDays >= 60 ? 'elder' : fedDays >= 25 ? 'grown' : fedDays >= 10 ? 'kid' : fedDays >= 3 ? 'baby' : 'egg';

  let mood: 'happy' | 'hungry' | 'sad' | 'gone';
  if (pet.wanderedAt) {
    mood = 'gone';
  } else {
    const hours = lastMessageAt ? (Date.now() - lastMessageAt.getTime()) / 3_600_000 : Infinity;
    mood = hours < 24 ? 'happy' : hours < 72 ? 'hungry' : 'sad';
  }

  return {
    name: pet.name,
    stage,
    mood,
    streak: pet.streak,
    fedDays,
    bornAt: pet.bornAt.toISOString(),
  };
}

export function toConversation(c: Conversation, extras: ConversationExtras = {}) {
  const m = extras.member;
  return {
    id: c.id,
    type: c.type,
    /** Set on a channel: the space it lives in. Null for everything else. */
    parentId: c.parentId,
    parentTitle: extras.parentTitle ?? null,
    position: c.position,
    /**
     * A channel that reads as a page of cards rather than a conversation.
     *
     * On the conversation itself rather than only in the space listing: a
     * client can arrive at a channel by deep link, notification, or search
     * without ever having loaded the space, and it has to know how to draw the
     * thing before it can draw it.
     */
    isBoard: c.isBoard,
    isForum: c.isForum,
    title: c.title,
    description: c.description,
    avatarUrl: extras.avatarKey ? mediaUrl(extras.avatarKey) : null,
    handle: c.handle,
    isPublic: c.isPublic,
    badge: c.badge ?? null,
    appearance:
      ((c.settings ?? {}) as { appearance?: ConversationAppearance }).appearance ?? null,
    ownerId: c.ownerId,
    memberCount: extras.memberCount ?? c.memberCount,
    hereCount: extras.hereCount ?? 0,
    memberPreview: extras.memberPreview ?? [],
    otherUser: extras.otherUser ?? null,

    latestSeq: c.messageSeq,
    lastMessageAt: c.lastMessageAt?.toISOString() ?? null,
    lastMessage: extras.lastMessage ?? null,

    disappearingSeconds: c.disappearingSeconds,
    slowModeSeconds: c.slowModeSeconds,
    historyVisibility: c.historyVisibility,
    /**
     * Non-null makes this a campfire — the whole place is deleted at this
     * instant. Sent as an absolute time rather than a remaining duration so a
     * client with a slow load or a paused app never renders a countdown that
     * has quietly drifted.
     */
    endsAt: c.endsAt?.toISOString() ?? null,
    /** The group's pet. Additive — old clients render the group they always did. */
    pet: extras.pet ? toPet(extras.pet, c.lastMessageAt) : null,
    /**
     * The conversation-wide floor, distinct from `permissions` below — that one
     * is what *you* may do here, which for an admin is everything regardless of
     * how low the floor is set. A settings screen asking "can everyone post?"
     * has to read this one.
     */
    basePermissions: c.basePermissions !== null ? String(c.basePermissions) : null,
    permissions: extras.permissions !== undefined ? serializePermissions(extras.permissions) : null,
    /**
     * Whether this viewer may post here.
     *
     * The same question every client was about to answer for itself by
     * decoding the bitfield above — three times, in three languages, each one
     * a chance to disagree with the code that actually enforces it. Absent
     * permissions means the caller did not ask for a viewer-specific view, and
     * true is the honest default: the conversations a client can see are ones
     * it can write in, apart from the handful marked otherwise.
     */
    canPost:
      extras.permissions !== undefined ? has(extras.permissions, Permission.SEND_MESSAGES) : true,

    activeCall: extras.activeCall ?? null,

    // Per-viewer state. Never leaks to other members.
    self: m
      ? {
          role: m.role,
          /** This group has affiliated you — you may choose to display it. */
          isAffiliate: m.isAffiliate,
          lastReadSeq: m.lastReadSeq,
          unreadCount: extras.unreadCount ?? Math.max(0, c.messageSeq - m.lastReadSeq),
          mentionCount: m.mentionCount,
          // Null means inherit; the wire keeps the concrete value clients
          // render, resolved by the caller where a space is in play.
          notificationLevel: m.notificationLevel ?? 'all',
          mutedUntil: m.mutedUntil?.toISOString() ?? null,
          isPinned: m.isPinned,
          isArchived: m.isArchived,
          isHidden: m.isHidden,
          nickname: m.nickname,
          draft: m.draft,
          joinedAt: m.joinedAt.toISOString(),
          historyStartSeq: m.historyStartSeq,
        }
      : null,

    createdAt: c.createdAt.toISOString(),
  };
}

/** A named role as a member list renders it — no permission bits needed there. */
export interface MemberRoleBadge {
  id: string;
  name: string;
  color: string | null;
  position: number;
  isHoisted: boolean;
}

export function toMember(
  m: ConversationMember,
  user: UserRow,
  avatarKey?: string | null,
  affiliation?: AffiliationRow | null,
  roles: MemberRoleBadge[] = [],
) {
  return {
    user: toPublicUser(user, avatarKey, affiliation),
    role: m.role,
    /** Highest-positioned first, so `roles[0]` is the one to show in a tight row. */
    roles,
    /** The colour a name takes: the top role that actually specifies one. */
    roleColor: roles.find((r) => r.color)?.color ?? null,
    /** This group's half of the affiliation — visible to the member list so
     *  admins can see who they have affiliated, whether or not that person
     *  chose to display it. */
    isAffiliate: m.isAffiliate,
    nickname: m.nickname,
    mutedUntil: m.mutedUntil?.toISOString() ?? null,
    joinedAt: m.joinedAt.toISOString(),
    lastReadSeq: m.lastReadSeq,
  };
}

export function toCall(
  c: Call,
  participants: Array<{ user: PublicUser; state: string; isMuted: boolean; isVideoEnabled: boolean; isScreenSharing: boolean }>,
) {
  return {
    id: c.id,
    conversationId: c.conversationId,
    initiatorId: c.initiatorId,
    mode: c.mode,
    state: c.state,
    roomName: c.roomName,
    maxParticipants: c.maxParticipants,
    ringExpiresAt: c.ringExpiresAt?.toISOString() ?? null,
    startedAt: c.startedAt?.toISOString() ?? null,
    endedAt: c.endedAt?.toISOString() ?? null,
    endReason: c.endReason,
    durationSeconds: c.durationSeconds,
    participants,
    createdAt: c.createdAt.toISOString(),
  };
}

export function toStickerPack(
  p: StickerPack,
  stickers: Array<Sticker & { mediaKey: string }>,
  coverKey?: string | null,
  isInstalled = false,
) {
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    description: p.description,
    coverUrl: coverKey ? mediaUrl(coverKey) : null,
    isAnimated: p.isAnimated,
    isOfficial: p.isOfficial,
    isPublic: p.isPublic,
    installCount: p.installCount,
    stickerCount: p.stickerCount,
    isInstalled,
    stickers: stickers.map((s) => ({
      id: s.id,
      emoji: s.emoji,
      name: s.name,
      position: s.position,
      url: mediaUrl(s.mediaKey),
    })),
  };
}
