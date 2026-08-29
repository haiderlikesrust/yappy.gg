package gg.yappy.app.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/**
 * Wire models.
 *
 * Every field the server may omit is nullable with a default, and the Json
 * parser runs with `ignoreUnknownKeys`. Between them, a server that adds a
 * field cannot crash an older build — which matters a great deal when the old
 * build is sitting on someone's phone and cannot be recalled.
 */

/**
 * The group a person displays as their affiliation — its logo sits beside their
 * name. `badge` is the *group's* badge, not the person's: an affiliation is only
 * as good as the organisation behind it, so the client can render a partner's
 * affiliate differently from a merely verified one.
 */
@Serializable
data class Affiliation(
    val id: String,
    val title: String? = null,
    val avatarUrl: String? = null,
    val badge: String? = null,
)

@Serializable
data class PublicUser(
    val id: String,
    val username: String? = null,
    val displayName: String? = null,
    val avatarUrl: String? = null,
    val isBot: Boolean = false,
    val isVerified: Boolean = false,
    /** The most significant one — what a single-mark surface shows. */
    val badge: String? = null,
    /**
     * Everything they hold. Empty from a server that predates the field, which
     * is why [badge] stays: the marks fall back to it rather than vanishing.
     */
    val badges: List<String> = emptyList(),
    /** Null on most list endpoints — only the surfaces that join it populate it. */
    val affiliation: Affiliation? = null,
    /**
     * Whether you may put this person in a group, answered by the server.
     *
     * Only user search and your contacts populate it — the two lists the member
     * picker reads. Null elsewhere, and null means "not asked", not "no": a row
     * from another endpoint must not render as blocked just because it was never
     * told.
     */
    val canAddToGroups: Boolean? = null,
) {
    val label: String get() = displayName ?: username?.let { "@$it" } ?: "Someone"
}

/**
 * Where you and someone else stand. Absent on your own profile.
 *
 * `canAddToGroups` is the server's answer, not something derived from
 * `isMutual` here: it reflects the other person's `whoCanAddToGroups` audience,
 * which defaults to contacts but can be set to anyone or to nobody. Deriving it
 * on the client would put a promise in the UI that the add endpoint then breaks.
 */
@Serializable
data class Relationship(
    val following: Boolean = false,
    val followedBy: Boolean = false,
    val isMutual: Boolean = false,
    val canAddToGroups: Boolean = false,
)

/** What POST/DELETE /social/follow/:id answers with. */
@Serializable
data class FollowResult(
    val following: Boolean = false,
    val isMutual: Boolean = false,
)

@Serializable
data class Presence(
    val status: String = "offline",
    val customStatus: String? = null,
    val lastSeenAt: String? = null,
)

@Serializable
data class FullUser(
    val id: String,
    val username: String? = null,
    val displayName: String? = null,
    val avatarUrl: String? = null,
    val bannerUrl: String? = null,
    val bio: String? = null,
    val pronouns: String? = null,
    val isBot: Boolean = false,
    val isVerified: Boolean = false,
    val badge: String? = null,
    val badges: List<String> = emptyList(),
    val affiliation: Affiliation? = null,
    val presence: Presence = Presence(),
    val phone: String? = null,
    val email: String? = null,
    val privacy: JsonObject? = null,
    val notifications: JsonObject? = null,
    val appearance: Appearance? = null,
    /** Null on your own profile, and on payloads that predate the field. */
    val relationship: Relationship? = null,
    /** Profile flair — the gradient the header wears when there is no banner. */
    val flair: UserFlair? = null,
    /** Rooms you share with this account. Absent on your own profile. */
    val mutualGroups: MutualGroups? = null,
    val createdAt: String? = null,
)

@Serializable
data class UserFlair(val gradient: List<String>? = null)

@Serializable
data class MutualGroups(
    val count: Int = 0,
    val preview: List<MutualGroupRef> = emptyList(),
)

@Serializable
data class MutualGroupRef(
    val id: String,
    val title: String? = null,
    val emoji: String? = null,
)

@Serializable
data class Appearance(
    val theme: String = "system",
    val accent: String = "#6C5CE7",
    val fontScale: Float = 1f,
    val reduceMotion: Boolean = false,
)

