package gg.yappy.app.data

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import java.util.UUID

/**
 * Typed wrapper over the REST API.
 *
 * One class rather than one per feature: the surface is wide but shallow, and
 * splitting it would mostly produce files that each hold three methods and an
 * `ApiClient` reference.
 */
class YappyRepository(private val api: ApiClient) {

    // ── Auth ─────────────────────────────────────────────────────────────────

    suspend fun requestOtp(phone: String): OtpRequested =
        api.post("/auth/otp/request", buildJsonObject { put("phone", phone) })

    suspend fun verifyOtp(phone: String, code: String, appVersion: String): AuthTokens =
        api.post(
            "/auth/otp/verify",
            buildJsonObject {
                put("phone", phone)
                put("code", code)
                putJsonObject("client") {
                    put("platform", "android")
                    put("version", appVersion)
                    put("os", "Android ${android.os.Build.VERSION.RELEASE}")
                    put("device", "${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL}")
                }
            },
        )

    suspend fun completeProfile(username: String, displayName: String): UserEnvelope =
        api.post(
            "/auth/complete-profile",
            buildJsonObject {
                put("username", username)
                put("displayName", displayName)
            },
        )

    suspend fun usernameAvailable(username: String): UsernameAvailability =
        api.get("/auth/username-available", mapOf("username" to username))

    suspend fun gatewayTicket(): GatewayTicket = api.post("/auth/gateway-ticket")

    suspend fun logout(): Ok = api.post("/auth/logout")

    suspend fun logoutAll(): Ok = api.post("/auth/logout-all")

    // ── Me & users ───────────────────────────────────────────────────────────

    suspend fun me(): UserEnvelope = api.get("/users/me")

    suspend fun updateProfile(displayName: String?, bio: String?, pronouns: String?): UserEnvelope =
        api.patch(
            "/users/me",
            buildJsonObject {
                displayName?.let { put("displayName", it) }
                put("bio", bio)
                put("pronouns", pronouns)
            },
        )

    /** Null clears the picture. The old media row is left for the reaper. */
    suspend fun setMyAvatar(mediaId: String?): UserEnvelope =
        api.patch(
            "/users/me",
            buildJsonObject {
                if (mediaId == null) put("avatarMediaId", JsonNull) else put("avatarMediaId", mediaId)
            },
        )

    suspend fun updatePrivacy(key: String, value: String): UserEnvelope =
        api.patch("/users/me/settings", buildJsonObject { putJsonObject("privacy") { put(key, value) } })

    suspend fun updatePrivacyFlag(key: String, value: Boolean): UserEnvelope =
        api.patch("/users/me/settings", buildJsonObject { putJsonObject("privacy") { put(key, value) } })

    suspend fun updateNotificationFlag(key: String, value: Boolean): UserEnvelope =
        api.patch("/users/me/settings", buildJsonObject { putJsonObject("notifications") { put(key, value) } })

    suspend fun updateTheme(theme: String): UserEnvelope =
        api.patch("/users/me/settings", buildJsonObject { putJsonObject("appearance") { put("theme", theme) } })

    suspend fun setPresence(status: String): Ok =
        api.put("/users/me/presence", buildJsonObject { put("status", status) })

    suspend fun user(id: String): UserEnvelope = api.get("/users/$id")

    suspend fun searchUsers(query: String): UsersEnvelope =
        api.get("/users", mapOf("q" to query, "limit" to "20"))

    // ── Social ───────────────────────────────────────────────────────────────

    suspend fun follow(userId: String): JsonElement = api.post("/social/follow/$userId")
    suspend fun unfollow(userId: String): JsonElement = api.delete("/social/follow/$userId")
    suspend fun contacts(): UsersEnvelope = api.get("/social/me/contacts", mapOf("limit" to "100"))
    /** Contacts online right now — the Active Now strip. */
    suspend fun onlineContacts(): OnlineEnvelope = api.get("/social/me/online")
    suspend fun blocks(): UsersEnvelope = api.get("/social/blocks")
    suspend fun block(userId: String): JsonElement =
        api.post("/social/block", buildJsonObject { put("userId", userId) })
    suspend fun unblock(userId: String): JsonElement = api.delete("/social/block/$userId")

