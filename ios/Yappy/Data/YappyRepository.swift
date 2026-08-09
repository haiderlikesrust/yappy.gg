import Foundation
import UIKit

/// Typed wrapper over the REST API.
///
/// One type rather than one per feature: the surface is wide but shallow, and
/// splitting it would mostly produce files that each hold three methods and an
/// `ApiClient` reference.
struct YappyRepository {
    let api: ApiClient

    static func newNonce() -> String { UUID().uuidString }

    /// Describes this handset, so the account's session list is readable.
    ///
    /// `UIDevice.model` only ever says "iPhone", which would make every row in
    /// the session list identical. The machine identifier from `uname` is what
    /// actually distinguishes one device from another.
    private var clientInfo: JSONValue {
        var system = utsname()
        uname(&system)
        let identifier = withUnsafeBytes(of: &system.machine) { raw in
            String(cString: raw.bindMemory(to: CChar.self).baseAddress!)
        }
        return .object([
            "platform": .string("ios"),
            "version": .string(AppConfig.version),
            "os": .string("iOS \(UIDevice.current.systemVersion)"),
            "device": .string(identifier),
        ])
    }

    // ── Auth ─────────────────────────────────────────────────────────────────

    func register(email: String, password: String, username: String, displayName: String) async throws -> AuthTokens {
        try await api.post("/auth/register", jsonBody([
            "email": .string(email),
            "password": .string(password),
            "username": .string(username),
            "displayName": displayName.isEmpty ? nil : .string(displayName),
            "client": clientInfo,
        ]))
    }

    func login(email: String, password: String) async throws -> AuthTokens {
        try await api.post("/auth/login", jsonBody([
            "email": .string(email),
            "password": .string(password),
            "client": clientInfo,
        ]))
    }

    func changePassword(current: String, new: String) async throws -> AuthTokens {
        try await api.post("/auth/change-password", jsonBody([
            "currentPassword": .string(current),
            "newPassword": .string(new),
        ]))
    }

    func completeProfile(username: String, displayName: String) async throws -> UserEnvelope {
        try await api.post("/auth/complete-profile", jsonBody([
            "username": .string(username),
            "displayName": .string(displayName),
        ]))
    }

    func usernameAvailable(_ username: String) async throws -> UsernameAvailability {
        try await api.get("/auth/username-available", query: ["username": username])
    }

    func gatewayTicket() async throws -> GatewayTicket {
        try await api.post("/auth/gateway-ticket")
    }

    @discardableResult
    func logout() async throws -> Ok { try await api.post("/auth/logout") }

    @discardableResult
    func logoutAll() async throws -> Ok { try await api.post("/auth/logout-all") }

    // ── Me & users ───────────────────────────────────────────────────────────

    func me() async throws -> UserEnvelope { try await api.get("/users/me", cacheTo: "me") }

    func updateProfile(displayName: String?, bio: String?, pronouns: String?) async throws -> UserEnvelope {
        try await api.patch("/users/me", jsonBody([
            "displayName": displayName.map { .string($0) },
            "bio": bio.map { .string($0) } ?? .null,
            "pronouns": pronouns.map { .string($0) } ?? .null,
        ]))
    }

    /// Nil clears the picture. The old media row is left for the reaper.
    func setMyAvatar(mediaId: String?) async throws -> UserEnvelope {
        try await api.patch("/users/me", jsonBody([
            "avatarMediaId": mediaId.map { .string($0) } ?? .null,
        ]))
    }

    func updatePrivacy(_ key: String, _ value: String) async throws -> UserEnvelope {
        try await api.patch("/users/me/settings", .object(["privacy": .object([key: .string(value)])]))
    }

    func updatePrivacyFlag(_ key: String, _ value: Bool) async throws -> UserEnvelope {
        try await api.patch("/users/me/settings", .object(["privacy": .object([key: .bool(value)])]))
    }

    func updateNotificationFlag(_ key: String, _ value: Bool) async throws -> UserEnvelope {
        try await api.patch("/users/me/settings", .object(["notifications": .object([key: .bool(value)])]))
    }