@Serializable
data class SelfState(
    val role: String = "member",
    /** This group has affiliated you; whether you show it is your call. */
    val isAffiliate: Boolean = false,
    val lastReadSeq: Long = 0,
    val unreadCount: Int = 0,
    val mentionCount: Int = 0,
    val notificationLevel: String = "all",
    val mutedUntil: String? = null,
    val isPinned: Boolean = false,
    val isArchived: Boolean = false,
    val nickname: String? = null,
    val draft: String? = null,
    val joinedAt: String? = null,
    val historyStartSeq: Long = 0,
)

@Serializable
data class LastMessageStub(
    val id: String? = null,
    val seq: Long = 0,
    val type: String = "text",
    val senderId: String? = null,
    val preview: String? = null,
    val createdAt: String? = null,
)

@Serializable
data class ActiveCall(
    val id: String,
    val mode: String = "audio",
    val participantCount: Int = 0,
)

/**
 * Group flair, set by owners/admins. Rendered wherever the group appears — most
 * importantly the conversation list, which is what makes a customised group
 * feel like *its own place* rather than a row in someone else's app.
 */
@Serializable
data class ConversationAppearance(
    val accent: String? = null,
    /** Two hex stops for a linear gradient ring/tint. */
    val gradient: List<String>? = null,
    val effect: String = "none", // none | glow | shimmer
    val emoji: String? = null,
) {
    val hasFlair: Boolean get() = accent != null || gradient != null || emoji != null || effect != "none"
}

@Serializable
data class Conversation(
    val id: String,
    /** `dm` | `group` | `channel` | `space`. A space holds channels, never messages. */
    val type: String,
    /** Set on a channel: the space it belongs to. */
    val parentId: String? = null,
    /** The space this channel lives in, for the chat header. */
    val parentTitle: String? = null,
    val position: Int = 0,
    val title: String? = null,
    val description: String? = null,
    val avatarUrl: String? = null,
    val handle: String? = null,
    val isPublic: Boolean = false,
    /** `verified` | `partner` | `staff`, or null. Groups carry marks too. */
    val badge: String? = null,
    val appearance: ConversationAppearance? = null,
    val ownerId: String? = null,
    val memberCount: Int = 0,
    /** Members online right now — groups only, 0 for DMs. */
    val hereCount: Int = 0,
    val memberPreview: List<PublicUser> = emptyList(),
    val otherUser: PublicUser? = null,
    val latestSeq: Long = 0,
    val lastMessageAt: String? = null,
    val lastMessage: LastMessageStub? = null,
    val disappearingSeconds: Int = 0,
    val slowModeSeconds: Int = 0,
    /**
     * A campfire's end. Non-null means the whole place is deleted at this
     * instant — an absolute time, so a paused app never shows a drifted
     * countdown.
     */
    val endsAt: String? = null,
    /** The group's pet. Fed by conversation; null on DMs and old payloads. */
    val pet: GroupPet? = null,
    /** Decimal-string permission bitfield — see the backend's permissions.ts. */
    val permissions: String? = null,
    val activeCall: ActiveCall? = null,
    val self: SelfState? = null,
    val createdAt: String? = null,
) {
    /** DMs render the other person; groups render their own title. */
    val displayName: String
        get() = when {
            type == "dm" -> otherUser?.label ?: "Direct message"
            else -> title ?: "Group"
        }

    val displayAvatar: String? get() = if (type == "dm") otherUser?.avatarUrl else avatarUrl
    val avatarSeed: String get() = if (type == "dm") (otherUser?.id ?: id) else id
    /** A space opens its channel list, not a composer. */
    val isSpace: Boolean get() = type == "space"
    val unread: Int get() = self?.unreadCount ?: 0
    val isMuted: Boolean get() = self?.notificationLevel == "none" || self?.mutedUntil != null
}

/**
 * The group's pet: a creature whose wellbeing is the group's own activity
 * reflected back at it. Species is not on the wire — it derives from the
 * conversation id, so every client agrees without anyone storing it.
 */
@Serializable
data class GroupPet(
    val name: String? = null,
    /** egg | baby | kid | grown | elder */
    val stage: String = "egg",
    /** happy | hungry | sad | gone */
    val mood: String = "happy",
    val streak: Int = 0,
    val fedDays: Int = 0,
    val bornAt: String? = null,
)

/**
 * What you missed while you were away.
 *
 * Built from structure, not generated — see the server's `catchUp`. Counts,
 * faces and pictures are things that are simply true; a paragraph describing
 * what was said would be a guess nobody in the conversation could check.
 */