    // ── Conversations ────────────────────────────────────────────────────────

    suspend fun conversations(cursor: String? = null, archived: Boolean = false): ConversationsEnvelope =
        api.get(
            "/conversations",
            mapOf("cursor" to cursor, "archived" to archived.toString(), "limit" to "50"),
        )

    suspend fun conversation(id: String): ConversationEnvelope = api.get("/conversations/$id")

    suspend fun createDm(userId: String): ConversationEnvelope =
        api.post(
            "/conversations",
            buildJsonObject {
                put("type", "dm")
                putJsonArray("memberIds") { add(userId) }
            },
        )

    suspend fun createGroup(title: String, memberIds: List<String>): ConversationEnvelope =
        api.post(
            "/conversations",
            buildJsonObject {
                put("type", "group")
                put("title", title)
                putJsonArray("memberIds") { memberIds.forEach { add(it) } }
            },
        )

    suspend fun updateConversation(id: String, title: String? = null, description: String? = null): ConversationEnvelope =
        api.patch(
            "/conversations/$id",
            buildJsonObject {
                title?.let { put("title", it) }
                description?.let { put("description", it) }
            },
        )

    suspend fun setConversationAvatar(id: String, mediaId: String?): ConversationEnvelope =
        api.patch(
            "/conversations/$id",
            buildJsonObject {
                if (mediaId == null) put("avatarMediaId", JsonNull) else put("avatarMediaId", mediaId)
            },
        )

    suspend fun setDisappearing(id: String, seconds: Int): ConversationEnvelope =
        api.patch("/conversations/$id", buildJsonObject { put("disappearingSeconds", seconds) })

    suspend fun setConversationState(
        id: String,
        muted: Boolean? = null,
        pinned: Boolean? = null,
        archived: Boolean? = null,
        draft: String? = null,
    ): Ok = api.patch(
        "/conversations/$id/state",
        buildJsonObject {
            muted?.let { put("notificationLevel", if (it) "none" else "all") }
            pinned?.let { put("isPinned", it) }
            archived?.let { put("isArchived", it) }
            draft?.let { put("draft", it) }
        },
    )

    /**
     * The three-way setting, as opposed to [setState]'s mute toggle. Used by
     * the channel list, where "mentions only" is the setting people actually
     * want for the busy channel they still care about.
     */
    suspend fun setNotificationLevel(id: String, level: String): Ok =
        api.patch(
            "/conversations/$id/state",
            buildJsonObject {
                put("notificationLevel", level)
                // Choosing a level clears any timed mute; otherwise "all" would
                // appear selected while nothing came through.
                put("mutedUntil", JsonNull)
            },
        )

    suspend fun leaveConversation(id: String): JsonElement = api.delete("/conversations/$id")

    suspend fun members(id: String): MembersEnvelope = api.get("/conversations/$id/members", mapOf("limit" to "100"))

    /** The group profile in one round trip: members + presence, counts, active call. */
    suspend fun summary(id: String): SummaryEnvelope = api.get("/conversations/$id/summary")

    /** The media wall: image/video/GIF messages, newest first, seq-cursored. */
    suspend fun mediaWall(id: String, before: Long? = null, limit: Int = 30): HistoryEnvelope =
        api.get(
            "/conversations/$id/media",
            mapOf("limit" to limit.toString(), "before" to before?.toString()),
        )

    suspend fun addMembers(id: String, userIds: List<String>): JsonElement =
        api.post(
            "/conversations/$id/members",
            buildJsonObject { putJsonArray("userIds") { userIds.forEach { add(it) } } },
        )

    suspend fun removeMember(id: String, userId: String): JsonElement =
        api.delete("/conversations/$id/members/$userId")

    suspend fun createInvite(id: String): InviteEnvelope =
        api.post("/conversations/$id/invites", buildJsonObject { put("maxUses", 0) })