    /// For the settings that are not booleans — `sound` in particular, which is
    /// a name or `"none"` rather than an on/off.
    @discardableResult
    func updateNotificationValue(_ key: String, _ value: String) async throws -> UserEnvelope {
        try await api.patch("/users/me/settings", .object(["notifications": .object([key: .string(value)])]))
    }

    func updateTheme(_ theme: String) async throws -> UserEnvelope {
        try await api.patch("/users/me/settings", .object(["appearance": .object(["theme": .string(theme)])]))
    }

    @discardableResult
    func setPresence(_ status: String) async throws -> Ok {
        try await api.put("/users/me/presence", .object(["status": .string(status)]))
    }

    func user(_ id: String) async throws -> UserEnvelope { try await api.get("/users/\(id)") }

    func searchUsers(_ query: String) async throws -> UsersEnvelope {
        try await api.get("/users", query: ["q": query, "limit": "20"])
    }

    /// The member's half of an affiliation: which affiliated group to show, or
    /// nil for none.
    func setAffiliation(conversationId: String?) async throws -> UserEnvelope {
        try await api.patch("/users/me", jsonBody([
            "affiliationConversationId": conversationId.map { .string($0) } ?? .null,
        ]))
    }

    // ── Social ───────────────────────────────────────────────────────────────

    /// Follow, and take the server's word for what that produced.
    ///
    /// `isMutual` is the half a client cannot work out for itself: following
    /// someone who already followed you completes the pair, and only the server
    /// knows whether it did. Returning it means the button settles on its final
    /// state from the response rather than needing a refetch to find out.
    @discardableResult
    func follow(_ userId: String) async throws -> FollowResult {
        try await api.post("/social/follow/\(userId)")
    }

    @discardableResult
    func unfollow(_ userId: String) async throws -> FollowResult {
        try await api.delete("/social/follow/\(userId)")
    }

    func contacts() async throws -> UsersEnvelope {
        try await api.get("/social/me/contacts", query: ["limit": "100"])
    }

    /// Contacts online right now — the Active Now strip.
    func onlineContacts() async throws -> OnlineEnvelope { try await api.get("/social/me/online") }

    func blocks() async throws -> UsersEnvelope { try await api.get("/social/blocks") }

    func block(_ userId: String) async throws {
        try await api.send("POST", "/social/block", body: .object(["userId": .string(userId)]))
    }

    func unblock(_ userId: String) async throws { try await api.send("DELETE", "/social/block/\(userId)") }

    // ── Conversations ────────────────────────────────────────────────────────

    func conversations(cursor: String? = nil, archived: Bool = false) async throws -> ConversationsEnvelope {
        try await api.get(
            "/conversations",
            query: [
                "cursor": cursor,
                "archived": String(archived),
                "limit": "50",
            ],
            // Only the view everyone opens the app to. The archived list and
            // deeper pages are places people go, not places the app wakes up.
            cacheTo: cursor == nil && !archived ? "conversations" : nil
        )
    }

    func conversation(_ id: String) async throws -> ConversationEnvelope {
        try await api.get("/conversations/\(id)")
    }

    func createDm(userId: String) async throws -> ConversationEnvelope {
        try await api.post("/conversations", .object([
            "type": .string("dm"),
            "memberIds": .array([.string(userId)]),
        ]))
    }

    func createGroup(title: String, memberIds: [String]) async throws -> ConversationEnvelope {
        try await api.post("/conversations", .object([
            "type": .string("group"),
            "title": .string(title),
            "memberIds": .array(memberIds.map { .string($0) }),
        ]))
    }

    func updateConversation(_ id: String, title: String? = nil, description: String? = nil) async throws -> ConversationEnvelope {
        try await api.patch("/conversations/\(id)", jsonBody([
            "title": title.map { .string($0) },
            "description": description.map { .string($0) },
        ]))
    }

    func setConversationAvatar(_ id: String, mediaId: String?) async throws -> ConversationEnvelope {
        try await api.patch("/conversations/\(id)", jsonBody([
            "avatarMediaId": mediaId.map { .string($0) } ?? .null,
        ]))
    }