@Serializable
data class CatchUp(
    val since: Long = 0,
    val upTo: Long = 0,
    val newMessages: Int = 0,
    /** The count is a floor, not a total — show it as "500+". */
    val capped: Boolean = false,
    val participants: List<CatchUpParticipant> = emptyList(),
    val media: List<Attachment> = emptyList(),
    val mentions: List<Message> = emptyList(),
    val pins: List<Message> = emptyList(),
) {
    /**
     * Two unread messages do not need a summary; scrolling is faster than
     * reading a card about them.
     */
    val worthShowing: Boolean
        get() = newMessages >= 5 || mentions.isNotEmpty()
}

@Serializable
data class CatchUpParticipant(val user: PublicUser, val count: Int = 0)

@Serializable
data class Attachment(
    val id: String,
    val url: String,
    val thumbnailUrl: String? = null,
    val mimeType: String = "application/octet-stream",
    val size: Long = 0,
    val width: Int? = null,
    val height: Int? = null,
    val durationMs: Int? = null,
    val blurhash: String? = null,
    val waveform: List<Int>? = null,
    val filename: String? = null,
    val caption: String? = null,
    val isSpoiler: Boolean = false,
)

@Serializable
data class GifPayload(
    val provider: String = "tenor",
    val id: String = "",
    val url: String,
    val previewUrl: String,
    val width: Int = 0,
    val height: Int = 0,
    val title: String? = null,
)

/**
 * A place, attached to a message.
 *
 * [liveUntil] is what makes a share live. The point here is where it *started*
 * — the current position arrives separately, over [LiveLocation], because a
 * live share is hundreds of updates and none of them belong in the history row.
 */
@Serializable
data class LocationPayload(
    val latitude: Double,
    val longitude: Double,
    val name: String? = null,
    val liveUntil: String? = null,
)

/** Where a live share is right now. Replaced on every ping. */
@Serializable
data class LiveLocation(
    val messageId: String,
    val conversationId: String,
    val userId: String,
    val latitude: Double,
    val longitude: Double,
    val accuracy: Double? = null,
    val heading: Double? = null,
    /** Travels with every point, so a client can stop by itself if the socket
     *  goes quiet rather than trusting an end event to arrive. */
    val expiresAt: String,
    val endedAt: String? = null,
    val updatedAt: String? = null,
)

@Serializable
data class LiveLocationsEnvelope(val locations: List<LiveLocation> = emptyList())

// ── Interactive components ───────────────────────────────────────────────────

/**
 * A button a bot attached to its message.
 *
 * [customId] is echoed back to the bot on press. It is not a secret: the
 * server authorises a press by conversation membership and by [onlyUserId].
 */
@Serializable
data class MessageButton(
    val type: String = "button",
    val customId: String,
    val label: String,
    /** primary | secondary | success | danger */
    val style: String = "secondary",
    val disabled: Boolean = false,
    /** When set, only this person may press it. */
    val onlyUserId: String? = null,
)

@Serializable
data class MessageComponentRow(
    val type: String = "row",
    val components: List<MessageButton> = emptyList(),
)

// ── Embeds ───────────────────────────────────────────────────────────────────

@Serializable data class EmbedAuthor(val name: String, val url: String? = null, val iconUrl: String? = null)
@Serializable data class EmbedField(val name: String, val value: String, val inline: Boolean = false)
@Serializable data class EmbedMedia(val url: String)
@Serializable data class EmbedFooter(val text: String, val iconUrl: String? = null)

/** line | area | bar | pie | donut | scatter, with 2..24 labelled points. */
@Serializable
data class EmbedChart(
    val kind: String = "line",
    val points: List<EmbedChartPoint> = emptyList(),
)

@Serializable
data class EmbedChartPoint(val label: String = "", val value: Double = 0.0)

/**
 * A rich card. Two origins, one shape: `rich` was posted by a bot, `link` was
 * built by the worker from a URL someone pasted. Rendered identically.
 */
@Serializable
data class Embed(
    val type: String = "rich",
    val title: String? = null,
    val description: String? = null,
    val url: String? = null,
    /** #RRGGBB accent for the left bar. */
    val color: String? = null,
    /** Site name, for link embeds. */
    val provider: String? = null,
    val author: EmbedAuthor? = null,
    val fields: List<EmbedField> = emptyList(),
    val image: EmbedMedia? = null,
    val thumbnail: EmbedMedia? = null,
    val footer: EmbedFooter? = null,
    val timestamp: String? = null,
    /** Inline data chart. Senders put a text fallback in the description. */
    val chart: EmbedChart? = null,
    /**
     * A trusted treatment, currently only `announcement`.
     *
     * Never render on this alone. The server strips it from anyone who is not
     * a badged bot, and the client checks the sender independently, because a
     * card that claims to be from us must not be something a third-party bot
     * can mint. See EmbedCard's `trusted` parameter.
     */
    val kind: String? = null,
    /**
     * Set when this link is a yappy invite, resolved by the server from the
     * group itself rather than by fetching the page. Null on every other link,
     * which is what keeps the ordinary preview rendering untouched.
     */
    val invite: EmbedInvite? = null,
)

