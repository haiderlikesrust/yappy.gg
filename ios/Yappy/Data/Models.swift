import Foundation

/// Wire models.
///
/// Every field the server may omit has a default, and unknown keys are ignored.
/// Between them, a server that adds a field cannot crash an older build — which
/// matters a great deal when the old build is sitting on someone's phone and
/// cannot be recalled.
///
/// The decoders are written by hand rather than synthesised. Swift's generated
/// `Decodable` throws on a *missing* key for any non-optional property, so a
/// single field the server stopped sending would fail the whole response. These
/// read every optional field through `get`/`opt`, which cannot throw, so the
/// worst a surprising payload can do is fall back to a default.
///
/// Internal rather than `private`. At file scope `private` means *this file*,
/// and these stopped being one file's business the moment a model was decoded
/// somewhere else — `Ratchet.swift` reaches for `get`/`opt` and could not see
/// them. Widening beats a second copy: two implementations of "never throw,
/// fall back instead" is exactly the pair that drifts.
extension KeyedDecodingContainer {
    /// A value with a fallback, for fields the server may omit.
    func get<T: Decodable>(_ key: Key, _ fallback: T) -> T {
        ((try? decodeIfPresent(T.self, forKey: key)) ?? nil) ?? fallback
    }

    /// A genuinely optional field: absent and null are both nil.
    func opt<T: Decodable>(_ key: Key) -> T? {
        (try? decodeIfPresent(T.self, forKey: key)) ?? nil
    }

    /// A list where one unreadable element is dropped, not the whole list.
    ///
    /// `get(.messages, [])` decodes the array as a unit, so `JSONDecoder`
    /// abandoning it over a single malformed element hands back the empty
    /// fallback — fifty good messages thrown away because of one. That renders
    /// as a chat with a header, a pinned bar and nothing else, no spinner and
    /// no error, and `hasMore` defaults false so paging never recovers it.
    /// Element-wise, the blast radius is the element.
    func list<T: Decodable>(_ key: Key) -> [T] {
        guard let raw = (try? decodeIfPresent([Lenient<T>].self, forKey: key)) ?? nil else { return [] }
        return raw.compactMap(\.value)
    }
}

/// Decodes an element, or nothing, but never throws.
private struct Lenient<T: Decodable>: Decodable {
    let value: T?

    init(from decoder: Decoder) throws {
        value = try? T(from: decoder)
    }
}

// ── Identity ─────────────────────────────────────────────────────────────────

/// The group a person displays as their affiliation — its logo sits beside their
/// name. `badge` is the *group's* badge, not the person's: an affiliation is only
/// as good as the organisation behind it, so the client can render a partner's
/// affiliate differently from a merely verified one.
struct Affiliation: Codable, Hashable, Identifiable {
    let id: String
    var title: String?
    var avatarUrl: String?
    var badge: String?

    init(id: String, title: String? = nil, avatarUrl: String? = nil, badge: String? = nil) {
        self.id = id
        self.title = title
        self.avatarUrl = avatarUrl
        self.badge = badge
    }

    enum CodingKeys: String, CodingKey { case id, title, avatarUrl, badge }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.get(.id, "")
        title = c.opt(.title)
        avatarUrl = c.opt(.avatarUrl)
        badge = c.opt(.badge)
    }
}

struct PublicUser: Codable, Hashable, Identifiable {
    let id: String
    var username: String?
    var displayName: String?
    var avatarUrl: String?
    var isBot: Bool
    var isVerified: Bool
    /// `verified` | `partner` | `staff`, or nil.
    var badge: String?
    /// Everything they hold. Empty from a server that predates the field, which
    /// is why `badge` stays: the marks fall back to it rather than vanishing.
    var badges: [String]
    /// Nil on most list endpoints — only the surfaces that join it populate it.
    var affiliation: Affiliation?
    /// Whether you may put this person in a group, answered by the server.
    ///
    /// Only the two lists the member picker reads populate it — user search and
    /// your contacts. Nil elsewhere, and nil means "not asked", not "no": a row
    /// from some other endpoint must not render as blocked just because it was
    /// never told.
    var canAddToGroups: Bool?

    var label: String { displayName ?? username.map { "@\($0)" } ?? "Someone" }

    init(
        id: String,
        username: String? = nil,
        displayName: String? = nil,
        avatarUrl: String? = nil,
        isBot: Bool = false,
        isVerified: Bool = false,
        badge: String? = nil,
        badges: [String] = [],
        affiliation: Affiliation? = nil,
        canAddToGroups: Bool? = nil
    ) {
        self.id = id
        self.username = username
        self.displayName = displayName
        self.avatarUrl = avatarUrl
        self.isBot = isBot
        self.isVerified = isVerified
        self.badge = badge
        self.badges = badges
        self.affiliation = affiliation
        self.canAddToGroups = canAddToGroups
    }

    enum CodingKeys: String, CodingKey {
        case id, username, displayName, avatarUrl, isBot, isVerified, badge, badges, affiliation
        case canAddToGroups
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.get(.id, "")
        username = c.opt(.username)
        displayName = c.opt(.displayName)
        avatarUrl = c.opt(.avatarUrl)
        isBot = c.get(.isBot, false)
        isVerified = c.get(.isVerified, false)
        badge = c.opt(.badge)
        badges = c.list(.badges)
        affiliation = c.opt(.affiliation)
        canAddToGroups = c.opt(.canAddToGroups)
    }
}

struct Presence: Codable, Hashable {
    var status: String
    var customStatus: String?
    var lastSeenAt: String?

    init(status: String = "offline", customStatus: String? = nil, lastSeenAt: String? = nil) {
        self.status = status
        self.customStatus = customStatus
        self.lastSeenAt = lastSeenAt
    }

    enum CodingKeys: String, CodingKey { case status, customStatus, lastSeenAt }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        status = c.get(.status, "offline")
        customStatus = c.opt(.customStatus)
        lastSeenAt = c.opt(.lastSeenAt)
    }
}

struct Appearance: Codable, Hashable {
    var theme: String
    var accent: String
    var fontScale: Double
    var reduceMotion: Bool

    enum CodingKeys: String, CodingKey { case theme, accent, fontScale, reduceMotion }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        theme = c.get(.theme, "system")
        accent = c.get(.accent, "#6C5CE7")
        fontScale = c.get(.fontScale, 1)
        reduceMotion = c.get(.reduceMotion, false)
    }
}

/// Where you and someone else stand. Absent on your own profile.
///
/// `canAddToGroups` is the server's answer, not something derived from
/// `isMutual` here: it reflects the other person's `whoCanAddToGroups`
/// audience, which defaults to contacts but can be set to anyone or to nobody.
/// Deriving it on the client would put a promise in the UI that the add
/// endpoint then breaks.
struct Relationship: Codable, Hashable {
    var following: Bool
    var followedBy: Bool
    var isMutual: Bool
    var canAddToGroups: Bool

    enum CodingKeys: String, CodingKey { case following, followedBy, isMutual, canAddToGroups }

    init(following: Bool = false, followedBy: Bool = false, isMutual: Bool = false, canAddToGroups: Bool = false) {
        self.following = following
        self.followedBy = followedBy
        self.isMutual = isMutual
        self.canAddToGroups = canAddToGroups
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        following = c.get(.following, false)
        followedBy = c.get(.followedBy, false)
        isMutual = c.get(.isMutual, false)
        canAddToGroups = c.get(.canAddToGroups, false)
    }
}

/// Profile flair — the gradient the header wears when there is no banner.
struct UserFlair: Codable, Hashable {
    var gradient: [String]?

    init(gradient: [String]? = nil) {
        self.gradient = gradient
    }

    enum CodingKeys: String, CodingKey { case gradient }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        gradient = c.opt(.gradient)
    }
}

/// Rooms you share with this account. Absent on your own profile.
struct MutualGroups: Codable, Hashable {
    var count: Int
    var preview: [MutualGroupRef]

    enum CodingKeys: String, CodingKey { case count, preview }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        count = c.get(.count, 0)
        preview = c.list(.preview)
    }
}

struct MutualGroupRef: Codable, Hashable, Identifiable {
    let id: String
    var title: String?
    var emoji: String?

    enum CodingKeys: String, CodingKey { case id, title, emoji }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.get(.id, "")
        title = c.opt(.title)
        emoji = c.opt(.emoji)
    }
}

struct FullUser: Codable, Hashable, Identifiable {
    let id: String
    var username: String?
    var displayName: String?
    var avatarUrl: String?
    var bannerUrl: String?
    var bio: String?
    var pronouns: String?
    var isBot: Bool
    var isVerified: Bool
    var badge: String?
    var badges: [String]
    var affiliation: Affiliation?
    var presence: Presence
    var phone: String?
    var email: String?
    var privacy: JSONValue?
    var notifications: JSONValue?
    var appearance: Appearance?
    /// Nil on your own profile, and on payloads that predate the field.
    var relationship: Relationship?
    /// Profile flair — the gradient the header wears when there is no banner.
    var flair: UserFlair?
    /// Rooms you share with this account. Absent on your own profile.
    var mutualGroups: MutualGroups?
    var createdAt: String?

    enum CodingKeys: String, CodingKey {
        case id, username, displayName, avatarUrl, bannerUrl, bio, pronouns
        case isBot, isVerified, badge, badges, affiliation, presence, phone, email
        case privacy, notifications, appearance, relationship, flair, mutualGroups, createdAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.get(.id, "")
        username = c.opt(.username)
        displayName = c.opt(.displayName)
        avatarUrl = c.opt(.avatarUrl)
        bannerUrl = c.opt(.bannerUrl)
        bio = c.opt(.bio)
        pronouns = c.opt(.pronouns)
        isBot = c.get(.isBot, false)
        isVerified = c.get(.isVerified, false)
        badge = c.opt(.badge)
        badges = c.list(.badges)
        affiliation = c.opt(.affiliation)
        presence = c.get(.presence, Presence())
        phone = c.opt(.phone)
        email = c.opt(.email)
        privacy = c.opt(.privacy)
        notifications = c.opt(.notifications)
        appearance = c.opt(.appearance)
        relationship = c.opt(.relationship)
        flair = c.opt(.flair)
        mutualGroups = c.opt(.mutualGroups)
        createdAt = c.opt(.createdAt)
    }
}