    func setDisappearing(_ id: String, seconds: Int) async throws -> ConversationEnvelope {
        try await api.patch("/conversations/\(id)", .object(["disappearingSeconds": .int(seconds)]))
    }

    @discardableResult
    func setConversationState(
        _ id: String,
        muted: Bool? = nil,
        pinned: Bool? = nil,
        archived: Bool? = nil,
        draft: String? = nil
    ) async throws -> Ok {
        try await api.patch("/conversations/\(id)/state", jsonBody([
            "notificationLevel": muted.map { .string($0 ? "none" : "all") },
            "isPinned": pinned.map { .bool($0) },
            "isArchived": archived.map { .bool($0) },
            "draft": draft.map { .string($0) },
        ]))
    }

    /// The three-way setting, as opposed to `setConversationState`'s mute
    /// toggle. Used by the channel list, where "mentions only" is the setting
    /// people actually want for the busy channel they still care about.
    @discardableResult
    func setNotificationLevel(_ id: String, level: String) async throws -> Ok {
        try await api.patch("/conversations/\(id)/state", .object([
            "notificationLevel": .string(level),
            // Choosing a level clears any timed mute; otherwise "all" would
            // appear selected while nothing came through.
            "mutedUntil": .null,
        ]))
    }

    func leaveConversation(_ id: String) async throws { try await api.send("DELETE", "/conversations/\(id)") }

    func members(_ id: String) async throws -> MembersEnvelope {
        try await api.get("/conversations/\(id)/members", query: ["limit": "100"])
    }

    /// The group profile in one round trip: members + presence, counts, active call.
    func summary(_ id: String) async throws -> SummaryEnvelope {
        try await api.get("/conversations/\(id)/summary")
    }

    /// The media wall: image/video/GIF messages, newest first, seq-cursored.
    func mediaWall(_ id: String, before: Int64? = nil, limit: Int = 30) async throws -> HistoryEnvelope {
        try await api.get("/conversations/\(id)/media", query: [
            "limit": String(limit),
            "before": before.map(String.init),
        ])
    }

    func addMembers(_ id: String, userIds: [String]) async throws {
        try await api.send("POST", "/conversations/\(id)/members", body: .object([
            "userIds": .array(userIds.map { .string($0) }),
        ]))
    }

    func removeMember(_ id: String, userId: String) async throws {
        try await api.send("DELETE", "/conversations/\(id)/members/\(userId)")
    }

    func createInvite(_ id: String) async throws -> InviteEnvelope {
        try await api.post("/conversations/\(id)/invites", .object(["maxUses": .int(0)]))
    }

    func invites(_ id: String) async throws -> InvitesEnvelope {
        try await api.get("/conversations/\(id)/invites")
    }

    /// What an invite leads to, without joining it.
    ///
    /// Shown before the join so someone following a link from outside the app
    /// can see whose room it is and back out — a link that silently adds you to
    /// a group is a link people learn not to tap.
    func invitePreview(code: String) async throws -> InvitePreview {
        try await api.get("/conversations/invites/\(code)")
    }

    func joinInvite(code: String) async throws -> JoinResult {
        try await api.post("/conversations/invites/\(code)/join")
    }

    /// Pass nil to clear all flair.
    func setAppearance(_ id: String, _ appearance: ConversationAppearance?) async throws -> ConversationEnvelope {
        let payload: JSONValue
        if let appearance {
            payload = jsonBody([
                "accent": appearance.accent.map { .string($0) },
                "gradient": appearance.gradient.map { .array($0.map { .string($0) }) },
                "effect": .string(appearance.effect),
                "emoji": appearance.emoji.map { .string($0) },
            ])
        } else {
            payload = .null
        }
        return try await api.patch("/conversations/\(id)", .object(["appearance": payload]))
    }

    func setPublic(_ id: String, _ isPublic: Bool) async throws -> ConversationEnvelope {
        try await api.patch("/conversations/\(id)", .object(["isPublic": .bool(isPublic)]))
    }

    func discover() async throws -> DiscoverEnvelope {
        try await api.get("/conversations/discover", query: ["limit": "50"])
    }