/**
 * The group an invite link points at.
 *
 * Resolved per read, so `memberCount` is current and a group that has since
 * been deleted arrives as null rather than as a card offering to join it.
 */
@Serializable
data class EmbedInvite(
    val code: String,
    val type: String = "group",
    val title: String? = null,
    val description: String? = null,
    val badge: String? = null,
    val memberCount: Int = 0,
    val avatarUrl: String? = null,
)

@Serializable
data class ReplyStub(
    val id: String,
    val seq: Long = 0,
    val senderId: String? = null,
    val preview: String? = null,
    val type: String = "text",
)

@Serializable
data class PollOption(
    val id: String,
    val label: String,
    val position: Int = 0,
    val voteCount: Int = 0,
)

@Serializable
data class Poll(
    val id: String,
    val question: String,
    val multiSelect: Boolean = false,
    val isAnonymous: Boolean = false,
    val closesAt: String? = null,
    val closedAt: String? = null,
    val totalVoters: Int = 0,
    val options: List<PollOption> = emptyList(),
    val myVotes: List<String> = emptyList(),
) {
    val isClosed: Boolean get() = closedAt != null
}

@Serializable
data class CallSummary(
    val callId: String,
    val mode: String = "audio",
    val outcome: String = "completed",
    val durationSeconds: Int = 0,
)

@Serializable
data class SystemPayload(
    val event: String,
    val actorId: String? = null,
    val targetIds: List<String> = emptyList(),
    val value: String? = null,
)

/** Who a forwarded message originally came from. */
@Serializable
data class ForwardedFrom(
    val userId: String,
    val messageId: String? = null,
    val username: String? = null,
    val displayName: String? = null,
) {
    /** "Haider", else "@yap", else a neutral fallback for deleted accounts. */
    val label: String
        get() = displayName?.takeIf { it.isNotBlank() }
            ?: username?.takeIf { it.isNotBlank() }?.let { "@$it" }
            ?: "someone"
}

@Serializable
data class Message(
    val id: String,
    val conversationId: String,
    val seq: Long,
    val type: String = "text",
    val content: String? = null,
    /** The body is in [ciphertext]; [content] holds the notice. */
    val isEncrypted: Boolean = false,
    /** This device's copy, or null when it was not a recipient. */
    val ciphertext: String? = null,
    val entities: List<JsonElement>? = null,
    val sender: PublicUser? = null,
    val senderId: String? = null,
    /** The sender's top role colour *in this conversation*, if any. */
    val senderRoleColor: String? = null,
    val senderRoleName: String? = null,
    val replyTo: ReplyStub? = null,
    val threadRootId: String? = null,
    val threadReplyCount: Int = 0,
    val attachments: List<Attachment> = emptyList(),
    val stickerId: String? = null,
    /** The sticker itself, hydrated server-side so it renders without the pack
     *  installed. The bare id above is only useful for "add this pack". */
    val sticker: Sticker? = null,
    val gif: GifPayload? = null,
    /** Where the share started. `liveUntil` set means it is still moving. */
    val location: LocationPayload? = null,
    val poll: Poll? = null,
    val embeds: List<Embed> = emptyList(),
    val components: List<MessageComponentRow> = emptyList(),
    val callSummary: CallSummary? = null,
    val system: SystemPayload? = null,
    /**
     * Names for the ids inside [system], resolved by the server.
     *
     * The roster is loaded after the timeline, so resolving these client-side
     * meant every system line read "Someone added someone" until the members
     * request came back — and stayed that way forever for anybody who had left
     * the group, since they are in no roster to look up.
     */
    val systemNames: Map<String, String> = emptyMap(),
    /** Set when this message was forwarded from somewhere else. */
    val forwardedFrom: ForwardedFrom? = null,
    /** emoji → count, maintained server-side by trigger. */
    val reactions: Map<String, Int> = emptyMap(),
    val myReactions: List<String> = emptyList(),
    val isPinned: Boolean = false,
    val silent: Boolean = false,
    val editedAt: String? = null,
    val expiresAt: String? = null,
    val deletedAt: String? = null,
    val createdAt: String,
    val nonce: String? = null,
) {
    val isDeleted: Boolean get() = deletedAt != null
    val isSystem: Boolean get() = type == "system"

    /**
     * Local-only: a message the user has sent that the server has not confirmed.
     * Rendered at reduced opacity with a clock icon.
     */
    val isPending: Boolean get() = seq == PENDING_SEQ

    companion object {
        const val PENDING_SEQ = -1L
    }
}