    suspend fun invites(id: String): InvitesEnvelope = api.get("/conversations/$id/invites")

    /** Pass null to clear all flair. */
    suspend fun setAppearance(id: String, appearance: ConversationAppearance?): ConversationEnvelope =
        api.patch(
            "/conversations/$id",
            buildJsonObject {
                if (appearance == null) {
                    put("appearance", JsonNull)
                } else {
                    putJsonObject("appearance") {
                        appearance.accent?.let { put("accent", it) }
                        appearance.gradient?.let { g -> putJsonArray("gradient") { g.forEach { add(it) } } }
                        put("effect", appearance.effect)
                        appearance.emoji?.let { put("emoji", it) }
                    }
                }
            },
        )

    suspend fun setPublic(id: String, isPublic: Boolean): ConversationEnvelope =
        api.patch("/conversations/$id", buildJsonObject { put("isPublic", isPublic) })

    // ── Messages ─────────────────────────────────────────────────────────────

    suspend fun history(
        conversationId: String,
        before: Long? = null,
        after: Long? = null,
        around: Long? = null,
        limit: Int = 50,
    ): HistoryEnvelope = api.get(
        "/conversations/$conversationId/messages",
        mapOf(
            "limit" to limit.toString(),
            "before" to before?.toString(),
            "after" to after?.toString(),
            "around" to around?.toString(),
        ),
    )

    /**
     * @param nonce Generated by the caller so the optimistic bubble and the
     *   server's copy share an identity. Retrying with the same nonce returns
     *   the original message instead of duplicating it.
     */
    suspend fun sendText(
        conversationId: String,
        text: String,
        nonce: String = newNonce(),
        replyToId: String? = null,
        threadRootId: String? = null,
        mentions: List<MentionSpan> = emptyList(),
    ): MessageEnvelope = api.post(
        "/conversations/$conversationId/messages",
        buildJsonObject {
            put("nonce", nonce)
            put("type", "text")
            put("content", text)
            replyToId?.let { put("replyToId", it) }
            threadRootId?.let { put("threadRootId", it) }
            if (mentions.isNotEmpty()) {
                putJsonArray("entities") {
                    mentions.forEach { m ->
                        add(
                            buildJsonObject {
                                put("type", "mention")
                                put("offset", m.offset)
                                put("length", m.length)
                                put("userId", m.userId)
                            },
                        )
                    }
                }
            }
        },
    )

    data class MentionSpan(val offset: Int, val length: Int, val userId: String)

    suspend fun thread(conversationId: String, rootId: String, after: Long? = null): HistoryEnvelope =
        api.get(
            "/conversations/$conversationId/messages/$rootId/thread",
            mapOf("limit" to "50", "after" to after?.toString()),
        )

    suspend fun message(conversationId: String, messageId: String): MessageEnvelope =
        api.get("/conversations/$conversationId/messages/$messageId")

    /**
     * Press a button on a bot's message. Returns the message as it stands
     * after the bot responded, which for a prompt is usually the outcome card
     * with its buttons retired.
     */
    suspend fun pressComponent(
        conversationId: String,
        messageId: String,
        customId: String,
    ): MessageEnvelope = api.post(
        "/conversations/$conversationId/messages/$messageId/interactions",
        buildJsonObject { put("customId", customId) },
    )

    /** Slash commands offered here, for composer autocomplete. */
    suspend fun conversationCommands(conversationId: String): BotCommandsEnvelope =
        api.get("/conversations/$conversationId/commands")

    suspend fun reactionsFor(conversationId: String, messageId: String): ReactionsEnvelope =
        api.get("/conversations/$conversationId/messages/$messageId/reactions")

    suspend fun forward(messageIds: List<String>, toConversationIds: List<String>): JsonElement =
        api.post(
            "/conversations/messages/forward",
            buildJsonObject {
                putJsonArray("messageIds") { messageIds.forEach { add(it) } }
                putJsonArray("toConversationIds") { toConversationIds.forEach { add(it) } }
            },
        )