    func joinPublic(_ conversationId: String) async throws -> ConversationEnvelope {
        try await api.post("/conversations/\(conversationId)/join")
    }

    func setMemberRole(_ conversationId: String, userId: String, role: String) async throws {
        try await api.send("PATCH", "/conversations/\(conversationId)/members/\(userId)", body: .object([
            "role": .string(role),
        ]))
    }

    /// The group's half of an affiliation. The member still has to display it.
    func setMemberAffiliate(_ conversationId: String, userId: String, on: Bool) async throws {
        try await api.send("PATCH", "/conversations/\(conversationId)/members/\(userId)", body: .object([
            "isAffiliate": .bool(on),
        ]))
    }

    // ── Named roles ──────────────────────────────────────────────────────────

    func roles(_ conversationId: String) async throws -> RolesEnvelope {
        try await api.get("/conversations/\(conversationId)/roles")
    }

    @discardableResult
    func createRole(
        _ conversationId: String,
        name: String,
        color: String?,
        permissions: String,
        position: Int = 0,
        isHoisted: Bool = false
    ) async throws -> RoleEnvelope {
        try await api.post("/conversations/\(conversationId)/roles", .object([
            "name": .string(name),
            "color": color.map { JSONValue.string($0) } ?? .null,
            "permissions": .string(permissions),
            "position": .int(position),
            "isHoisted": .bool(isHoisted),
        ]))
    }

    @discardableResult
    func updateRole(
        _ conversationId: String,
        roleId: String,
        name: String? = nil,
        color: String? = nil,
        permissions: String? = nil
    ) async throws -> RoleEnvelope {
        try await api.patch("/conversations/\(conversationId)/roles/\(roleId)", jsonBody([
            "name": name.map { .string($0) },
            "color": color.map { .string($0) },
            "permissions": permissions.map { .string($0) },
        ]))
    }

    func deleteRole(_ conversationId: String, roleId: String) async throws {
        try await api.send("DELETE", "/conversations/\(conversationId)/roles/\(roleId)")
    }

    /// Full replacement — send every role the member should end up with.
    @discardableResult
    func setMemberRoles(_ conversationId: String, userId: String, roleIds: [String]) async throws -> RolesEnvelope {
        try await api.put("/conversations/\(conversationId)/members/\(userId)/roles", .object([
            "roleIds": .array(roleIds.map { .string($0) }),
        ]))
    }

    // ── Spaces & channels ────────────────────────────────────────────────────

    func channels(_ spaceId: String) async throws -> ChannelsEnvelope {
        try await api.get("/conversations/\(spaceId)/channels", cacheTo: "channels_\(spaceId)")
    }

    @discardableResult
    func createChannel(
        _ spaceId: String,
        title: String,
        isAnnouncement: Bool = false,
        position: Int = 0
    ) async throws -> ChannelEnvelope {
        try await api.post("/conversations/\(spaceId)/channels", .object([
            "title": .string(title),
            "isAnnouncement": .bool(isAnnouncement),
            "position": .int(position),
        ]))
    }

    /// Full ordered list; the server rewrites every position from the index.
    func reorderChannels(_ spaceId: String, channelIds: [String]) async throws {
        try await api.send("PUT", "/conversations/\(spaceId)/channels/order", body: .object([
            "channelIds": .array(channelIds.map { .string($0) }),
        ]))
    }

    func deleteChannel(_ spaceId: String, channelId: String) async throws {
        try await api.send("DELETE", "/conversations/\(spaceId)/channels/\(channelId)")
    }

    /// One-way and owner-only; the group's history moves into the first channel.
    @discardableResult
    func upgradeToSpace(_ conversationId: String, firstChannelTitle: String = "general") async throws -> UpgradeEnvelope {
        try await api.post("/conversations/\(conversationId)/upgrade-to-space", .object([
            "firstChannelTitle": .string(firstChannelTitle),
        ]))
    }

    // ── Messages ─────────────────────────────────────────────────────────────