// ── Conversations ────────────────────────────────────────────────────────────

struct SelfState: Codable, Hashable {
    var role: String
    /// This group has affiliated you; whether you show it is your call.
    var isAffiliate: Bool
    var lastReadSeq: Int64
    var unreadCount: Int
    var mentionCount: Int
    var notificationLevel: String
    var mutedUntil: String?
    var isPinned: Bool
    var isArchived: Bool
    var nickname: String?
    var draft: String?
    var joinedAt: String?
    var historyStartSeq: Int64

    enum CodingKeys: String, CodingKey {
        case role, isAffiliate, lastReadSeq, unreadCount, mentionCount
        case notificationLevel, mutedUntil, isPinned, isArchived, nickname
        case draft, joinedAt, historyStartSeq
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        role = c.get(.role, "member")
        isAffiliate = c.get(.isAffiliate, false)
        lastReadSeq = c.get(.lastReadSeq, 0)
        unreadCount = c.get(.unreadCount, 0)
        mentionCount = c.get(.mentionCount, 0)
        notificationLevel = c.get(.notificationLevel, "all")
        mutedUntil = c.opt(.mutedUntil)
        isPinned = c.get(.isPinned, false)
        isArchived = c.get(.isArchived, false)
        nickname = c.opt(.nickname)
        draft = c.opt(.draft)
        joinedAt = c.opt(.joinedAt)
        historyStartSeq = c.get(.historyStartSeq, 0)
    }
}

struct LastMessageStub: Codable, Hashable {
    var id: String?
    var seq: Int64
    var type: String
    var senderId: String?
    var preview: String?
    var createdAt: String?

    init(
        id: String? = nil,
        seq: Int64 = 0,
        type: String = "text",
        senderId: String? = nil,
        preview: String? = nil,
        createdAt: String? = nil
    ) {
        self.id = id
        self.seq = seq
        self.type = type
        self.senderId = senderId
        self.preview = preview
        self.createdAt = createdAt
    }

    enum CodingKeys: String, CodingKey { case id, seq, type, senderId, preview, createdAt }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.opt(.id)
        seq = c.get(.seq, 0)
        type = c.get(.type, "text")
        senderId = c.opt(.senderId)
        preview = c.opt(.preview)
        createdAt = c.opt(.createdAt)
    }
}

struct ActiveCall: Codable, Hashable, Identifiable {
    let id: String
    var mode: String
    var participantCount: Int

    enum CodingKeys: String, CodingKey { case id, mode, participantCount }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.get(.id, "")
        mode = c.get(.mode, "audio")
        participantCount = c.get(.participantCount, 0)
    }
}

/// Group flair, set by owners/admins. Rendered wherever the group appears — most
/// importantly the conversation list, which is what makes a customised group
/// feel like *its own place* rather than a row in someone else's app.
struct ConversationAppearance: Codable, Hashable {
    var accent: String?
    /// Two hex stops for a linear gradient ring/tint.
    var gradient: [String]?
    /// none | glow | shimmer
    var effect: String
    var emoji: String?

    var hasFlair: Bool { accent != nil || gradient != nil || emoji != nil || effect != "none" }

    init(accent: String? = nil, gradient: [String]? = nil, effect: String = "none", emoji: String? = nil) {
        self.accent = accent
        self.gradient = gradient
        self.effect = effect
        self.emoji = emoji
    }

    enum CodingKeys: String, CodingKey { case accent, gradient, effect, emoji }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        accent = c.opt(.accent)
        gradient = c.opt(.gradient)
        effect = c.get(.effect, "none")
        emoji = c.opt(.emoji)
    }
}

struct Conversation: Codable, Hashable, Identifiable {
    let id: String
    /// `dm` | `group` | `channel` | `space`. A space holds channels, never messages.
    var type: String
    /// Set on a channel: the space it belongs to.
    var parentId: String?
    /// The space this channel lives in, for the chat header.
    var parentTitle: String?
    var position: Int
    var title: String?
    var description: String?
    var avatarUrl: String?
    var handle: String?
    var isPublic: Bool
    /// A channel that reads as a page of cards rather than a conversation.
    var isBoard: Bool = false
    /// A channel whose top level is a list of titled posts, not a timeline.
    var isForum: Bool = false
    /// Whether this viewer may post here, as the server sees it.
    var canPost: Bool = true
    /// `verified` | `partner` | `staff`, or nil. Groups carry marks too.
    var badge: String?
    var appearance: ConversationAppearance?
    var ownerId: String?
    var memberCount: Int
    /// Members online right now — groups only, 0 for DMs.
    var hereCount: Int
    var memberPreview: [PublicUser]
    var otherUser: PublicUser?
    var latestSeq: Int64
    var lastMessageAt: String?
    var lastMessage: LastMessageStub?
    var disappearingSeconds: Int
    var slowModeSeconds: Int
    /// A campfire's end. Non-null means the whole place is deleted at this
    /// instant — absolute rather than a remaining duration, so an app that
    /// spent an hour in the background never shows a drifted countdown.
    var endsAt: String?
    /// `since_join` | `full`. How much backlog someone joining *now* can read;
    /// changing it never affects members who already joined.
    var historyVisibility: String
    /// The conversation-wide permission floor, decimal-string. Nil means the
    /// per-type default. Distinct from `permissions`, which is what *you* may
    /// do here — an admin's effective bits say nothing about the floor.
    var basePermissions: String?
    /// The group's pet. Fed by conversation; nil on DMs and old payloads.
    var pet: GroupPet?
    /// Decimal-string permission bitfield — see the backend's permissions.ts.
    var permissions: String?
    var activeCall: ActiveCall?
    /// `self` is a Swift keyword, so the stored property is renamed and the
    /// coding key maps it back to the wire name.
    var selfState: SelfState?
    var createdAt: String?

    /// DMs render the other person; groups render their own title.
    var displayName: String {
        type == "dm" ? (otherUser?.label ?? "Direct message") : (title ?? "Group")
    }

    /// A campfire is a group that deletes itself; nothing else about it differs.
    var isCampfire: Bool { endsAt != nil }

    var displayAvatar: String? { type == "dm" ? otherUser?.avatarUrl : avatarUrl }
    var avatarSeed: String { type == "dm" ? (otherUser?.id ?? id) : id }
    /// A space opens its channel list, not a composer.
    var isSpace: Bool { type == "space" }
    var unread: Int { selfState?.unreadCount ?? 0 }
    var isMuted: Bool { selfState?.notificationLevel == "none" || selfState?.mutedUntil != nil }

    enum CodingKeys: String, CodingKey {
        case id, type, parentId, parentTitle, position, title, description
        case avatarUrl, handle, isPublic, isBoard, isForum, canPost, badge, appearance, ownerId
        case memberCount, hereCount, memberPreview, otherUser, latestSeq
        case lastMessageAt, lastMessage, disappearingSeconds, slowModeSeconds
        case endsAt
        case pet
        case historyVisibility, basePermissions, permissions, activeCall, createdAt
        case selfState = "self"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.get(.id, "")
        type = c.get(.type, "group")
        parentId = c.opt(.parentId)
        parentTitle = c.opt(.parentTitle)
        position = c.get(.position, 0)
        title = c.opt(.title)
        description = c.opt(.description)
        avatarUrl = c.opt(.avatarUrl)
        handle = c.opt(.handle)
        isPublic = c.get(.isPublic, false)
        isBoard = c.get(.isBoard, false)
        isForum = c.get(.isForum, false)
        canPost = c.get(.canPost, true)
        badge = c.opt(.badge)
        appearance = c.opt(.appearance)
        ownerId = c.opt(.ownerId)
        memberCount = c.get(.memberCount, 0)
        hereCount = c.get(.hereCount, 0)
        memberPreview = c.list(.memberPreview)
        otherUser = c.opt(.otherUser)
        latestSeq = c.get(.latestSeq, 0)
        lastMessageAt = c.opt(.lastMessageAt)
        lastMessage = c.opt(.lastMessage)
        disappearingSeconds = c.get(.disappearingSeconds, 0)
        slowModeSeconds = c.get(.slowModeSeconds, 0)
        endsAt = c.opt(.endsAt)
        pet = c.opt(.pet)
        historyVisibility = c.get(.historyVisibility, "since_join")
        basePermissions = c.opt(.basePermissions)
        permissions = c.opt(.permissions)
        activeCall = c.opt(.activeCall)
        selfState = c.opt(.selfState)
        createdAt = c.opt(.createdAt)
    }
}

/// The group's pet: a creature whose wellbeing is the group's own activity
/// reflected back at it. Species is not on the wire — it derives from the
/// conversation id, so every client agrees without anyone storing it.
struct GroupPet: Codable, Hashable {
    var name: String?
    /// egg | baby | kid | grown | elder
    var stage: String
    /// happy | hungry | sad | gone
    var mood: String
    var streak: Int
    var fedDays: Int
    var bornAt: String?

    init(
        name: String? = nil,
        stage: String = "egg",
        mood: String = "happy",
        streak: Int = 0,
        fedDays: Int = 0,
        bornAt: String? = nil
    ) {
        self.name = name
        self.stage = stage
        self.mood = mood
        self.streak = streak
        self.fedDays = fedDays
        self.bornAt = bornAt
    }

    enum CodingKeys: String, CodingKey { case name, stage, mood, streak, fedDays, bornAt }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = c.opt(.name)
        stage = c.get(.stage, "egg")
        mood = c.get(.mood, "happy")
        streak = c.get(.streak, 0)
        fedDays = c.get(.fedDays, 0)
        bornAt = c.opt(.bornAt)
    }
}

// ── Catching up ──────────────────────────────────────────────────────────────

/// What you missed while you were away.
///
/// Built from structure, not generated — see the server's `catchUp`. Counts,
/// faces and pictures are things that are simply true; a paragraph describing
/// what was said would be a guess nobody in the conversation could check.
struct CatchUp: Codable, Hashable {
    var since: Int64 = 0
    var upTo: Int64 = 0
    var newMessages: Int = 0
    /// The count is a floor, not a total — show it as "500+".
    var capped: Bool = false
    var participants: [CatchUpParticipant] = []
    var media: [Attachment] = []
    var mentions: [Message] = []
    var pins: [Message] = []