    suspend fun discover(): DiscoverEnvelope = api.get("/conversations/discover", mapOf("limit" to "50"))

    suspend fun joinPublic(conversationId: String): ConversationEnvelope =
        api.post("/conversations/$conversationId/join")

    suspend fun setMemberRole(conversationId: String, userId: String, role: String): JsonElement =
        api.patch(
            "/conversations/$conversationId/members/$userId",
            buildJsonObject { put("role", role) },
        )

    /** The group's half of an affiliation. The member still has to display it. */
    suspend fun setMemberAffiliate(conversationId: String, userId: String, on: Boolean): JsonElement =
        api.patch(
            "/conversations/$conversationId/members/$userId",
            buildJsonObject { put("isAffiliate", on) },
        )

    /** The member's half: which affiliated group to show, or null for none. */
    suspend fun setAffiliation(conversationId: String?): UserEnvelope =
        api.patch(
            "/users/me",
            buildJsonObject {
                if (conversationId == null) put("affiliationConversationId", JsonNull)
                else put("affiliationConversationId", conversationId)
            },
        )

    // ── Named roles ──────────────────────────────────────────────────────────

    suspend fun roles(conversationId: String): RolesEnvelope =
        api.get("/conversations/$conversationId/roles")

    suspend fun createRole(
        conversationId: String,
        name: String,
        color: String?,
        permissions: String,
        position: Int = 0,
        isHoisted: Boolean = false,
    ): RoleEnvelope =
        api.post(
            "/conversations/$conversationId/roles",
            buildJsonObject {
                put("name", name)
                if (color == null) put("color", JsonNull) else put("color", color)
                put("permissions", permissions)
                put("position", position)
                put("isHoisted", isHoisted)
            },
        )

    suspend fun updateRole(
        conversationId: String,
        roleId: String,
        name: String? = null,
        color: String? = null,
        permissions: String? = null,
    ): RoleEnvelope =
        api.patch(
            "/conversations/$conversationId/roles/$roleId",
            buildJsonObject {
                name?.let { put("name", it) }
                color?.let { put("color", it) }
                permissions?.let { put("permissions", it) }
            },
        )

    suspend fun deleteRole(conversationId: String, roleId: String): JsonElement =
        api.delete("/conversations/$conversationId/roles/$roleId")

    /** Full replacement — send every role the member should end up with. */
    suspend fun setMemberRoles(conversationId: String, userId: String, roleIds: List<String>): RolesEnvelope =
        api.put(
            "/conversations/$conversationId/members/$userId/roles",
            buildJsonObject { putJsonArray("roleIds") { roleIds.forEach { add(it) } } },
        )

    // ── Spaces & channels ────────────────────────────────────────────────────

    suspend fun channels(spaceId: String): ChannelsEnvelope =
        api.get("/conversations/$spaceId/channels")

    suspend fun createChannel(
        spaceId: String,
        title: String,
        isAnnouncement: Boolean = false,
        position: Int = 0,
    ): ChannelEnvelope =
        api.post(
            "/conversations/$spaceId/channels",
            buildJsonObject {
                put("title", title)
                put("isAnnouncement", isAnnouncement)
                put("position", position)
            },
        )

    /** Full ordered list; the server rewrites every position from the index. */
    suspend fun reorderChannels(spaceId: String, channelIds: List<String>): JsonElement =
        api.put(
            "/conversations/$spaceId/channels/order",
            buildJsonObject { putJsonArray("channelIds") { channelIds.forEach { add(it) } } },
        )

    suspend fun deleteChannel(spaceId: String, channelId: String): JsonElement =
        api.delete("/conversations/$spaceId/channels/$channelId")

    /** One-way and owner-only; the group's history moves into the first channel. */
    suspend fun upgradeToSpace(conversationId: String, firstChannelTitle: String = "general"): UpgradeEnvelope =
        api.post(
            "/conversations/$conversationId/upgrade-to-space",
            buildJsonObject { put("firstChannelTitle", firstChannelTitle) },
        )