@Serializable
data class Sticker(
    val id: String,
    val emoji: String,
    val name: String? = null,
    val position: Int = 0,
    val url: String,
)

@Serializable
data class StickerPack(
    val id: String,
    val slug: String,
    val name: String,
    val description: String? = null,
    val coverUrl: String? = null,
    val isAnimated: Boolean = false,
    val isOfficial: Boolean = false,
    val stickerCount: Int = 0,
    val installCount: Int = 0,
    val isInstalled: Boolean = false,
    val stickers: List<Sticker> = emptyList(),
)

@Serializable
data class GifResult(
    val id: String,
    val provider: String = "tenor",
    val url: String,
    val previewUrl: String,
    val width: Int = 0,
    val height: Int = 0,
    val title: String = "",
)

@Serializable
data class CallParticipant(
    val user: PublicUser,
    val state: String = "invited",
    val isMuted: Boolean = false,
    val isVideoEnabled: Boolean = false,
    val isScreenSharing: Boolean = false,
)

@Serializable
data class Call(
    val id: String,
    val conversationId: String? = null,
    val initiatorId: String? = null,
    val mode: String = "audio",
    val state: String = "ringing",
    val roomName: String = "",
    val ringExpiresAt: String? = null,
    val startedAt: String? = null,
    val endedAt: String? = null,
    val endReason: String? = null,
    val durationSeconds: Int? = null,
    val participants: List<CallParticipant> = emptyList(),
    val createdAt: String? = null,
)

/**
 * A named role. `permissions` is a decimal *string* — the bitfield runs past
 * bit 62 and a Long would be fine, but the wire format is shared with clients
 * whose numbers are doubles, so it stays text everywhere.
 */
@Serializable
data class RoleEntry(
    val id: String,
    val name: String,
    val color: String? = null,
    val permissions: String = "0",
    val position: Int = 0,
    val isHoisted: Boolean = false,
    val isMentionable: Boolean = false,
)

/** One channel inside a space, as its list renders it. */
@Serializable
data class ChannelEntry(
    val id: String,
    val title: String? = null,
    val description: String? = null,
    val position: Int = 0,
    val latestSeq: Long = 0,
    val lastMessageAt: String? = null,
    val lastMessagePreview: String? = null,
    val unreadCount: Int = 0,
    val mentionCount: Int = 0,
    /** Inherited from the space until this channel is given its own. */
    val notificationLevel: String = "all",
    val isMuted: Boolean = false,
    val isAnnouncement: Boolean = false,
    /** A drop-in voice room: tapping joins, there is no timeline to open. */
    val isVoice: Boolean = false,
    /** Who is inside right now — only ever sent for voice channels. */
    val voiceParticipants: List<VoiceOccupant> = emptyList(),
)

/** Somebody sitting in a voice channel. A trimmed PublicUser plus live mute. */
@Serializable
data class VoiceOccupant(
    val id: String,
    val username: String? = null,
    val displayName: String? = null,
    val avatarUrl: String? = null,
    val isMuted: Boolean = false,
) {
    val label: String get() = displayName ?: username ?: "someone"
}

/** POST /conversations/:id/voice/join — the ticket into the SFU room. */
@Serializable
data class VoiceJoinEnvelope(
    val token: String,
    val url: String,
    val roomName: String? = null,
    val channelId: String? = null,
    val participants: List<VoiceOccupant> = emptyList(),
)

@Serializable
data class MemberEntry(
    val user: PublicUser,
    val role: String = "member",
    /** Highest-positioned first. */
    val roles: List<RoleEntry> = emptyList(),
    /** The top role that specifies a colour, if any. */
    val roleColor: String? = null,
    /** This group's half of an affiliation, whether or not the member displays it. */
    val isAffiliate: Boolean = false,
    val nickname: String? = null,
    val mutedUntil: String? = null,
    val joinedAt: String? = null,
    val lastReadSeq: Long = 0,
)