    /// Two unread messages do not need a summary; scrolling past them is
    /// faster than reading a card about them.
    var worthShowing: Bool { newMessages >= 5 || !mentions.isEmpty }
}

struct CatchUpParticipant: Codable, Hashable, Identifiable {
    let user: PublicUser
    var count: Int = 0

    var id: String { user.id }
}

// ── Message parts ────────────────────────────────────────────────────────────

struct Attachment: Codable, Hashable, Identifiable {
    let id: String
    var url: String
    var thumbnailUrl: String?
    var mimeType: String
    var size: Int64
    var width: Int?
    var height: Int?
    var durationMs: Int?
    var blurhash: String?
    var waveform: [Int]?
    var filename: String?
    var caption: String?
    var isSpoiler: Bool

    var isImage: Bool { mimeType.hasPrefix("image/") }

    init(
        id: String,
        url: String,
        thumbnailUrl: String? = nil,
        mimeType: String = "application/octet-stream",
        size: Int64 = 0,
        width: Int? = nil,
        height: Int? = nil,
        durationMs: Int? = nil,
        blurhash: String? = nil,
        waveform: [Int]? = nil,
        filename: String? = nil,
        caption: String? = nil,
        isSpoiler: Bool = false
    ) {
        self.id = id
        self.url = url
        self.thumbnailUrl = thumbnailUrl
        self.mimeType = mimeType
        self.size = size
        self.width = width
        self.height = height
        self.durationMs = durationMs
        self.blurhash = blurhash
        self.waveform = waveform
        self.filename = filename
        self.caption = caption
        self.isSpoiler = isSpoiler
    }

    enum CodingKeys: String, CodingKey {
        case id, url, thumbnailUrl, mimeType, size, width, height
        case durationMs, blurhash, waveform, filename, caption, isSpoiler
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.get(.id, "")
        url = c.get(.url, "")
        thumbnailUrl = c.opt(.thumbnailUrl)
        mimeType = c.get(.mimeType, "application/octet-stream")
        size = c.get(.size, 0)
        width = c.opt(.width)
        height = c.opt(.height)
        durationMs = c.opt(.durationMs)
        blurhash = c.opt(.blurhash)
        waveform = c.opt(.waveform)
        filename = c.opt(.filename)
        caption = c.opt(.caption)
        isSpoiler = c.get(.isSpoiler, false)
    }
}

/// A place, attached to a message.
///
/// `liveUntil` is what makes a share live. The point here is where it *started*
/// — the current position arrives separately, as a `LiveLocation`, because a
/// live share is hundreds of updates and none of them belong in a history row.
struct LocationPayload: Codable, Hashable {
    var latitude: Double
    var longitude: Double
    var name: String?
    var liveUntil: String?
}

/// Where a live share is right now. Replaced on every ping.
struct LiveLocation: Codable, Hashable, Identifiable {
    var messageId: String
    var conversationId: String
    var userId: String
    var latitude: Double
    var longitude: Double
    var accuracy: Double?
    var heading: Double?
    /// Travels with every point, so a client can stop by itself if the socket
    /// goes quiet rather than trusting an end event to arrive.
    var expiresAt: String
    var endedAt: String?
    var updatedAt: String?

    var id: String { messageId }
}

struct LiveLocationsEnvelope: Codable { var locations: [LiveLocation] }

struct GifPayload: Codable, Hashable {
    var provider: String
    var id: String
    var url: String
    var previewUrl: String
    var width: Int
    var height: Int
    var title: String?

    enum CodingKeys: String, CodingKey { case provider, id, url, previewUrl, width, height, title }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        provider = c.get(.provider, "tenor")
        id = c.get(.id, "")
        url = c.get(.url, "")
        previewUrl = c.get(.previewUrl, "")
        width = c.get(.width, 0)
        height = c.get(.height, 0)
        title = c.opt(.title)
    }
}

/// A button a bot attached to its message.
///
/// `customId` is echoed back to the bot on press. It is not a secret: the
/// server authorises a press by conversation membership and by `onlyUserId`.
struct MessageButton: Codable, Hashable, Identifiable {
    var type: String
    var customId: String
    var label: String
    /// primary | secondary | success | danger
    var style: String
    var disabled: Bool
    /// When set, only this person may press it.
    var onlyUserId: String?

    var id: String { customId }

    enum CodingKeys: String, CodingKey { case type, customId, label, style, disabled, onlyUserId }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        type = c.get(.type, "button")
        customId = c.get(.customId, "")
        label = c.get(.label, "")
        style = c.get(.style, "secondary")
        disabled = c.get(.disabled, false)
        onlyUserId = c.opt(.onlyUserId)
    }
}

struct MessageComponentRow: Codable, Hashable, Identifiable {
    var type: String
    var components: [MessageButton]

    /// Rows have no id of their own; the buttons they hold identify them well
    /// enough for a list that never reorders.
    var id: String { components.map(\.customId).joined(separator: "|") }

    enum CodingKeys: String, CodingKey { case type, components }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        type = c.get(.type, "row")
        components = c.list(.components)
    }
}

struct EmbedAuthor: Codable, Hashable {
    var name: String
    var url: String?
    var iconUrl: String?

    enum CodingKeys: String, CodingKey { case name, url, iconUrl }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = c.get(.name, "")
        url = c.opt(.url)
        iconUrl = c.opt(.iconUrl)
    }
}

struct EmbedField: Codable, Hashable, Identifiable {
    var name: String
    var value: String
    var inline: Bool

    var id: String { name + value }

    enum CodingKeys: String, CodingKey { case name, value, inline }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = c.get(.name, "")
        value = c.get(.value, "")
        inline = c.get(.inline, false)
    }
}

struct EmbedMedia: Codable, Hashable {
    var url: String

    enum CodingKeys: String, CodingKey { case url }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        url = c.get(.url, "")
    }
}

struct EmbedFooter: Codable, Hashable {
    var text: String
    var iconUrl: String?

    enum CodingKeys: String, CodingKey { case text, iconUrl }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        text = c.get(.text, "")
        iconUrl = c.opt(.iconUrl)
    }
}

/// line | area | bar | pie | donut | scatter, with 2..24 labelled points.
struct EmbedChart: Codable, Hashable {
    var kind: String
    var points: [EmbedChartPoint]

    enum CodingKeys: String, CodingKey { case kind, points }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = c.get(.kind, "line")
        points = c.list(.points)
    }
}

struct EmbedChartPoint: Codable, Hashable {
    var label: String
    var value: Double

    enum CodingKeys: String, CodingKey { case label, value }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        label = c.get(.label, "")
        value = c.get(.value, 0)
    }
}

/// The group an invite link points at.
///
/// Resolved per read, so `memberCount` is current and a group that has since
/// been deleted arrives as nil rather than as a card offering to join it.
struct EmbedInvite: Codable, Hashable {
    var code: String
    var type: String
    var title: String?
    var description: String?
    var badge: String?
    var memberCount: Int
    var avatarUrl: String?

    enum CodingKeys: String, CodingKey { case code, type, title, description, badge, memberCount, avatarUrl }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        code = c.get(.code, "")
        type = c.get(.type, "group")
        title = c.opt(.title)
        description = c.opt(.description)
        badge = c.opt(.badge)
        memberCount = c.get(.memberCount, 0)
        avatarUrl = c.opt(.avatarUrl)
    }
}

/// A rich card. Two origins, one shape: `rich` was posted by a bot, `link` was
/// built by the worker from a URL someone pasted. Rendered identically.
struct Embed: Codable, Hashable, Identifiable {
    var type: String
    var title: String?
    var description: String?
    var url: String?
    /// #RRGGBB accent for the left bar.
    var color: String?
    /// Site name, for link embeds.
    var provider: String?
    var author: EmbedAuthor?
    var fields: [EmbedField]
    var image: EmbedMedia?
    var thumbnail: EmbedMedia?
    var footer: EmbedFooter?
    var timestamp: String?
    /// Inline data chart. Senders put a text fallback in the description.
    var chart: EmbedChart?
    /// A trusted treatment, currently only `announcement`. Never render on this
    /// alone: the server strips it from anyone who is not a badged bot, and the
    /// client checks the sender independently, because a card claiming to be
    /// from us must not be something a third-party bot can mint. See
    /// `EmbedCard`'s `trusted` parameter.
    var kind: String?
    /// Set when this link is a yappy invite, resolved by the server from the
    /// group itself rather than by fetching the page. Nil on every other link,
    /// which is what keeps the ordinary preview rendering untouched.
    var invite: EmbedInvite?

    var id: String { (url ?? "") + (title ?? "") + (description ?? "") }

    enum CodingKeys: String, CodingKey {
        case type, title, description, url, color, provider, author
        case fields, image, thumbnail, footer, timestamp, chart, kind, invite
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        type = c.get(.type, "rich")
        title = c.opt(.title)
        description = c.opt(.description)
        url = c.opt(.url)
        color = c.opt(.color)
        provider = c.opt(.provider)
        author = c.opt(.author)
        fields = c.list(.fields)
        image = c.opt(.image)
        thumbnail = c.opt(.thumbnail)
        footer = c.opt(.footer)
        timestamp = c.opt(.timestamp)
        chart = c.opt(.chart)
        kind = c.opt(.kind)
        invite = c.opt(.invite)
    }
}

/// A sticker on a message, image included. Lighter than `Sticker` (no pack
/// bookkeeping) because a message only needs to draw it.
struct MessageSticker: Codable, Hashable {
    let id: String
    var emoji: String?
    var name: String?
    var url: String?
}

/// Who a forwarded message was forwarded from. The name fields are captured at
/// serialization time on the server; either may be nil if the account has gone.
struct ForwardedFrom: Codable, Hashable {
    let userId: String
    var username: String?
    var displayName: String?

    /// "Haider", else "@yap", else a neutral fallback for deleted accounts.
    var label: String {
        if let displayName, !displayName.isEmpty { return displayName }
        if let username, !username.isEmpty { return "@\(username)" }
        return "someone"
    }
}

struct ReplyStub: Codable, Hashable, Identifiable {
    let id: String
    var seq: Int64
    var senderId: String?
    var preview: String?
    var type: String