    func history(
        _ conversationId: String,
        before: Int64? = nil,
        after: Int64? = nil,
        around: Int64? = nil,
        limit: Int = 50
    ) async throws -> HistoryEnvelope {
        try await api.get(
            "/conversations/\(conversationId)/messages",
            query: [
                "limit": String(limit),
                "before": before.map(String.init),
                "after": after.map(String.init),
                "around": around.map(String.init),
            ],
            // The newest page only — the one a reopened chat paints first.
            // Cursored pages are scrollback, and scrollback can wait a fetch.
            cacheTo: before == nil && after == nil && around == nil
                ? "history_\(conversationId)"
                : nil
        )
    }

    struct MentionSpan {
        let offset: Int
        let length: Int
        let userId: String
    }

    /// - Parameter nonce: Generated by the caller so the optimistic bubble and
    ///   the server's copy share an identity. Retrying with the same nonce
    ///   returns the original message instead of duplicating it.
    @discardableResult
    func sendText(
        _ conversationId: String,
        text: String,
        nonce: String = newNonce(),
        replyToId: String? = nil,
        threadRootId: String? = nil,
        mentions: [MentionSpan] = []
    ) async throws -> MessageEnvelope {
        try await api.post("/conversations/\(conversationId)/messages", jsonBody([
            "nonce": .string(nonce),
            "type": .string("text"),
            "content": .string(text),
            "replyToId": replyToId.map { .string($0) },
            "threadRootId": threadRootId.map { .string($0) },
            "entities": mentions.isEmpty ? nil : .array(mentions.map { span in
                .object([
                    "type": .string("mention"),
                    "offset": .int(span.offset),
                    "length": .int(span.length),
                    "userId": .string(span.userId),
                ])
            }),
        ]))
    }

    func thread(_ conversationId: String, rootId: String, after: Int64? = nil) async throws -> HistoryEnvelope {
        try await api.get("/conversations/\(conversationId)/messages/\(rootId)/thread", query: [
            "limit": "50",
            "after": after.map(String.init),
        ])
    }

    func message(_ conversationId: String, messageId: String) async throws -> MessageEnvelope {
        try await api.get("/conversations/\(conversationId)/messages/\(messageId)")
    }

    /// Press a button on a bot's message. Returns the message as it stands after
    /// the bot responded, which for a prompt is usually the outcome card with
    /// its buttons retired.
    func pressComponent(_ conversationId: String, messageId: String, customId: String) async throws -> MessageEnvelope {
        try await api.post("/conversations/\(conversationId)/messages/\(messageId)/interactions", .object([
            "customId": .string(customId),
        ]))
    }

    /// Slash commands offered here, for composer autocomplete.
    func conversationCommands(_ conversationId: String) async throws -> BotCommandsEnvelope {
        try await api.get("/conversations/\(conversationId)/commands")
    }

    func reactionsFor(_ conversationId: String, messageId: String) async throws -> ReactionsEnvelope {
        try await api.get("/conversations/\(conversationId)/messages/\(messageId)/reactions")
    }

    func forward(messageIds: [String], toConversationIds: [String]) async throws {
        try await api.send("POST", "/conversations/messages/forward", body: .object([
            "messageIds": .array(messageIds.map { .string($0) }),
            "toConversationIds": .array(toConversationIds.map { .string($0) }),
        ]))
    }

    @discardableResult
    func editMessage(_ conversationId: String, messageId: String, content: String) async throws -> MessageEnvelope {
        try await api.patch("/conversations/\(conversationId)/messages/\(messageId)", .object([
            "content": .string(content),
        ]))
    }

    func deleteMessage(_ conversationId: String, messageId: String, forEveryone: Bool = true) async throws {
        try await api.send(
            "DELETE",
            "/conversations/\(conversationId)/messages/\(messageId)",
            query: ["forEveryone": String(forEveryone)]
        )
    }

    @discardableResult
    func react(_ conversationId: String, messageId: String, emoji: String) async throws -> Ok {
        try await api.put("/conversations/\(conversationId)/messages/\(messageId)/reactions", .object([
            "emoji": .string(emoji),
        ]))
    }

    @discardableResult
    func unreact(_ conversationId: String, messageId: String, emoji: String) async throws -> Ok {
        try await api.delete(
            "/conversations/\(conversationId)/messages/\(messageId)/reactions",
            query: ["emoji": emoji]
        )
    }