@Serializable
data class PinEntry(val message: Message, val position: Int = 0, val pinnedAt: String? = null)

/** A member as the group profile sees them: identity plus live presence. */
@Serializable
data class SummaryMember(
    val user: PublicUser,
    val role: String = "member",
    val roles: List<RoleEntry> = emptyList(),
    val roleColor: String? = null,
    val isAffiliate: Boolean = false,
    val nickname: String? = null,
    val presence: String = "offline",
) {
    val isHere: Boolean get() = presence != "offline"
}

@Serializable
data class SummaryCounts(val media: Int = 0, val pins: Int = 0)

/** One person you already know inside a group — see GET /conversations/:id/mutuals. */
@Serializable
data class KnownPerson(
    val id: String,
    val username: String? = null,
    val displayName: String? = null,
    val avatarUrl: String? = null,
    val isVerified: Boolean = false,
    /** `mutual` | `following` | `contact`, strongest first. */
    val connection: String = "contact",
) {
    val label: String get() = displayName ?: username?.let { "@$it" } ?: "Someone"
}

@Serializable
data class KnownPeople(val people: List<KnownPerson> = emptyList(), val total: Int = 0)

@Serializable
data class ViewersEnvelope(val userIds: List<String> = emptyList())

/**
 * A bot in the public directory.
 *
 * [botUserId] is what you add to a conversation. The application [id] is the
 * developer-side record and is no use for adding.
 */
@Serializable
data class DirectoryBot(
    val id: String,
    val botUserId: String,
    val name: String,
    val description: String? = null,
    val commandCount: Int = 0,
    val user: PublicUser? = null,
)

@Serializable
data class BotDirectory(val bots: List<DirectoryBot> = emptyList())

@Serializable
data class GroupSummary(
    val members: List<SummaryMember> = emptyList(),
    val onlineCount: Int = 0,
    val counts: SummaryCounts = SummaryCounts(),
    val activeCall: ActiveCall? = null,
)

@Serializable
data class DeviceEntry(
    val id: String,
    val name: String? = null,
    val platform: String = "android",
    val appVersion: String? = null,
    val osVersion: String? = null,
    val lastIp: String? = null,
    val lastActiveAt: String? = null,
    val createdAt: String? = null,
    val pushEnabled: Boolean = false,
    val isCurrent: Boolean = false,
)

@Serializable
data class SearchHit(
    val messageId: String,
    val conversationId: String,
    val seq: Long,
    val senderId: String? = null,
    val type: String = "text",
    val snippet: String = "",
    val createdAt: String,
)

@Serializable
data class Badge(
    val unreadMessages: Int = 0,
    val unreadMentions: Int = 0,
    val unreadConversations: Int = 0,
)

// ── Receipts ─────────────────────────────────────────────────────────────────

/**
 * What the tick on an outgoing bubble says. `None` for other people's
 * messages — only the sender is owed a status.
 */
enum class MessageReceiptState { None, Pending, Sent, Delivered, Read }

/**
 * One member's read/delivered watermarks, from GET …/receipts.
 *
 * Watermarks rather than per-message rows: a member has read *up to* a seq, so
 * "who has seen message N" is every entry with `seq >= N` — no per-message
 * fetch, and the same payload draws the ticks and fills the seen-by sheet.
 */
@Serializable
data class ReceiptEntry(
    val user: PublicUser,
    val seq: Long = 0,
    val readAt: String? = null,
    val deliveredSeq: Long = 0,
)

@Serializable data class ReceiptsEnvelope(val readBy: List<ReceiptEntry> = emptyList())

// ── Bans ─────────────────────────────────────────────────────────────────────

/**
 * A ban as the moderation list renders it.
 *
 * Carries the whole [PublicUser] rather than an id because someone who was
 * banned is usually no longer a member, so there is no member row to look
 * their name up in.
 */
@Serializable
data class BanEntry(
    val user: PublicUser,
    val reason: String? = null,
    /** Who did it. Rendered only when that person is still resolvable. */
    val bannedById: String? = null,
    /** Null means permanent. */
    val expiresAt: String? = null,
    val createdAt: String? = null,
)

@Serializable data class BansEnvelope(val bans: List<BanEntry> = emptyList())

// ── Build metadata ───────────────────────────────────────────────────────────

/**
 * What the server is running, and whether this build is behind.
 *
 * The comparison is the server's to make: version ordering is four chances to
 * get it wrong, and the two booleans are the only part the UI actually needs.
 */