    init(id: String, seq: Int64 = 0, senderId: String? = nil, preview: String? = nil, type: String = "text") {
        self.id = id
        self.seq = seq
        self.senderId = senderId
        self.preview = preview
        self.type = type
    }

    enum CodingKeys: String, CodingKey { case id, seq, senderId, preview, type }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.get(.id, "")
        seq = c.get(.seq, 0)
        senderId = c.opt(.senderId)
        preview = c.opt(.preview)
        type = c.get(.type, "text")
    }
}

struct PollOption: Codable, Hashable, Identifiable {
    let id: String
    var label: String
    var position: Int
    var voteCount: Int

    enum CodingKeys: String, CodingKey { case id, label, position, voteCount }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.get(.id, "")
        label = c.get(.label, "")
        position = c.get(.position, 0)
        voteCount = c.get(.voteCount, 0)
    }
}

struct Poll: Codable, Hashable, Identifiable {
    let id: String
    var question: String
    var multiSelect: Bool
    var isAnonymous: Bool
    var closesAt: String?
    var closedAt: String?
    var totalVoters: Int
    var options: [PollOption]
    var myVotes: [String]

    var isClosed: Bool { closedAt != nil }

    enum CodingKeys: String, CodingKey {
        case id, question, multiSelect, isAnonymous, closesAt, closedAt
        case totalVoters, options, myVotes
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.get(.id, "")
        question = c.get(.question, "")
        multiSelect = c.get(.multiSelect, false)
        isAnonymous = c.get(.isAnonymous, false)
        closesAt = c.opt(.closesAt)
        closedAt = c.opt(.closedAt)
        totalVoters = c.get(.totalVoters, 0)
        options = c.list(.options)
        myVotes = c.list(.myVotes)
    }
}

struct CallSummary: Codable, Hashable {
    var callId: String
    var mode: String
    var outcome: String
    var durationSeconds: Int

    enum CodingKeys: String, CodingKey { case callId, mode, outcome, durationSeconds }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        callId = c.get(.callId, "")
        mode = c.get(.mode, "audio")
        outcome = c.get(.outcome, "completed")
        durationSeconds = c.get(.durationSeconds, 0)
    }
}

struct SystemPayload: Codable, Hashable {
    var event: String
    var actorId: String?
    var targetIds: [String]
    var value: String?

    enum CodingKeys: String, CodingKey { case event, actorId, targetIds, value }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        event = c.get(.event, "")
        actorId = c.opt(.actorId)
        targetIds = c.list(.targetIds)
        value = c.opt(.value)
    }
}

// ── Message ──────────────────────────────────────────────────────────────────

struct Message: Codable, Hashable, Identifiable {
    /// Local-only sentinel for a message the user has sent that the server has
    /// not confirmed.
    static let pendingSeq: Int64 = -1

    let id: String
    var conversationId: String
    var seq: Int64
    var type: String
    var content: String?
    /// The body is in `ciphertext`; `content` holds the notice.
    var isEncrypted: Bool = false
    /// This device's copy, or nil when it was not a recipient.
    var ciphertext: String?
    var entities: [JSONValue]?
    var sender: PublicUser?
    var senderId: String?
    /// The sender's top role colour *in this conversation*, if any.
    var senderRoleColor: String?
    var senderRoleName: String?
    var replyTo: ReplyStub?
    var threadRootId: String?
    var threadReplyCount: Int
    /// A forum post's title. Nil on every other kind of message.
    var title: String?
    /// Attribution on a forwarded copy — who actually said it.
    var forwardedFrom: ForwardedFrom?
    var attachments: [Attachment]
    var stickerId: String?
    /// The sticker with its image URL, resolved server-side. `stickerId` alone
    /// was only renderable by clients that had the pack installed.
    var sticker: MessageSticker?
    var gif: GifPayload?
    /// Where the share started. `liveUntil` set means it is still moving.
    var location: LocationPayload?
    var poll: Poll?
    var embeds: [Embed]
    var components: [MessageComponentRow]
    var callSummary: CallSummary?
    var system: SystemPayload?
    /// Names for the ids inside `system`, resolved by the server.
    ///
    /// The roster is loaded after the timeline, so resolving these client-side
    /// meant every system line read "Someone added someone" until the members
    /// request came back — and stayed that way forever for anybody who had left
    /// the group, since they are in no roster to look up.
    var systemNames: [String: String]?
    /// Names and colours for the roles this message mentions, by role id.
    ///
    /// The entity carries an id rather than a name, so a renamed role does
    /// not leave old messages saying the old thing. This is how the id
    /// becomes something to draw, without every client having to hold the
    /// space's whole role list before it can render a line of text.
    var mentionedRoles: [String: MentionedRole]?
    /// emoji → count, maintained server-side by trigger.
    var reactions: [String: Int]
    var myReactions: [String]
    var isPinned: Bool
    var silent: Bool
    var editedAt: String?
    var expiresAt: String?
    var deletedAt: String?
    var createdAt: String
    var nonce: String?

    var isDeleted: Bool { deletedAt != nil }
    var isSystem: Bool { type == "system" }

    /// Rendered at reduced opacity with a clock icon.
    var isPending: Bool { seq == Message.pendingSeq }

    /// The first still image on the message, if any — what a tap opens in the
    /// viewer. GIFs are excluded: they are not stills and the viewer would show
    /// them frozen.
    var firstImage: Attachment? { attachments.first(where: \.isImage) }

    init(
        id: String,
        conversationId: String,
        seq: Int64,
        type: String = "text",
        content: String? = nil,
        entities: [JSONValue]? = nil,
        sender: PublicUser? = nil,
        senderId: String? = nil,
        senderRoleColor: String? = nil,
        senderRoleName: String? = nil,
        replyTo: ReplyStub? = nil,
        threadRootId: String? = nil,
        threadReplyCount: Int = 0,
        title: String? = nil,
        attachments: [Attachment] = [],
        stickerId: String? = nil,
        gif: GifPayload? = nil,
        location: LocationPayload? = nil,
        poll: Poll? = nil,
        embeds: [Embed] = [],
        components: [MessageComponentRow] = [],
        callSummary: CallSummary? = nil,
        system: SystemPayload? = nil,
        systemNames: [String: String]? = nil,
        mentionedRoles: [String: MentionedRole]? = nil,
        mentionedChannels: [String: MentionedChannel]? = nil,
        reactions: [String: Int] = [:],
        myReactions: [String] = [],
        isPinned: Bool = false,
        silent: Bool = false,
        editedAt: String? = nil,
        expiresAt: String? = nil,
        deletedAt: String? = nil,
        createdAt: String,
        nonce: String? = nil
    ) {
        self.id = id
        self.conversationId = conversationId
        self.seq = seq
        self.type = type
        self.content = content
        self.entities = entities
        self.sender = sender
        self.senderId = senderId
        self.senderRoleColor = senderRoleColor
        self.senderRoleName = senderRoleName
        self.replyTo = replyTo
        self.threadRootId = threadRootId
        self.threadReplyCount = threadReplyCount
        self.title = title
        self.attachments = attachments
        self.stickerId = stickerId
        self.gif = gif
        self.location = location
        self.poll = poll
        self.embeds = embeds
        self.components = components
        self.callSummary = callSummary
        self.system = system
        self.systemNames = systemNames
        self.mentionedRoles = mentionedRoles
        self.mentionedChannels = mentionedChannels
        self.reactions = reactions
        self.myReactions = myReactions
        self.isPinned = isPinned
        self.silent = silent
        self.editedAt = editedAt
        self.expiresAt = expiresAt
        self.deletedAt = deletedAt
        self.createdAt = createdAt
        self.nonce = nonce
    }

    enum CodingKeys: String, CodingKey {
        case id, conversationId, seq, type, content, entities, sender, senderId
        case isEncrypted, ciphertext
        case senderRoleColor, senderRoleName, replyTo, threadRootId, threadReplyCount, title
        case forwardedFrom
        case attachments, stickerId, sticker, gif, location, poll, embeds, components, callSummary
        case system, systemNames, mentionedRoles, reactions, myReactions, isPinned, silent, editedAt
        case expiresAt, deletedAt, createdAt, nonce
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.get(.id, "")
        conversationId = c.get(.conversationId, "")
        seq = c.get(.seq, 0)
        type = c.get(.type, "text")
        content = c.opt(.content)
        isEncrypted = c.get(.isEncrypted, false)
        ciphertext = c.opt(.ciphertext)
        entities = c.opt(.entities)
        sender = c.opt(.sender)
        senderId = c.opt(.senderId)
        senderRoleColor = c.opt(.senderRoleColor)
        senderRoleName = c.opt(.senderRoleName)
        replyTo = c.opt(.replyTo)
        threadRootId = c.opt(.threadRootId)
        threadReplyCount = c.get(.threadReplyCount, 0)
        title = c.opt(.title)
        forwardedFrom = c.opt(.forwardedFrom)
        attachments = c.list(.attachments)
        stickerId = c.opt(.stickerId)
        sticker = c.opt(.sticker)
        gif = c.opt(.gif)
        location = c.opt(.location)
        poll = c.opt(.poll)
        embeds = c.list(.embeds)
        components = c.list(.components)
        callSummary = c.opt(.callSummary)
        system = c.opt(.system)
        systemNames = c.opt(.systemNames)
        mentionedRoles = c.opt(.mentionedRoles)
        reactions = c.get(.reactions, [:])
        myReactions = c.list(.myReactions)
        isPinned = c.get(.isPinned, false)
        silent = c.get(.silent, false)
        editedAt = c.opt(.editedAt)
        expiresAt = c.opt(.expiresAt)
        deletedAt = c.opt(.deletedAt)
        createdAt = c.get(.createdAt, "")
        nonce = c.opt(.nonce)
    }
}

// ── Stickers, GIFs ───────────────────────────────────────────────────────────

struct Sticker: Codable, Hashable, Identifiable {
    let id: String
    var emoji: String
    var name: String?
    var position: Int
    var url: String

    enum CodingKeys: String, CodingKey { case id, emoji, name, position, url }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.get(.id, "")
        emoji = c.get(.emoji, "")
        name = c.opt(.name)
        position = c.get(.position, 0)
        url = c.get(.url, "")
    }
}