    // ── Media ────────────────────────────────────────────────────────────────

    suspend fun createUpload(
        filename: String,
        mimeType: String,
        size: Int,
        purpose: String = "attachment",
        width: Int? = null,
        height: Int? = null,
        checksum: String? = null,
    ): UploadEnvelope = api.post(
        "/media/uploads",
        buildJsonObject {
            put("filename", filename)
            put("mimeType", mimeType)
            put("size", size)
            put("purpose", purpose)
            width?.let { put("width", it) }
            height?.let { put("height", it) }
            checksum?.let { put("checksum", it) }
        },
    )

    suspend fun confirmUpload(mediaId: String): MediaEnvelope = api.post("/media/$mediaId/confirm")

    /** Send a message carrying already-uploaded media. */
    suspend fun sendAttachment(
        conversationId: String,
        attachmentIds: List<String>,
        caption: String? = null,
        type: String = "image",
        nonce: String = newNonce(),
    ): MessageEnvelope = api.post(
        "/conversations/$conversationId/messages",
        buildJsonObject {
            put("nonce", nonce)
            put("type", type)
            if (!caption.isNullOrBlank()) put("content", caption)
            putJsonArray("attachmentIds") { attachmentIds.forEach { add(it) } }
        },
    )

    suspend fun sendSticker(conversationId: String, stickerId: String, nonce: String = newNonce()): MessageEnvelope =
        api.post(
            "/conversations/$conversationId/messages",
            buildJsonObject {
                put("nonce", nonce)
                put("type", "sticker")
                put("stickerId", stickerId)
            },
        )

    suspend fun sendGif(conversationId: String, gif: GifResult, nonce: String = newNonce()): MessageEnvelope =
        api.post(
            "/conversations/$conversationId/messages",
            buildJsonObject {
                put("nonce", nonce)
                put("type", "gif")
                putJsonObject("gif") {
                    put("provider", gif.provider)
                    put("id", gif.id)
                    put("url", gif.url)
                    put("previewUrl", gif.previewUrl)
                    put("width", gif.width)
                    put("height", gif.height)
                    put("title", gif.title)
                }
            },
        )

    suspend fun sendPoll(
        conversationId: String,
        question: String,
        options: List<String>,
        multiSelect: Boolean,
        nonce: String = newNonce(),
    ): MessageEnvelope = api.post(
        "/conversations/$conversationId/messages",
        buildJsonObject {
            put("nonce", nonce)
            put("type", "poll")
            putJsonObject("poll") {
                put("question", question)
                putJsonArray("options") { options.forEach { add(it) } }
                put("multiSelect", multiSelect)
                put("anonymous", false)
            }
        },
    )

    suspend fun editMessage(conversationId: String, messageId: String, content: String): MessageEnvelope =
        api.patch(
            "/conversations/$conversationId/messages/$messageId",
            buildJsonObject { put("content", content) },
        )

    suspend fun deleteMessage(conversationId: String, messageId: String, forEveryone: Boolean = true): JsonElement =
        api.delete(
            "/conversations/$conversationId/messages/$messageId",
            mapOf("forEveryone" to forEveryone.toString()),
        )

    suspend fun react(conversationId: String, messageId: String, emoji: String): Ok =
        api.put(
            "/conversations/$conversationId/messages/$messageId/reactions",
            buildJsonObject { put("emoji", emoji) },
        )

    suspend fun unreact(conversationId: String, messageId: String, emoji: String): Ok =
        api.delete(
            "/conversations/$conversationId/messages/$messageId/reactions",
            mapOf("emoji" to emoji),
        )

    suspend fun pin(conversationId: String, messageId: String): JsonElement =
        api.put("/conversations/$conversationId/pins/$messageId")

    suspend fun unpin(conversationId: String, messageId: String): JsonElement =
        api.delete("/conversations/$conversationId/pins/$messageId")

    suspend fun pins(conversationId: String): PinsEnvelope = api.get("/conversations/$conversationId/pins")