@Serializable
data class VersionInfo(
    val api: String = "",
    val latest: String? = null,
    val minimum: String? = null,
    val updateAvailable: Boolean = false,
    val updateRequired: Boolean = false,
)

// ── Release notes ────────────────────────────────────────────────────────────

/** One bullet: a bold lead-in and a sentence, optionally linking somewhere. */
@Serializable
data class ReleaseNoteItem(
    val title: String = "",
    val body: String = "",
    val url: String? = null,
)

@Serializable
data class ReleaseNoteSection(
    val heading: String = "",
    /**
     * An SF Symbol name chosen by the server. Android has no such catalogue, so
     * [gg.yappy.app.ui.settings.releaseIcon] maps the small generic set the
     * server actually uses onto Material icons and draws nothing for the rest.
     */
    val icon: String? = null,
    val items: List<ReleaseNoteItem> = emptyList(),
)

@Serializable
data class ReleaseNote(
    val id: String = "",
    val version: String = "",
    /** `YYYY-MM-DD`. Rendered as the sheet's subtitle. */
    val date: String = "",
    val title: String = "What's New",
    val intro: String? = null,
    /** Absent means fall back to the app's own hero treatment. */
    val heroUrl: String? = null,
    val sections: List<ReleaseNoteSection> = emptyList(),
)

@Serializable
data class ChangelogEnvelope(
    val notes: List<ReleaseNote> = emptyList(),
    /**
     * The newest note that exists, whether or not it is in [notes]. A first run
     * records this and shows nothing.
     */
    val latestId: String? = null,
)

// ── Envelopes ────────────────────────────────────────────────────────────────

@Serializable data class AuthTokens(
    val accessToken: String,
    val refreshToken: String,
    val expiresIn: Int = 900,
    val deviceId: String? = null,
    val user: FullUser? = null,
    val needsOnboarding: Boolean = false,
)

@Serializable data class RefreshResponse(val accessToken: String, val refreshToken: String, val expiresIn: Int = 900)
@Serializable data class GatewayTicket(val ticket: String, val url: String, val expiresIn: Int = 60)
@Serializable data class OtpRequested(val sent: Boolean = true, val expiresIn: Int = 300, val channel: String = "sms")
@Serializable data class UsernameAvailability(val available: Boolean, val reason: String? = null)
@Serializable data class UserEnvelope(val user: FullUser)
@Serializable data class UsersEnvelope(val users: List<PublicUser> = emptyList(), val nextCursor: String? = null)
@Serializable data class ConversationEnvelope(val conversation: Conversation)
@Serializable data class ConversationsEnvelope(val conversations: List<Conversation> = emptyList(), val nextCursor: String? = null)
@Serializable data class MessageEnvelope(val message: Message)

/** A slash command a bot in this conversation answers. */
@Serializable
data class BotCommand(
    val name: String,
    val description: String = "",
    val usage: String = "",
    val botId: String? = null,
    val botUsername: String? = null,
    /** So a picker with several bots can say whose command each one is. */
    val botAvatarUrl: String? = null,
)

@Serializable data class BotCommandsEnvelope(val commands: List<BotCommand> = emptyList())
@Serializable data class HistoryEnvelope(
    val messages: List<Message> = emptyList(),
    val hasMore: Boolean = false,
    val floorSeq: Long = 0,
    val latestSeq: Long = 0,
)
@Serializable data class MembersEnvelope(val members: List<MemberEntry> = emptyList(), val nextCursor: String? = null)
@Serializable data class PinsEnvelope(val pins: List<PinEntry> = emptyList())
@Serializable data class RolesEnvelope(val roles: List<RoleEntry> = emptyList())
@Serializable data class RoleEnvelope(val role: RoleEntry)
@Serializable data class ChannelsEnvelope(val channels: List<ChannelEntry> = emptyList())
@Serializable data class ChannelEnvelope(val channel: Conversation)
@Serializable data class UpgradeEnvelope(val space: Conversation, val channel: Conversation)
@Serializable data class SummaryEnvelope(val summary: GroupSummary)
@Serializable data class Invite(
    val code: String,
    val url: String,
    val maxUses: Int = 0,
    val uses: Int = 0,
    val expiresAt: String? = null,
)
@Serializable data class InviteEnvelope(val invite: Invite)
@Serializable data class InvitesEnvelope(val invites: List<Invite> = emptyList())