struct StickerPack: Codable, Hashable, Identifiable {
    let id: String
    var slug: String
    var name: String
    var description: String?
    var coverUrl: String?
    var isAnimated: Bool
    var isOfficial: Bool
    var stickerCount: Int
    var installCount: Int
    var isInstalled: Bool
    var stickers: [Sticker]

    enum CodingKeys: String, CodingKey {
        case id, slug, name, description, coverUrl, isAnimated, isOfficial
        case stickerCount, installCount, isInstalled, stickers
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.get(.id, "")
        slug = c.get(.slug, "")
        name = c.get(.name, "")
        description = c.opt(.description)
        coverUrl = c.opt(.coverUrl)
        isAnimated = c.get(.isAnimated, false)
        isOfficial = c.get(.isOfficial, false)
        stickerCount = c.get(.stickerCount, 0)
        installCount = c.get(.installCount, 0)
        isInstalled = c.get(.isInstalled, false)
        stickers = c.list(.stickers)
    }
}

struct GifResult: Codable, Hashable, Identifiable {
    let id: String
    var provider: String
    var url: String
    var previewUrl: String
    var width: Int
    var height: Int
    var title: String

    /// Tenor and the recents list can both return the same GIF, so the provider
    /// has to be part of the identity or SwiftUI sees a duplicate key.
    var listId: String { "\(provider):\(id)" }

    enum CodingKeys: String, CodingKey { case id, provider, url, previewUrl, width, height, title }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.get(.id, "")
        provider = c.get(.provider, "tenor")
        url = c.get(.url, "")
        previewUrl = c.get(.previewUrl, "")
        width = c.get(.width, 0)
        height = c.get(.height, 0)
        title = c.get(.title, "")
    }
}

// ── Calls ────────────────────────────────────────────────────────────────────

struct CallParticipant: Codable, Hashable, Identifiable {
    var user: PublicUser
    var state: String
    var isMuted: Bool
    var isVideoEnabled: Bool
    var isScreenSharing: Bool

    var id: String { user.id }

    enum CodingKeys: String, CodingKey { case user, state, isMuted, isVideoEnabled, isScreenSharing }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        user = c.get(.user, PublicUser(id: ""))
        state = c.get(.state, "invited")
        isMuted = c.get(.isMuted, false)
        isVideoEnabled = c.get(.isVideoEnabled, false)
        isScreenSharing = c.get(.isScreenSharing, false)
    }
}

struct Call: Codable, Hashable, Identifiable {
    let id: String
    var conversationId: String?
    var initiatorId: String?
    var mode: String
    var state: String
    var roomName: String
    var ringExpiresAt: String?
    var startedAt: String?
    var endedAt: String?
    var endReason: String?
    var durationSeconds: Int?
    var participants: [CallParticipant]
    var createdAt: String?

    enum CodingKeys: String, CodingKey {
        case id, conversationId, initiatorId, mode, state, roomName
        case ringExpiresAt, startedAt, endedAt, endReason, durationSeconds
        case participants, createdAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.get(.id, "")
        conversationId = c.opt(.conversationId)
        initiatorId = c.opt(.initiatorId)
        mode = c.get(.mode, "audio")
        state = c.get(.state, "ringing")
        roomName = c.get(.roomName, "")
        ringExpiresAt = c.opt(.ringExpiresAt)
        startedAt = c.opt(.startedAt)
        endedAt = c.opt(.endedAt)
        endReason = c.opt(.endReason)
        durationSeconds = c.opt(.durationSeconds)
        participants = c.list(.participants)
        createdAt = c.opt(.createdAt)
    }
}

// ── Roles, channels, members ─────────────────────────────────────────────────

/// A named role. `permissions` is a decimal *string* — the bitfield runs past
/// bit 62 and an Int64 would be fine, but the wire format is shared with clients
/// whose numbers are doubles, so it stays text everywhere.
/// A role as a message names it: enough to draw `@Premium` in its own colour,
/// and nothing else. The full `RoleEntry` rides on member lists and role
/// settings; a timeline needs neither the permissions nor the position.
struct MentionedRole: Codable, Hashable {
    var name: String
    var color: String?
}

struct RoleEntry: Codable, Hashable, Identifiable {
    let id: String
    var name: String
    var color: String?
    var permissions: String
    var position: Int
    var isHoisted: Bool
    var isMentionable: Bool

    enum CodingKeys: String, CodingKey {
        case id, name, color, permissions, position, isHoisted, isMentionable
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.get(.id, "")
        name = c.get(.name, "")
        color = c.opt(.color)
        permissions = c.get(.permissions, "0")
        position = c.get(.position, 0)
        isHoisted = c.get(.isHoisted, false)
        isMentionable = c.get(.isMentionable, false)
    }
}

/// One channel inside a space, as its list renders it.
struct ChannelEntry: Codable, Hashable, Identifiable {
    let id: String
    var title: String?
    var description: String?
    var position: Int
    var latestSeq: Int64
    var lastMessageAt: String?
    var lastMessagePreview: String?
    var unreadCount: Int
    var mentionCount: Int
    /// Inherited from the space until this channel is given its own.
    var notificationLevel: String
    var isMuted: Bool
    var isAnnouncement: Bool
    /**
     * A channel that reads as a page of cards rather than a conversation.
     *
     * Same messages and same permissions — what changes is the posture: cards
     * full width, oldest first, and an edit that does not move anything, so a
     * card rewriting itself stays where the reader left it.
     */
    var isBoard: Bool
    /// A list of titled posts rather than a timeline.
    var isForum: Bool
    /// Closed to the space until a role overwrite lets somebody back in.
    var isPrivate: Bool

    enum CodingKeys: String, CodingKey {
        case id, title, description, position, latestSeq, lastMessageAt
        case lastMessagePreview, unreadCount, mentionCount, notificationLevel
        case isMuted, isAnnouncement, isBoard, isForum, isPrivate
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.get(.id, "")
        title = c.opt(.title)
        description = c.opt(.description)
        position = c.get(.position, 0)
        latestSeq = c.get(.latestSeq, 0)
        lastMessageAt = c.opt(.lastMessageAt)
        lastMessagePreview = c.opt(.lastMessagePreview)
        unreadCount = c.get(.unreadCount, 0)
        mentionCount = c.get(.mentionCount, 0)
        notificationLevel = c.get(.notificationLevel, "all")
        isMuted = c.get(.isMuted, false)
        isAnnouncement = c.get(.isAnnouncement, false)
        isBoard = c.get(.isBoard, false)
        isForum = c.get(.isForum, false)
        isPrivate = c.get(.isPrivate, false)
    }
}

struct MemberEntry: Codable, Hashable, Identifiable {
    var user: PublicUser
    var role: String
    /// Highest-positioned first.
    var roles: [RoleEntry]
    /// The top role that specifies a colour, if any.
    var roleColor: String?
    /// This group's half of an affiliation, whether or not the member displays it.
    var isAffiliate: Bool
    var nickname: String?
    var mutedUntil: String?
    var joinedAt: String?
    var lastReadSeq: Int64

    var id: String { user.id }

    enum CodingKeys: String, CodingKey {
        case user, role, roles, roleColor, isAffiliate, nickname
        case mutedUntil, joinedAt, lastReadSeq
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        user = c.get(.user, PublicUser(id: ""))
        role = c.get(.role, "member")
        roles = c.list(.roles)
        roleColor = c.opt(.roleColor)
        isAffiliate = c.get(.isAffiliate, false)
        nickname = c.opt(.nickname)
        mutedUntil = c.opt(.mutedUntil)
        joinedAt = c.opt(.joinedAt)
        lastReadSeq = c.get(.lastReadSeq, 0)
    }
}

struct PinEntry: Codable, Hashable, Identifiable {
    var message: Message
    var position: Int
    var pinnedAt: String?

    var id: String { message.id }

    enum CodingKeys: String, CodingKey { case message, position, pinnedAt }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        message = try c.decode(Message.self, forKey: .message)
        position = c.get(.position, 0)
        pinnedAt = c.opt(.pinnedAt)
    }
}

/// A member as the group profile sees them: identity plus live presence.
struct SummaryMember: Codable, Hashable, Identifiable {
    var user: PublicUser
    var role: String
    var roles: [RoleEntry]
    var roleColor: String?
    var isAffiliate: Bool
    var nickname: String?
    var presence: String

    var id: String { user.id }
    var isHere: Bool { presence != "offline" }

    enum CodingKeys: String, CodingKey {
        case user, role, roles, roleColor, isAffiliate, nickname, presence
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        user = c.get(.user, PublicUser(id: ""))
        role = c.get(.role, "member")
        roles = c.list(.roles)
        roleColor = c.opt(.roleColor)
        isAffiliate = c.get(.isAffiliate, false)
        nickname = c.opt(.nickname)
        presence = c.get(.presence, "offline")
    }
}

struct SummaryCounts: Codable, Hashable {
    var media: Int
    var pins: Int

    init(media: Int = 0, pins: Int = 0) {
        self.media = media
        self.pins = pins
    }

    enum CodingKeys: String, CodingKey { case media, pins }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        media = c.get(.media, 0)
        pins = c.get(.pins, 0)
    }
}

struct GroupSummary: Codable, Hashable {
    var members: [SummaryMember]
    var onlineCount: Int
    var counts: SummaryCounts
    var activeCall: ActiveCall?

    enum CodingKeys: String, CodingKey { case members, onlineCount, counts, activeCall }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        members = c.list(.members)
        onlineCount = c.get(.onlineCount, 0)
        counts = c.get(.counts, SummaryCounts())
        activeCall = c.opt(.activeCall)
    }
}

/// One person you already know inside a group — GET /conversations/:id/mutuals.
struct KnownPerson: Codable, Hashable, Identifiable {
    let id: String
    var username: String?
    var displayName: String?
    var avatarUrl: String?
    var isVerified: Bool
    /// `mutual` | `following` | `contact`, strongest first.
    var connection: String

    var label: String { displayName ?? username.map { "@\($0)" } ?? "Someone" }

    enum CodingKeys: String, CodingKey {
        case id, username, displayName, avatarUrl, isVerified, connection
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.get(.id, "")
        username = c.opt(.username)
        displayName = c.opt(.displayName)
        avatarUrl = c.opt(.avatarUrl)
        isVerified = c.get(.isVerified, false)
        connection = c.get(.connection, "contact")
    }
}