    func pin(_ conversationId: String, messageId: String) async throws {
        try await api.send("PUT", "/conversations/\(conversationId)/pins/\(messageId)")
    }

    func unpin(_ conversationId: String, messageId: String) async throws {
        try await api.send("DELETE", "/conversations/\(conversationId)/pins/\(messageId)")
    }

    /// Read/delivered watermarks for every receipt-visible member. `seq: 0`
    /// returns them all — the snapshot the ticks are drawn from.
    func receipts(_ conversationId: String, seq: Int64 = 0) async throws -> ReceiptsEnvelope {
        try await api.get(
            "/conversations/\(conversationId)/receipts",
            query: ["seq": String(seq)]
        )
    }

    func pins(_ conversationId: String) async throws -> PinsEnvelope {
        try await api.get("/conversations/\(conversationId)/pins")
    }

    func votePoll(_ conversationId: String, messageId: String, optionIds: [String]) async throws {
        try await api.send("POST", "/conversations/\(conversationId)/messages/\(messageId)/poll/vote", body: .object([
            "optionIds": .array(optionIds.map { .string($0) }),
        ]))
    }

    @discardableResult
    func markRead(_ conversationId: String, seq: Int64) async throws -> ReadAck {
        try await api.post("/conversations/\(conversationId)/read", .object(["seq": .int64(seq)]))
    }

    // ── Media ────────────────────────────────────────────────────────────────

    func createUpload(
        filename: String,
        mimeType: String,
        size: Int,
        purpose: String = "attachment",
        width: Int? = nil,
        height: Int? = nil,
        checksum: String? = nil
    ) async throws -> UploadEnvelope {
        try await api.post("/media/uploads", jsonBody([
            "filename": .string(filename),
            "mimeType": .string(mimeType),
            "size": .int(size),
            "purpose": .string(purpose),
            "width": width.map { .int($0) },
            "height": height.map { .int($0) },
            "checksum": checksum.map { .string($0) },
        ]))
    }

    func confirmUpload(mediaId: String) async throws -> MediaEnvelope {
        try await api.post("/media/\(mediaId)/confirm")
    }

    /// Send a message carrying already-uploaded media.
    @discardableResult
    func sendAttachment(
        _ conversationId: String,
        attachmentIds: [String],
        caption: String? = nil,
        type: String = "image",
        nonce: String = newNonce()
    ) async throws -> MessageEnvelope {
        try await api.post("/conversations/\(conversationId)/messages", jsonBody([
            "nonce": .string(nonce),
            "type": .string(type),
            "content": (caption?.isEmpty == false) ? .string(caption!) : nil,
            "attachmentIds": .array(attachmentIds.map { .string($0) }),
        ]))
    }

    @discardableResult
    func sendSticker(_ conversationId: String, stickerId: String, nonce: String = newNonce()) async throws -> MessageEnvelope {
        try await api.post("/conversations/\(conversationId)/messages", .object([
            "nonce": .string(nonce),
            "type": .string("sticker"),
            "stickerId": .string(stickerId),
        ]))
    }

    @discardableResult
    func sendGif(_ conversationId: String, gif: GifResult, nonce: String = newNonce()) async throws -> MessageEnvelope {
        try await api.post("/conversations/\(conversationId)/messages", .object([
            "nonce": .string(nonce),
            "type": .string("gif"),
            "gif": .object([
                "provider": .string(gif.provider),
                "id": .string(gif.id),
                "url": .string(gif.url),
                "previewUrl": .string(gif.previewUrl),
                "width": .int(gif.width),
                "height": .int(gif.height),
                "title": .string(gif.title),
            ]),
        ]))
    }

    @discardableResult
    func sendPoll(
        _ conversationId: String,
        question: String,
        options: [String],
        multiSelect: Bool,
        nonce: String = newNonce()
    ) async throws -> MessageEnvelope {
        try await api.post("/conversations/\(conversationId)/messages", .object([
            "nonce": .string(nonce),
            "type": .string("poll"),
            "poll": .object([
                "question": .string(question),
                "options": .array(options.map { .string($0) }),
                "multiSelect": .bool(multiSelect),
                "anonymous": .bool(false),
            ]),
        ]))
    }