    suspend fun votePoll(conversationId: String, messageId: String, optionIds: List<String>): JsonElement =
        api.post(
            "/conversations/$conversationId/messages/$messageId/poll/vote",
            buildJsonObject { putJsonArray("optionIds") { optionIds.forEach { add(it) } } },
        )

    suspend fun markRead(conversationId: String, seq: Long): ReadAck =
        api.post("/conversations/$conversationId/read", buildJsonObject { put("seq", seq) })

    // ── Stickers & GIFs ──────────────────────────────────────────────────────

    suspend fun installedPacks(): PacksEnvelope = api.get("/stickers/installed")
    suspend fun stickerStore(query: String? = null): PacksEnvelope =
        api.get("/stickers/store", mapOf("q" to query, "limit" to "40"))
    suspend fun installPack(packId: String): JsonElement = api.post("/stickers/packs/$packId/install")
    suspend fun recentStickers(): StickersEnvelope = api.get("/stickers/recent")
    suspend fun suggestStickers(emoji: String): StickersEnvelope =
        api.get("/stickers/suggest", mapOf("emoji" to emoji))

    suspend fun searchGifs(query: String, pos: String? = null): GifsEnvelope =
        api.get("/gifs/search", mapOf("q" to query, "pos" to pos, "limit" to "30"))
    suspend fun recentGifs(): GifsEnvelope = api.get("/gifs/recent")
    suspend fun rememberGif(gif: GifResult): Ok = api.post(
        "/gifs/recent",
        buildJsonObject {
            put("id", gif.id); put("provider", gif.provider); put("url", gif.url)
            put("previewUrl", gif.previewUrl); put("width", gif.width); put("height", gif.height)
            put("title", gif.title)
        },
    )

    // ── Calls ────────────────────────────────────────────────────────────────

    suspend fun startCall(conversationId: String, video: Boolean): CallEnvelope =
        api.post(
            "/calls",
            buildJsonObject {
                put("conversationId", conversationId)
                put("mode", if (video) "video" else "audio")
                put("nonce", newNonce())
            },
        )

    suspend fun joinCall(callId: String, video: Boolean): CallEnvelope =
        api.post(
            "/calls/$callId/join",
            buildJsonObject {
                put("publishAudio", true)
                put("publishVideo", video)
            },
        )

    suspend fun declineCall(callId: String): Ok =
        api.post("/calls/$callId/decline", buildJsonObject { put("reason", "declined") })

    suspend fun leaveCall(callId: String): JsonElement = api.post("/calls/$callId/leave")
    suspend fun endCall(callId: String): Ok = api.post("/calls/$callId/end")
    suspend fun call(callId: String): CallEnvelope = api.get("/calls/$callId")

    suspend fun setCallState(callId: String, muted: Boolean? = null, video: Boolean? = null): Ok =
        api.patch(
            "/calls/$callId/state",
            buildJsonObject {
                muted?.let { put("isMuted", it) }
                video?.let { put("isVideoEnabled", it) }
            },
        )

    // ── Sync, search, devices ────────────────────────────────────────────────

    suspend fun badge(): Badge = api.get("/sync/badge")

    suspend fun searchMessages(query: String, conversationId: String? = null): SearchEnvelope =
        api.get("/search/messages", mapOf("q" to query, "conversationId" to conversationId))

    suspend fun devices(): DevicesEnvelope = api.get("/devices")
    suspend fun revokeDevice(id: String): JsonElement = api.delete("/devices/$id")

    suspend fun registerPush(token: String): Ok =
        api.put(
            "/devices/me/push",
            buildJsonObject {
                put("platform", "android")
                put("token", token)
            },
        )

    suspend fun report(targetType: String, targetId: String, reason: String, detail: String?): JsonElement =
        api.post(
            "/moderation/reports",
            buildJsonObject {
                put("targetType", targetType)
                put("targetId", targetId)
                put("reason", reason)
                detail?.let { put("detail", it) }
            },
        )

    companion object {
        fun newNonce(): String = UUID.randomUUID().toString()
    }
}