struct KnownPeople: Codable, Hashable {
    var people: [KnownPerson]
    var total: Int

    enum CodingKeys: String, CodingKey { case people, total }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        people = c.list(.people)
        total = c.get(.total, 0)
    }
}

/// A bot in the public directory.
///
/// `botUserId` is what you add to a conversation. The application `id` is the
/// developer-side record and is no use for adding.
struct DirectoryBot: Codable, Hashable, Identifiable {
    let id: String
    var botUserId: String
    var name: String
    var description: String?
    var commandCount: Int
    var user: PublicUser?

    enum CodingKeys: String, CodingKey {
        case id, botUserId, name, description, commandCount, user
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.get(.id, "")
        botUserId = c.get(.botUserId, "")
        name = c.get(.name, "Bot")
        description = c.opt(.description)
        commandCount = c.get(.commandCount, 0)
        user = c.opt(.user)
    }
}

struct BotDirectory: Codable, Hashable {
    var bots: [DirectoryBot]

    enum CodingKeys: String, CodingKey { case bots }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        bots = c.list(.bots)
    }
}

/// Who has a conversation open right now. Live changes arrive as events.
struct ViewersEnvelope: Codable, Hashable {
    var userIds: [String]

    enum CodingKeys: String, CodingKey { case userIds }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        userIds = c.list(.userIds)
    }
}

// ── Account & discovery ──────────────────────────────────────────────────────

struct DeviceEntry: Codable, Hashable, Identifiable {
    let id: String
    var name: String?
    var platform: String
    var appVersion: String?
    var osVersion: String?
    var lastIp: String?
    var lastActiveAt: String?
    var createdAt: String?
    var pushEnabled: Bool
    var isCurrent: Bool

    enum CodingKeys: String, CodingKey {
        case id, name, platform, appVersion, osVersion, lastIp
        case lastActiveAt, createdAt, pushEnabled, isCurrent
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.get(.id, "")
        name = c.opt(.name)
        platform = c.get(.platform, "ios")
        appVersion = c.opt(.appVersion)
        osVersion = c.opt(.osVersion)
        lastIp = c.opt(.lastIp)
        lastActiveAt = c.opt(.lastActiveAt)
        createdAt = c.opt(.createdAt)
        pushEnabled = c.get(.pushEnabled, false)
        isCurrent = c.get(.isCurrent, false)
    }
}

struct SearchHit: Codable, Hashable, Identifiable {
    var messageId: String
    var conversationId: String
    var seq: Int64
    var senderId: String?
    var type: String
    var snippet: String
    var createdAt: String

    var id: String { messageId }

    enum CodingKeys: String, CodingKey {
        case messageId, conversationId, seq, senderId, type, snippet, createdAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        messageId = c.get(.messageId, "")
        conversationId = c.get(.conversationId, "")
        seq = c.get(.seq, 0)
        senderId = c.opt(.senderId)
        type = c.get(.type, "text")
        snippet = c.get(.snippet, "")
        createdAt = c.get(.createdAt, "")
    }
}

struct BadgeCounts: Codable, Hashable {
    var unreadMessages: Int
    var unreadMentions: Int
    var unreadConversations: Int

    enum CodingKeys: String, CodingKey { case unreadMessages, unreadMentions, unreadConversations }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        unreadMessages = c.get(.unreadMessages, 0)
        unreadMentions = c.get(.unreadMentions, 0)
        unreadConversations = c.get(.unreadConversations, 0)
    }
}

struct DiscoverEntry: Codable, Hashable, Identifiable {
    let id: String
    var type: String
    var title: String?
    var description: String?
    var handle: String?
    var memberCount: Int
    var avatarUrl: String?
    /// `verified` | `partner` | `staff`, or nil.
    var badge: String?
    /// Members present right now — the warmth signal a directory ranks by.
    var hereCount: Int
    /// A call is happening in there as you look.
    var live: Bool
    var createdAt: String?
    var appearance: ConversationAppearance?

    enum CodingKeys: String, CodingKey {
        case id, type, title, description, handle, memberCount, avatarUrl
        case badge, hereCount, live, createdAt, appearance
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.get(.id, "")
        type = c.get(.type, "group")
        title = c.opt(.title)
        description = c.opt(.description)
        handle = c.opt(.handle)
        memberCount = c.get(.memberCount, 0)
        avatarUrl = c.opt(.avatarUrl)
        badge = c.opt(.badge)
        hereCount = c.get(.hereCount, 0)
        live = c.get(.live, false)
        createdAt = c.opt(.createdAt)
        appearance = c.opt(.appearance)
    }
}

/// A slash command a bot in this conversation answers.
struct BotCommand: Codable, Hashable, Identifiable {
    var name: String
    var description: String
    var usage: String
    var botId: String?
    var botUsername: String?
    /// So a picker with several bots can say whose command each one is.
    var botAvatarUrl: String?

    var id: String { (botId ?? "") + name }

    enum CodingKeys: String, CodingKey { case name, description, usage, botId, botUsername, botAvatarUrl }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = c.get(.name, "")
        description = c.get(.description, "")
        usage = c.get(.usage, "")
        botId = c.opt(.botId)
        botUsername = c.opt(.botUsername)
        botAvatarUrl = c.opt(.botAvatarUrl)
    }
}

/// Enough of a role to say what a link grants: a name and its colour.
struct InviteRole: Codable, Hashable {
    var id: String?
    var name: String = ""
    var color: String?
}

struct Invite: Codable, Hashable, Identifiable {
    var code: String
    var url: String
    var maxUses: Int
    var uses: Int
    var expiresAt: String?
    /// The role this link hands to whoever redeems it, if any.
    var role: InviteRole?

    var id: String { code }

    enum CodingKeys: String, CodingKey { case code, url, maxUses, uses, expiresAt, role }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        code = c.get(.code, "")
        url = c.get(.url, "")
        maxUses = c.get(.maxUses, 0)
        uses = c.get(.uses, 0)
        expiresAt = c.opt(.expiresAt)
        role = c.opt(.role)
    }
}

/// The group behind an invite code, as the preview endpoint describes it.
///
/// A trimmed shape rather than a `Conversation`: the server deliberately sends
/// only what a non-member may see, and decoding it as a full conversation would
/// invent memberships and read state that do not exist yet.
struct InvitePreview: Decodable {
    struct Target: Decodable {
        let id: String
        var type: String
        var title: String?
        var description: String?
        var memberCount: Int
        var avatarUrl: String?

        enum CodingKeys: String, CodingKey { case id, type, title, description, memberCount, avatarUrl }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = c.get(.id, "")
            type = c.get(.type, "group")
            title = c.opt(.title)
            description = c.opt(.description)
            memberCount = c.get(.memberCount, 0)
            avatarUrl = c.opt(.avatarUrl)
        }
    }

    var conversation: Target
    /// Nil for an unlimited invite.
    var usesRemaining: Int?
    /// What joining hands you. Named on the preview because it changes the
    /// decision: "join" and "join as Premium" are different offers.
    var grantsRole: InviteRole?

    enum CodingKeys: String, CodingKey { case conversation, usesRemaining }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        conversation = try c.decode(Target.self, forKey: .conversation)
        usesRemaining = c.opt(.usesRemaining)
    }
}

/// Joining answers with the whole conversation when you are new to it and just
/// an id when you were already a member, so both shapes are accepted.
///
/// `Decodable` only: `conversation` is a coding key with no matching property,
/// so there is nothing coherent to encode back.
struct JoinResult: Decodable {
    var conversationId: String
    var alreadyMember: Bool
    /// A space is a container of channels and has no timeline of its own, so
    /// joining one has to open the channel list rather than a chat.
    var isSpace: Bool

    enum CodingKeys: String, CodingKey { case conversationId, conversation, alreadyMember }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        isSpace = false
        if let id: String = c.opt(.conversationId) {
            conversationId = id
        } else if let conversation = try? c.decode(Conversation.self, forKey: .conversation) {
            conversationId = conversation.id
            isSpace = conversation.type == "space"
        } else {
            throw DecodingError.dataCorruptedError(
                forKey: .conversationId,
                in: c,
                debugDescription: "Join returned neither a conversation nor an id"
            )
        }
        alreadyMember = c.get(.alreadyMember, false)
    }
}

struct OnlineEntry: Codable, Hashable, Identifiable {
    var user: PublicUser
    var status: String

    var id: String { user.id }

    enum CodingKeys: String, CodingKey { case user, status }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        user = c.get(.user, PublicUser(id: ""))
        status = c.get(.status, "online")
    }
}

/// The presigned PUT the server hands back — valid for `expiresIn` seconds.
struct UploadTarget: Codable, Hashable {
    var url: String
    var method: String
    var headers: [String: String]
    var expiresIn: Int

    enum CodingKeys: String, CodingKey { case url, method, headers, expiresIn }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        url = c.get(.url, "")
        method = c.get(.method, "PUT")
        headers = c.get(.headers, [:])
        expiresIn = c.get(.expiresIn, 900)
    }
}

struct ReactionDetail: Codable, Hashable, Identifiable {
    var emoji: String
    var user: PublicUser
    var reactedAt: String?

    var id: String { emoji + user.id }

    enum CodingKeys: String, CodingKey { case emoji, user, reactedAt }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        emoji = c.get(.emoji, "")
        user = c.get(.user, PublicUser(id: ""))
        reactedAt = c.opt(.reactedAt)
    }
}

// ── Envelopes ────────────────────────────────────────────────────────────────

struct AuthTokens: Codable {
    var accessToken: String
    var refreshToken: String
    var expiresIn: Int
    var deviceId: String?
    var user: FullUser?
    var needsOnboarding: Bool

    enum CodingKeys: String, CodingKey {
        case accessToken, refreshToken, expiresIn, deviceId, user, needsOnboarding
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        accessToken = try c.decode(String.self, forKey: .accessToken)
        refreshToken = try c.decode(String.self, forKey: .refreshToken)
        expiresIn = c.get(.expiresIn, 900)
        deviceId = c.opt(.deviceId)
        user = c.opt(.user)
        needsOnboarding = c.get(.needsOnboarding, false)
    }
}