/**
 * The group behind an invite code, as the preview endpoint describes it.
 *
 * A trimmed shape rather than a [Conversation]: the server deliberately sends
 * only what a non-member may see, and decoding it as a full conversation would
 * invent memberships and read state that do not exist yet.
 */
@Serializable data class InviteTarget(
    val id: String,
    val type: String = "group",
    val title: String? = null,
    val description: String? = null,
    val memberCount: Int = 0,
    val avatarUrl: String? = null,
    val badge: String? = null,
)
@Serializable data class InvitePreview(
    val conversation: InviteTarget,
    /** Null when the invite has no use limit. */
    val usesRemaining: Int? = null,
)
/** Joining answers with the whole conversation, plus whether it was a no-op. */
@Serializable data class JoinResult(
    val conversation: Conversation,
    val alreadyMember: Boolean = false,
)
@Serializable data class OnlineEntry(val user: PublicUser, val status: String = "online")
@Serializable data class OnlineEnvelope(val online: List<OnlineEntry> = emptyList())
/** The presigned PUT the server hands back — valid for [expiresIn] seconds. */
@Serializable data class UploadTarget(
    val url: String,
    val method: String = "PUT",
    val headers: Map<String, String> = emptyMap(),
    val expiresIn: Int = 900,
)
@Serializable data class UploadEnvelope(
    val media: Attachment,
    /** Null when the server deduplicated by checksum — the bytes already exist. */
    val upload: UploadTarget? = null,
    val deduplicated: Boolean = false,
)
@Serializable data class MediaEnvelope(val media: Attachment)
@Serializable data class ReactionDetail(val emoji: String, val user: PublicUser, val reactedAt: String? = null)
@Serializable data class ReactionsEnvelope(val reactions: List<ReactionDetail> = emptyList())

/**
 * A group's custom emoji. Reaction keys of the form `:name:` resolve against
 * this set and render as the image; a key that resolves nowhere renders as its
 * literal text, which is also what old builds have always done.
 */
@Serializable data class GroupEmoji(
    val id: String,
    val name: String,
    val animated: Boolean = false,
    val url: String,
)
@Serializable data class GroupEmojisEnvelope(val emojis: List<GroupEmoji> = emptyList())
@Serializable data class DiscoverEntry(
    val id: String,
    val type: String = "group",
    val title: String? = null,
    val description: String? = null,
    val handle: String? = null,
    val memberCount: Int = 0,
    val avatarUrl: String? = null,
    val badge: String? = null,
    /** Members present right now — the warmth signal a directory ranks by. */
    val hereCount: Int = 0,
    /** A call is happening in there as you look. */
    val live: Boolean = false,
    val createdAt: String? = null,
    val appearance: ConversationAppearance? = null,
)
@Serializable data class DiscoverEnvelope(val conversations: List<DiscoverEntry> = emptyList())
@Serializable data class PacksEnvelope(val packs: List<StickerPack> = emptyList(), val nextCursor: String? = null)
@Serializable data class StickersEnvelope(val stickers: List<Sticker> = emptyList())
@Serializable data class GifsEnvelope(
    val results: List<GifResult> = emptyList(),
    val next: String? = null,
    val unavailable: Boolean = false,
)
@Serializable data class CallEnvelope(val call: Call, val token: String? = null, val url: String? = null)
@Serializable data class DevicesEnvelope(val devices: List<DeviceEntry> = emptyList())
@Serializable data class SearchEnvelope(val results: List<SearchHit> = emptyList(), val nextCursor: String? = null)
@Serializable data class ReadAck(val lastReadSeq: Long = 0, val unreadCount: Int = 0, val mentionCount: Int = 0)
@Serializable data class Ok(val ok: Boolean = true)

@Serializable data class PublishedKeys(val fingerprint: String, val availablePreKeys: Int = 0)
@Serializable data class PreKeyCount(val availablePreKeys: Int = 0)

/** One recipient device, from a key claim. */
@Serializable data class KeyBundle(val userId: String, val deviceId: String, val identityKey: String)

@Serializable data class ClaimedKeys(val bundles: List<KeyBundle> = emptyList())

/** This device's copy of an encrypted body, fetched after a live delivery. */
@Serializable data class CipherEnvelope(val ciphertext: String? = null)

@Serializable
data class ApiErrorBody(val error: ApiErrorDetail)

@Serializable
data class ApiErrorDetail(
    val code: String,
    val message: String,
    @SerialName("retryAfter") val retryAfter: Int? = null,
)