    // ── Stickers & GIFs ──────────────────────────────────────────────────────

    func installedPacks() async throws -> PacksEnvelope { try await api.get("/stickers/installed") }

    func stickerStore(query: String? = nil) async throws -> PacksEnvelope {
        try await api.get("/stickers/store", query: ["q": query, "limit": "40"])
    }

    func installPack(_ packId: String) async throws {
        try await api.send("POST", "/stickers/packs/\(packId)/install")
    }

    func recentStickers() async throws -> StickersEnvelope { try await api.get("/stickers/recent") }

    func suggestStickers(emoji: String) async throws -> StickersEnvelope {
        try await api.get("/stickers/suggest", query: ["emoji": emoji])
    }

    func searchGifs(_ query: String, pos: String? = nil) async throws -> GifsEnvelope {
        try await api.get("/gifs/search", query: ["q": query, "pos": pos, "limit": "30"])
    }

    func recentGifs() async throws -> GifsEnvelope { try await api.get("/gifs/recent") }

    @discardableResult
    func rememberGif(_ gif: GifResult) async throws -> Ok {
        try await api.post("/gifs/recent", .object([
            "id": .string(gif.id),
            "provider": .string(gif.provider),
            "url": .string(gif.url),
            "previewUrl": .string(gif.previewUrl),
            "width": .int(gif.width),
            "height": .int(gif.height),
            "title": .string(gif.title),
        ]))
    }

    // ── Calls ────────────────────────────────────────────────────────────────

    func startCall(_ conversationId: String, video: Bool) async throws -> CallEnvelope {
        try await api.post("/calls", .object([
            "conversationId": .string(conversationId),
            "mode": .string(video ? "video" : "audio"),
            "nonce": .string(Self.newNonce()),
        ]))
    }

    func joinCall(_ callId: String, video: Bool) async throws -> CallEnvelope {
        try await api.post("/calls/\(callId)/join", .object([
            "publishAudio": .bool(true),
            "publishVideo": .bool(video),
        ]))
    }

    @discardableResult
    func declineCall(_ callId: String) async throws -> Ok {
        try await api.post("/calls/\(callId)/decline", .object(["reason": .string("declined")]))
    }

    func leaveCall(_ callId: String) async throws { try await api.send("POST", "/calls/\(callId)/leave") }

    @discardableResult
    func endCall(_ callId: String) async throws -> Ok { try await api.post("/calls/\(callId)/end") }

    func call(_ callId: String) async throws -> CallEnvelope { try await api.get("/calls/\(callId)") }

    @discardableResult
    func setCallState(_ callId: String, muted: Bool? = nil, video: Bool? = nil) async throws -> Ok {
        try await api.patch("/calls/\(callId)/state", jsonBody([
            "isMuted": muted.map { .bool($0) },
            "isVideoEnabled": video.map { .bool($0) },
        ]))
    }

    // ── Sync, search, devices ────────────────────────────────────────────────

    func badge() async throws -> BadgeCounts { try await api.get("/sync/badge") }

    func searchMessages(_ query: String, conversationId: String? = nil) async throws -> SearchEnvelope {
        try await api.get("/search/messages", query: ["q": query, "conversationId": conversationId])
    }

    func devices() async throws -> DevicesEnvelope { try await api.get("/devices") }

    func revokeDevice(_ id: String) async throws { try await api.send("DELETE", "/devices/\(id)") }

    @discardableResult
    func registerPush(token: String) async throws -> Ok {
        try await api.put("/devices/me/push", .object([
            "platform": .string("ios"),
            "token": .string(token),
        ]))
    }

    func report(targetType: String, targetId: String, reason: String, detail: String?) async throws {
        try await api.send("POST", "/moderation/reports", body: jsonBody([
            "targetType": .string(targetType),
            "targetId": .string(targetId),
            "reason": .string(reason),
            "detail": detail.map { .string($0) },
        ]))
    }
}