struct RefreshResponse: Codable {
    var accessToken: String
    var refreshToken: String
    var expiresIn: Int

    enum CodingKeys: String, CodingKey { case accessToken, refreshToken, expiresIn }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        accessToken = try c.decode(String.self, forKey: .accessToken)
        refreshToken = try c.decode(String.self, forKey: .refreshToken)
        expiresIn = c.get(.expiresIn, 900)
    }
}

struct GatewayTicket: Codable {
    var ticket: String
    var url: String
    var expiresIn: Int

    enum CodingKeys: String, CodingKey { case ticket, url, expiresIn }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ticket = c.get(.ticket, "")
        url = c.get(.url, "")
        expiresIn = c.get(.expiresIn, 60)
    }
}

struct UsernameAvailability: Codable {
    var available: Bool
    var reason: String?

    enum CodingKeys: String, CodingKey { case available, reason }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        available = c.get(.available, false)
        reason = c.opt(.reason)
    }
}

struct UserEnvelope: Codable { var user: FullUser }

/// What POST/DELETE /social/follow/:id answers with. `isMutual` is absent on
/// the delete (unfollowing cannot make a pair), so it defaults to false.
struct FollowResult: Codable {
    var following: Bool
    var isMutual: Bool

    enum CodingKeys: String, CodingKey { case following, isMutual }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        following = c.get(.following, false)
        isMutual = c.get(.isMutual, false)
    }
}
struct ConversationEnvelope: Codable { var conversation: Conversation }
struct MessageEnvelope: Codable { var message: Message }
struct MediaEnvelope: Codable { var media: Attachment }
struct RoleEnvelope: Codable { var role: RoleEntry }
struct ChannelEnvelope: Codable { var channel: Conversation }
struct SummaryEnvelope: Codable { var summary: GroupSummary }
struct InviteEnvelope: Codable { var invite: Invite }

struct UpgradeEnvelope: Codable {
    var space: Conversation
    var channel: Conversation
}

struct UsersEnvelope: Codable {
    var users: [PublicUser]
    var nextCursor: String?

    enum CodingKeys: String, CodingKey { case users, nextCursor }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        users = c.list(.users)
        nextCursor = c.opt(.nextCursor)
    }
}

struct ConversationsEnvelope: Codable {
    var conversations: [Conversation]
    var nextCursor: String?

    enum CodingKeys: String, CodingKey { case conversations, nextCursor }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        conversations = c.list(.conversations)
        nextCursor = c.opt(.nextCursor)
    }
}

struct HistoryEnvelope: Codable {
    var messages: [Message]
    var hasMore: Bool
    var floorSeq: Int64
    var latestSeq: Int64

    enum CodingKeys: String, CodingKey { case messages, hasMore, floorSeq, latestSeq }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        messages = c.list(.messages)
        hasMore = c.get(.hasMore, false)
        floorSeq = c.get(.floorSeq, 0)
        latestSeq = c.get(.latestSeq, 0)
    }
}

/// One row in a forum's post list: a titled root message and its thread.
struct ForumPost: Codable, Identifiable, Hashable {
    var id: String = ""
    var title: String?
    var excerpt: String = ""
    var createdAt: String?
    var lastActivityAt: String?
    var replyCount: Int = 0
    var pinned: Bool = false
    var author: PublicUser?
}

struct ForumPage: Codable {
    var posts: [ForumPost] = []
    var nextCursor: String?
}

/// The last N days of a place, in numbers worth repeating.
struct Recap: Codable {
    var days: Int = 30
    var messages: Int = 0
    var activeMembers: Int = 0
    var newMembers: Int = 0
    var topEmoji: RecapEmoji?
}

struct RecapEmoji: Codable {
    var emoji: String = ""
    var count: Int = 0
}

/// One incoming webhook. `url` is present only on the create response —
/// shown once, like every credential.
struct Webhook: Codable, Identifiable, Hashable {
    var id: String = ""
    var name: String = ""
    var url: String?
    var createdAt: String?
    var lastUsedAt: String?
}

struct WebhookEnvelope: Codable { var webhook: Webhook }
struct WebhooksEnvelope: Codable { var webhooks: [Webhook] = [] }

/// Whoever performed or received an audited act — just enough to name them.
struct AuditActor: Codable, Hashable {
    var id: String = ""
    var username: String?
    var displayName: String?
}

/// One admin act, as the audit log records it.
struct AuditEntry: Codable {
    var id: String = ""
    var action: String = ""
    var createdAt: String = ""
    var actor: AuditActor?
    var targetUser: AuditActor?
    var targetId: String?
    /// Labels snapshotted at write time — see the server schema.
    var metadata: [String: JSONValue]?
}

struct AuditEnvelope: Codable {
    var entries: [AuditEntry] = []
    var nextCursor: String?
}

/// What one role may and may not do in one channel.
struct ChannelOverwrite: Codable, Hashable {
    var roleId: String = ""
    var allow: String = "0"
    var deny: String = "0"
}

struct OverwritesEnvelope: Codable {
    var overwrites: [ChannelOverwrite] = []
}

struct OverwriteEnvelope: Codable {
    var overwrite: ChannelOverwrite
}

/// The room a mention landed in, named well enough to scan a list by.
struct MentionConversation: Codable, Hashable {
    var id: String = ""
    var type: String = "group"
    var title: String?
    var parentId: String?
    /// The space above a channel. `#general` alone names half of them.
    var parentTitle: String?
}

/// One entry in the mentions inbox.
struct MentionEntry: Codable {
    /// False for a direct mention, true for `@everyone` or a role.
    var isBroadcast: Bool = false
    var conversation: MentionConversation
    var message: Message?
}

struct MentionsEnvelope: Codable {
    var mentions: [MentionEntry] = []
    var nextCursor: String?
}

/// One member, as the group that holds them describes them.
struct MemberEnvelope: Codable {
    var member: MemberEntry
}

struct MembersEnvelope: Codable {
    var members: [MemberEntry]
    var nextCursor: String?

    enum CodingKeys: String, CodingKey { case members, nextCursor }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        members = c.list(.members)
        nextCursor = c.opt(.nextCursor)
    }
}

struct PinsEnvelope: Codable {
    var pins: [PinEntry]

    enum CodingKeys: String, CodingKey { case pins }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        pins = c.list(.pins)
    }
}

/// A group's custom emoji. Reaction keys shaped `:name:` resolve against this
/// set and draw as the image; unresolved keys render as their literal text,
/// which is what every build before custom emoji did anyway.
struct GroupEmoji: Codable, Hashable, Identifiable {
    var id: String
    var name: String
    var animated: Bool
    var url: String

    enum CodingKeys: String, CodingKey { case id, name, animated, url }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        animated = (try? c.decode(Bool.self, forKey: .animated)) ?? false
        url = try c.decode(String.self, forKey: .url)
    }
}

struct GroupEmojisEnvelope: Codable {
    var emojis: [GroupEmoji]

    enum CodingKeys: String, CodingKey { case emojis }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        emojis = c.list(.emojis)
    }
}

/// What the tick on an outgoing bubble says. `.none` for other people's
/// messages — only the sender is owed a status.
enum MessageReceiptState: Equatable {
    case none
    case pending
    case sent
    case delivered
    case read
}

/// One member's read/delivered watermarks, from GET …/receipts.
///
/// Watermarks rather than per-message rows: a member has read *up to* a seq,
/// so "who has seen message N" is every entry with `seq >= N` — no per-message
/// fetch, and the same payload draws the ticks and fills the seen-by sheet.
struct ReceiptEntry: Codable, Hashable, Identifiable {
    var user: PublicUser
    var seq: Int64
    var readAt: String?
    var deliveredSeq: Int64

    var id: String { user.id }

    init(user: PublicUser, seq: Int64 = 0, readAt: String? = nil, deliveredSeq: Int64 = 0) {
        self.user = user
        self.seq = seq
        self.readAt = readAt
        self.deliveredSeq = deliveredSeq
    }

    enum CodingKeys: String, CodingKey { case user, seq, readAt, deliveredSeq }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        user = try c.decode(PublicUser.self, forKey: .user)
        seq = c.get(.seq, 0)
        readAt = c.opt(.readAt)
        deliveredSeq = c.get(.deliveredSeq, 0)
    }
}

struct ReceiptsEnvelope: Codable {
    var readBy: [ReceiptEntry]

    enum CodingKeys: String, CodingKey { case readBy }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        readBy = c.list(.readBy)
    }
}

struct RolesEnvelope: Codable {
    var roles: [RoleEntry]

    enum CodingKeys: String, CodingKey { case roles }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        roles = c.list(.roles)
    }
}

struct ChannelsEnvelope: Codable {
    var channels: [ChannelEntry]

    enum CodingKeys: String, CodingKey { case channels }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        channels = c.list(.channels)
    }
}

struct InvitesEnvelope: Codable {
    var invites: [Invite]

    enum CodingKeys: String, CodingKey { case invites }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        invites = c.list(.invites)
    }
}

struct OnlineEnvelope: Codable {
    var online: [OnlineEntry]

    enum CodingKeys: String, CodingKey { case online }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        online = c.list(.online)
    }
}

struct UploadEnvelope: Codable {
    var media: Attachment
    /// Nil when the server deduplicated by checksum — the bytes already exist.
    var upload: UploadTarget?
    var deduplicated: Bool

    enum CodingKeys: String, CodingKey { case media, upload, deduplicated }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        media = try c.decode(Attachment.self, forKey: .media)
        upload = c.opt(.upload)
        deduplicated = c.get(.deduplicated, false)
    }
}

struct ReactionsEnvelope: Codable {
    var reactions: [ReactionDetail]

    enum CodingKeys: String, CodingKey { case reactions }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        reactions = c.list(.reactions)
    }
}

struct DiscoverEnvelope: Codable {
    var conversations: [DiscoverEntry]

    enum CodingKeys: String, CodingKey { case conversations }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        conversations = c.list(.conversations)
    }
}

struct PacksEnvelope: Codable {
    var packs: [StickerPack]
    var nextCursor: String?

    enum CodingKeys: String, CodingKey { case packs, nextCursor }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        packs = c.list(.packs)
        nextCursor = c.opt(.nextCursor)
    }
}

struct StickersEnvelope: Codable {
    var stickers: [Sticker]

    enum CodingKeys: String, CodingKey { case stickers }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        stickers = c.list(.stickers)
    }
}

struct GifsEnvelope: Codable {
    var results: [GifResult]
    var next: String?
    var unavailable: Bool

    enum CodingKeys: String, CodingKey { case results, next, unavailable }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        results = c.list(.results)
        next = c.opt(.next)
        unavailable = c.get(.unavailable, false)
    }
}

struct CallEnvelope: Codable {
    var call: Call
    var token: String?
    var url: String?

    enum CodingKeys: String, CodingKey { case call, token, url }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        call = try c.decode(Call.self, forKey: .call)
        token = c.opt(.token)
        url = c.opt(.url)
    }
}

struct DevicesEnvelope: Codable {
    var devices: [DeviceEntry]

    enum CodingKeys: String, CodingKey { case devices }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        devices = c.list(.devices)
    }
}

struct SearchEnvelope: Codable {
    var results: [SearchHit]
    var nextCursor: String?

    enum CodingKeys: String, CodingKey { case results, nextCursor }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        results = c.list(.results)
        nextCursor = c.opt(.nextCursor)
    }
}

struct BotCommandsEnvelope: Codable {
    var commands: [BotCommand]

    enum CodingKeys: String, CodingKey { case commands }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        commands = c.list(.commands)
    }
}

struct ReadAck: Codable {
    var lastReadSeq: Int64
    var unreadCount: Int
    var mentionCount: Int

    enum CodingKeys: String, CodingKey { case lastReadSeq, unreadCount, mentionCount }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        lastReadSeq = c.get(.lastReadSeq, 0)
        unreadCount = c.get(.unreadCount, 0)
        mentionCount = c.get(.mentionCount, 0)
    }
}

struct PublishedKeys: Codable {
    var fingerprint: String
    var availablePreKeys: Int

    enum CodingKeys: String, CodingKey { case fingerprint, availablePreKeys }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        fingerprint = c.get(.fingerprint, "")
        availablePreKeys = c.get(.availablePreKeys, 0)
    }
}

/// One recipient device, from a key claim.
/// An X25519 prekey with the identity signature that vouches for it.
struct SignedPreKey: Codable {
    var id: Int = 1
    var key: String = ""
    var signature: String = ""

    enum CodingKeys: String, CodingKey { case id, key, signature }

    init(id: Int = 1, key: String = "", signature: String = "") {
        self.id = id
        self.key = key
        self.signature = signature
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.get(.id, 1)
        key = c.get(.key, "")
        signature = c.get(.signature, "")
    }
}

/// One of the pool, handed out exactly once.
struct OneTimePreKey: Codable {
    var id: Int = 0
    var key: String = ""

    enum CodingKeys: String, CodingKey { case id, key }

    init(id: Int = 0, key: String = "") {
        self.id = id
        self.key = key
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.get(.id, 0)
        key = c.get(.key, "")
    }
}

/// One recipient device, from a key claim: everything needed to seal to it.
struct KeyBundle: Codable {
    var userId: String
    var deviceId: String
    var identityKey: String
    var signedPreKey: SignedPreKey
    /// Absent when the device has run its pool down — degraded, not an error.
    var oneTimePreKey: OneTimePreKey?
    /// What it says it can read, and its own signature over that claim.
    var formats: String?
    var formatsSignature: String?

    enum CodingKeys: String, CodingKey {
        case userId, deviceId, identityKey, signedPreKey, oneTimePreKey
        case formats, formatsSignature
    }

    init(
        userId: String,
        deviceId: String,
        identityKey: String,
        signedPreKey: SignedPreKey = SignedPreKey(),
        oneTimePreKey: OneTimePreKey? = nil
    ) {
        self.userId = userId
        self.deviceId = deviceId
        self.identityKey = identityKey
        self.signedPreKey = signedPreKey
        self.oneTimePreKey = oneTimePreKey
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        userId = c.get(.userId, "")
        deviceId = c.get(.deviceId, "")
        identityKey = c.get(.identityKey, "")
        signedPreKey = c.get(.signedPreKey, SignedPreKey())
        oneTimePreKey = c.opt(.oneTimePreKey)
        formats = c.opt(.formats)
        formatsSignature = c.opt(.formatsSignature)
    }
}

/// One device from the directory, for checking a signature against.
struct UserKeyDevice: Codable {
    var deviceId: String = ""
    var identityKey: String = ""
    var name: String?
    var platform: String?
    var fingerprint: String?
    /// What it says it can read, and its own signature over that claim.
    var formats: String?
    var formatsSignature: String?

    enum CodingKeys: String, CodingKey {
        case deviceId, identityKey, name, platform, fingerprint, formats, formatsSignature
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        deviceId = c.get(.deviceId, "")
        identityKey = c.get(.identityKey, "")
        name = c.opt(.name)
        platform = c.opt(.platform)
        fingerprint = c.opt(.fingerprint)
        formats = c.opt(.formats)
        formatsSignature = c.opt(.formatsSignature)
    }
}

/// Every device key one person currently has, plus the safety number.
struct UserKeys: Codable {
    var devices: [UserKeyDevice] = []
    var safetyNumber: String = ""
    var verified: Bool = false
    var changedSinceVerified: Bool = false

    enum CodingKeys: String, CodingKey {
        case devices, safetyNumber, verified, changedSinceVerified
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        devices = c.get(.devices, [])
        safetyNumber = c.get(.safetyNumber, "")
        verified = c.get(.verified, false)
        changedSinceVerified = c.get(.changedSinceVerified, false)
    }
}

struct ClaimedKeys: Codable {
    var bundles: [KeyBundle]

    enum CodingKeys: String, CodingKey { case bundles }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        bundles = c.get(.bundles, [])
    }
}

/// This device's copy of an encrypted body, fetched after a live delivery.
struct CipherEnvelope: Codable {
    var ciphertext: String?

    enum CodingKeys: String, CodingKey { case ciphertext }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ciphertext = c.opt(.ciphertext)
    }
}

struct PreKeyCount: Codable {
    var availablePreKeys: Int

    enum CodingKeys: String, CodingKey { case availablePreKeys }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        availablePreKeys = c.get(.availablePreKeys, 0)
    }
}

struct Ok: Codable {
    var ok: Bool

    enum CodingKeys: String, CodingKey { case ok }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = c.get(.ok, true)
    }
}

struct ApiErrorDetail: Codable {
    var code: String
    var message: String
    var retryAfter: Int?

    enum CodingKeys: String, CodingKey { case code, message, retryAfter }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        code = c.get(.code, "unknown")
        message = c.get(.message, "")
        retryAfter = c.opt(.retryAfter)
    }
}

struct ApiErrorBody: Codable { var error: ApiErrorDetail }

// ── Moderation ───────────────────────────────────────────────────────────────

/// A ban as the moderation list renders it.
///
/// Carries the whole `PublicUser` rather than an id because someone who was
/// banned is usually no longer a member, so there is no member row to look
/// their name up in.
struct BanEntry: Codable, Hashable, Identifiable {
    var user: PublicUser
    var reason: String?
    /// Who did it. Rendered only when that person is still resolvable.
    var bannedById: String?
    /// Nil means permanent.
    var expiresAt: String?
    var createdAt: String?

    var id: String { user.id }

    enum CodingKeys: String, CodingKey { case user, reason, bannedById, expiresAt, createdAt }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        user = c.get(.user, PublicUser(id: ""))
        reason = c.opt(.reason)
        bannedById = c.opt(.bannedById)
        expiresAt = c.opt(.expiresAt)
        createdAt = c.opt(.createdAt)
    }
}

struct BansEnvelope: Codable {
    var bans: [BanEntry]

    enum CodingKeys: String, CodingKey { case bans }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        bans = c.list(.bans)
    }
}

// ── Build metadata ───────────────────────────────────────────────────────────

/// The answer from `/v1/meta/version`.
///
/// The comparison is the server's, not ours: four clients each implementing
/// version ordering is four chances to get it wrong, and the two booleans are
/// the only part the UI actually needs.
struct VersionInfo: Codable {
    var api: String
    var latest: String?
    var minimum: String?
    var updateAvailable: Bool
    var updateRequired: Bool

    enum CodingKeys: String, CodingKey { case api, latest, minimum, updateAvailable, updateRequired }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        api = c.get(.api, "")
        latest = c.opt(.latest)
        minimum = c.opt(.minimum)
        updateAvailable = c.get(.updateAvailable, false)
        updateRequired = c.get(.updateRequired, false)
    }
}

// ── Release notes ────────────────────────────────────────────────────────────

struct ReleaseNoteItem: Codable, Hashable {
    var title: String
    var body: String
    var url: String?

    enum CodingKeys: String, CodingKey { case title, body, url }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        title = c.get(.title, "")
        body = c.get(.body, "")
        url = c.opt(.url)
    }
}

struct ReleaseNoteSection: Codable, Hashable {
    var heading: String
    /// An SF Symbol name chosen by the server. Rendered only if it resolves,
    /// so an unknown symbol from a newer server degrades to no icon.
    var icon: String?
    var items: [ReleaseNoteItem]

    enum CodingKeys: String, CodingKey { case heading, icon, items }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        heading = c.get(.heading, "")
        icon = c.opt(.icon)
        items = c.list(.items)
    }
}

struct ReleaseNote: Codable, Hashable, Identifiable {
    let id: String
    var version: String
    var date: String
    var title: String
    var intro: String?
    /// Absent means fall back to the bundled hero art.
    var heroUrl: String?
    var sections: [ReleaseNoteSection]

    enum CodingKeys: String, CodingKey { case id, version, date, title, intro, heroUrl, sections }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.get(.id, "")
        version = c.get(.version, "")
        date = c.get(.date, "")
        title = c.get(.title, "What's New")
        intro = c.opt(.intro)
        heroUrl = c.opt(.heroUrl)
        sections = c.list(.sections)
    }
}

struct ChangelogEnvelope: Codable {
    var notes: [ReleaseNote]
    /// The newest note that exists, whether or not it is in `notes`. A first
    /// run records this and shows nothing.
    var latestId: String?

    enum CodingKeys: String, CodingKey { case notes, latestId }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        notes = c.list(.notes)
        latestId = c.opt(.latestId)
    }
}
