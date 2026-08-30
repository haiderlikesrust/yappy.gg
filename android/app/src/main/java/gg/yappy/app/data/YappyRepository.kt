package gg.yappy.app.data

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.add
import kotlinx.serialization.json.addJsonObject
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

    /** Describes this handset, so the account's session list is readable. */
    private fun kotlinx.serialization.json.JsonObjectBuilder.clientInfo(appVersion: String) {
        putJsonObject("client") {
            put("platform", "android")
            put("version", appVersion)
            put("os", "Android ${android.os.Build.VERSION.RELEASE}")
            put("device", "${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL}")
        }
    }

    suspend fun register(
        email: String,
        password: String,
        username: String,
        displayName: String,
        appVersion: String,
    ): AuthTokens = api.post(
        "/auth/register",
        buildJsonObject {
            put("email", email)
            put("password", password)
            put("username", username)
            if (displayName.isNotBlank()) put("displayName", displayName)
            clientInfo(appVersion)
        },
    )

    suspend fun login(email: String, password: String, appVersion: String): AuthTokens =
        api.post(
            "/auth/login",
            buildJsonObject {
                put("email", email)
                put("password", password)
                clientInfo(appVersion)
            },
        )

    /** The provider's ID token, verified server-side. Same session shape back. */
    suspend fun socialSignIn(provider: String, idToken: String, appVersion: String): AuthTokens =
        api.post(
            "/auth/social",
            buildJsonObject {
                put("provider", provider)
                put("idToken", idToken)
                clientInfo(appVersion)
            },
        )

    /**
     * Publish this device's public keys. See DeviceKeys for why this happens
     * long before anything is encrypted.
     */
    suspend fun publishKeys(
        deviceId: String,
        identityKey: String,
        signedPreKeyId: Int,
        signedPreKey: String,
        signature: String,
        oneTimePreKeys: List<Pair<Int, String>>,
        /** What this device can read, signed by its identity key. */
        formats: List<Int>,
        formatsSignature: String,
    ): PublishedKeys = api.post(
        "/keys/publish",
        buildJsonObject {
            put("deviceId", deviceId)
            put("identityKey", identityKey)
            putJsonObject("signedPreKey") {
                put("id", signedPreKeyId)
                put("key", signedPreKey)
                put("signature", signature)
            }
            putJsonArray("oneTimePreKeys") {
                for ((id, key) in oneTimePreKeys) {
                    addJsonObject {
                        put("id", id)
                        put("key", key)
                    }
                }
            }
            putJsonObject("formats") {
                putJsonArray("versions") { formats.forEach { add(it) } }
                put("signature", formatsSignature)
            }
        },
    )

    /**
     * Key bundles for the devices that still need one.
     *
     * A claim spends a one-time prekey from every device it answers about, so
     * the caller names the devices it has no ratchet session with rather than
     * asking about everybody every time.
     */
    suspend fun claimKeys(userIds: List<String>, deviceIds: List<String>? = null): ClaimedKeys =
        api.post(
            "/keys/claim",
            buildJsonObject {
                putJsonArray("userIds") { userIds.forEach { add(it) } }
                if (deviceIds != null) putJsonArray("deviceIds") { deviceIds.forEach { add(it) } }
            },
        )

    /**
     * This device's copy of an encrypted body.
     *
     * A realtime event cannot carry it — one event reaches every device in
     * the conversation and each needs a different ciphertext — so a message
     * that arrives live is asked about here, once.
     */
    suspend fun messageEnvelope(conversationId: String, messageId: String): CipherEnvelope =
        api.get("/conversations/$conversationId/messages/$messageId/envelope")

    /**
     * Every device key one person currently has.
     *
     * The identity keys here are what a sealed message's signature is checked
     * against, and they are the same keys the safety number is computed from —
     * one directory, one answer to "is this really them".
     */
    suspend fun userKeys(userId: String): UserKeys = api.get("/keys/user/$userId")

    /** How many one-time prekeys this device has left unclaimed. */
    suspend fun preKeyCount(): PreKeyCount = api.get("/keys/count")

    /**
     * Ask for a reset code.
     *
     * Answers the same whether or not the address has an account — the server
     * will not say, because saying is a way to ask who has one.
     */
    suspend fun forgotPassword(email: String): Ok =
        api.post(
            "/auth/password/forgot",
            buildJsonObject { put("email", email) },
        )

    /** Finish a reset. Ends every other session and hands this one back. */
    suspend fun resetPassword(
        email: String,
        code: String,
        password: String,
        appVersion: String,
    ): AuthTokens = api.post(
        "/auth/password/reset",
        buildJsonObject {
            put("email", email)
            put("code", code)
            put("password", password)
            clientInfo(appVersion)
        },
    )

    suspend fun changePassword(currentPassword: String, newPassword: String): AuthTokens =
        api.post(
            "/auth/change-password",
            buildJsonObject {
                put("currentPassword", currentPassword)
                put("newPassword", newPassword)
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

    suspend fun me(): UserEnvelope = api.get("/users/me", cacheTo = "me")

    /**
     * Rename. The server keeps the old handle in `username_history` so old
     * mentions still resolve, and rate-limits this to roughly one a day.
     */
    suspend fun changeUsername(username: String): UserEnvelope =
        api.patch("/users/me", buildJsonObject { put("username", username) })

    /**
     * Resolve a bare @username to a full profile. 404s when the name does not
     * exist or its owner opted out of username discovery.
     */
    suspend fun userByUsername(username: String): UserEnvelope =
        api.get("/users/by-username/$username")

    /** The profile banner, same contract as the avatar: null clears it. */
    suspend fun setMyBanner(mediaId: String?): UserEnvelope =
        api.patch(
            "/users/me",
            buildJsonObject {
                if (mediaId == null) put("bannerMediaId", JsonNull) else put("bannerMediaId", mediaId)
            },
        )

    /**
     * Soft delete: the account is scrubbed immediately and purged after thirty
     * days. Signing back in during that window is what un-deletes it, which is
     * why the client signs out rather than pretending the session survives.
     */
    suspend fun deleteAccount(): JsonElement = api.delete("/users/me")

    /**
     * Quiet hours, or [clearQuietHours] to switch the window off entirely.
     *
     * Sent whole rather than key-by-key: the server merges at the
     * `notifications` level, not inside `quietHours`, so a partial object would
     * drop whichever fields it omitted.
     */
    suspend fun setQuietHours(start: String, end: String, enabled: Boolean): UserEnvelope =
        api.patch(
            "/users/me/settings",
            buildJsonObject {
                putJsonObject("notifications") {
                    putJsonObject("quietHours") {
                        put("enabled", enabled)
                        put("start", start)
                        put("end", end)
                        // The server stores the zone so a trip abroad does not
                        // move someone's quiet hours to the middle of their
                        // afternoon.
                        put("timezone", java.util.TimeZone.getDefault().id)
                    }
                }
            },
        )

    suspend fun clearQuietHours(): UserEnvelope =
        api.patch(
            "/users/me/settings",
            buildJsonObject { putJsonObject("notifications") { put("quietHours", JsonNull) } },
        )

    /** 0.8–1.6. Stored on the account so a new device inherits it. */
    suspend fun setFontScale(scale: Float): UserEnvelope =
        api.patch(
            "/users/me/settings",
            buildJsonObject { putJsonObject("appearance") { put("fontScale", scale) } },
        )

    suspend fun updateProfile(displayName: String?, bio: String?, pronouns: String?): UserEnvelope =
        api.patch(
            "/users/me",
            buildJsonObject {
                displayName?.let { put("displayName", it) }
                put("bio", bio)
                put("pronouns", pronouns)
            },
        )

    /** Null returns the profile to its derived per-id colour. */
    suspend fun setMyFlair(gradient: List<String>?): UserEnvelope =
        api.patch(
            "/users/me",
            buildJsonObject {
                if (gradient == null) put("flair", JsonNull)
                else putJsonObject("flair") { putJsonArray("gradient") { gradient.forEach { add(it) } } }
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

    /** For the settings that are not booleans — `sound` is a name or "none". */
    suspend fun updateNotificationValue(key: String, value: String): UserEnvelope =
        api.patch("/users/me/settings", buildJsonObject { putJsonObject("notifications") { put(key, value) } })

    suspend fun updateTheme(theme: String): UserEnvelope =
        api.patch("/users/me/settings", buildJsonObject { putJsonObject("appearance") { put("theme", theme) } })

    /**
     * @param customStatus the free-text line beside the dot. Pass an empty
     *   string to clear it; leave null to keep whatever is stored, because
     *   sending `null` would erase a status the caller never intended to touch.
     * @param expiresAt when to clear it automatically, ISO-8601.
     */
    suspend fun setPresence(
        status: String,
        customStatus: String? = null,
        expiresAt: String? = null,
    ): Ok =
        api.put(
            "/users/me/presence",
            buildJsonObject {
                put("status", status)
                if (customStatus != null) put("customStatus", customStatus.ifBlank { null })
                if (expiresAt != null) put("expiresAt", expiresAt)
            },
        )

    /**
     * The last couple of dozen profiles opened, in memory and nowhere else.
     *
     * Deliberately not the disk cache — `conversation()` above explains why a
     * profile glanced at must not evict the snapshots other screens depend on
     * at cold start, and that reasoning still holds. This is the other half of
     * the same trade: reopening someone should not flash a spinner at a screen
     * whose content the app is still holding, and a handful of objects that die
     * with the process cost nothing on disk.
     *
     * Access-ordered and bounded, so it is the people you actually look at that
     * stay, and a long session cannot grow it without limit.
     */
    private val recentUsers = object : LinkedHashMap<String, FullUser>(0, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, FullUser>) = size > 24
    }

    /** What we already know about them, if anything. Never a network call. */
    fun cachedUser(id: String): FullUser? = synchronized(recentUsers) { recentUsers[id] }

    suspend fun user(id: String): UserEnvelope =
        api.get<UserEnvelope>("/users/$id").also {
            synchronized(recentUsers) { recentUsers[id] = it.user }
        }

    suspend fun searchUsers(query: String): UsersEnvelope =
        api.get("/users", mapOf("q" to query, "limit" to "20"))

    // ── Social ───────────────────────────────────────────────────────────────

    /**
     * Follow, and take the server's word for what that produced.
     *
     * `isMutual` is the half a client cannot work out for itself: following
     * someone who already followed you completes the pair, and only the server
     * knows whether it did. Returning it lets the button settle on its final
     * state from the response rather than needing a refetch to find out.
     */
    suspend fun follow(userId: String): FollowResult = api.post("/social/follow/$userId")
    suspend fun unfollow(userId: String): FollowResult = api.delete("/social/follow/$userId")
    suspend fun contacts(): UsersEnvelope = api.get("/social/me/contacts", mapOf("limit" to "100"))
    /** Contacts online right now — the Active Now strip. */
    suspend fun onlineContacts(): OnlineEnvelope = api.get("/social/me/online")
    suspend fun blocks(): UsersEnvelope = api.get("/social/blocks")
    suspend fun block(userId: String): JsonElement =
        api.post("/social/block", buildJsonObject { put("userId", userId) })
    suspend fun unblock(userId: String): JsonElement = api.delete("/social/block/$userId")

    // ── Conversations ────────────────────────────────────────────────────────

    /** Name the group pet (owner/admin). Null un-names it. */
    suspend fun nameGroupPet(conversationId: String, name: String?): JsonElement =
        api.patch(
            "/conversations/$conversationId/pet",
            buildJsonObject { if (name == null) put("name", JsonNull) else put("name", name) },
        )

    /** Ask staff to verify a group. 204 on success; 409 when already queued
     *  or already verified, with the reason in the message. */
    suspend fun requestVerification(
        conversationId: String,
        purpose: String,
        link: String?,
        note: String?,
    ) {
        api.post<kotlinx.serialization.json.JsonObject>(
            "/conversations/$conversationId/verification-request",
            buildJsonObject {
                put("purpose", purpose)
                link?.takeIf { it.isNotBlank() }?.let { put("link", it) }
                note?.takeIf { it.isNotBlank() }?.let { put("note", it) }
            },
        )
    }

    suspend fun conversations(cursor: String? = null, archived: Boolean = false): ConversationsEnvelope =
        api.get(
            "/conversations",
            mapOf("cursor" to cursor, "archived" to archived.toString(), "limit" to "50"),
            // Only the view everyone opens the app to. The archived list and
            // deeper pages are places people go, not places the app wakes up.
            cacheTo = if (cursor == null && !archived) "conversations" else null,
        )

    /**
     * @param cacheTo Leave the response in the snapshot cache, so the next cold
     *   open of this screen paints instantly instead of flashing an absence
     *   state. Only the space screen asks; caching every conversation ever
     *   glanced at would churn the cache for screens that already have their
     *   own seeding.
     */
    suspend fun conversation(id: String, cacheTo: Boolean = false): ConversationEnvelope =
        api.get("/conversations/$id", cacheTo = if (cacheTo) "conversation_$id" else null)

    suspend fun createDm(userId: String): ConversationEnvelope =
        api.post(
            "/conversations",
            buildJsonObject {
                put("type", "dm")
                putJsonArray("memberIds") { add(userId) }
            },
        )

    /**
     * @param campfireSeconds non-null makes this a campfire: the group and
     *   everything in it is deleted this many seconds from now.
     */
    suspend fun createGroup(
        title: String,
        memberIds: List<String>,
        campfireSeconds: Int? = null,
    ): ConversationEnvelope =
        api.post(
            "/conversations",
            buildJsonObject {
                put("type", "group")
                put("title", title)
                putJsonArray("memberIds") { memberIds.forEach { add(it) } }
                if (campfireSeconds != null) put("campfireSeconds", campfireSeconds)
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

    /** Seconds a member must wait between messages. 0 is off, 21600 the cap. */
    suspend fun setSlowMode(id: String, seconds: Int): ConversationEnvelope =
        api.patch("/conversations/$id", buildJsonObject { put("slowModeSeconds", seconds) })

    /** `since_join` | `full`. Only affects members who join after the change. */
    suspend fun setHistoryVisibility(id: String, visibility: String): ConversationEnvelope =
        api.patch("/conversations/$id", buildJsonObject { put("historyVisibility", visibility) })

    /**
     * The conversation-wide permission floor, as a decimal-string bitfield.
     * Clearing SEND_MESSAGES from it is what "only admins can post" means —
     * roles grant it back to the people who should still have it.
     */
    suspend fun setBasePermissions(id: String, bits: String): ConversationEnvelope =
        api.patch("/conversations/$id", buildJsonObject { put("basePermissions", bits) })

    /**
     * Clear the floor, so the conversation inherits its type default again.
     *
     * Null is not the same as `"0"`: null means inherit, `"0"` means a floor
     * of nothing — a channel closed to everybody until a role overwrite lets
     * someone back in. Without this a channel could be gated and never
     * ungated.
     */
    suspend fun clearBasePermissions(id: String): ConversationEnvelope =
        api.patch("/conversations/$id", buildJsonObject { put("basePermissions", JsonNull) })

    // ── Channel access ───────────────────────────────────────────────────
    //
    // What each role may do in one channel. The missing piece between a
    // floor, which applies to everybody, and space-wide roles, which only
    // ever add and apply everywhere: together they say "this channel is for
    // Premium".

    // ── Incoming webhooks ────────────────────────────────────────────────

    suspend fun webhooks(conversationId: String): WebhooksEnvelope =
        api.get("/conversations/$conversationId/webhooks")

    suspend fun createWebhook(conversationId: String, name: String): WebhookEnvelope =
        api.post(
            "/conversations/$conversationId/webhooks",
            buildJsonObject { put("name", name) },
        )

    suspend fun deleteWebhook(conversationId: String, webhookId: String): JsonElement =
        api.delete("/conversations/$conversationId/webhooks/$webhookId")

    /** Who changed what, newest first. MANAGE_CONVERSATION only. */
    suspend fun audit(conversationId: String, before: String? = null, limit: Int = 40): AuditEnvelope =
        api.get(
            "/conversations/$conversationId/audit",
            mapOf("limit" to limit.toString(), "before" to before),
        )

    suspend fun channelOverwrites(conversationId: String): OverwritesEnvelope =
        api.get("/conversations/$conversationId/permissions")

    suspend fun setChannelOverwrite(
        conversationId: String,
        roleId: String,
        allow: String,
        deny: String = "0",
    ): OverwriteEnvelope =
        api.put(
            "/conversations/$conversationId/permissions/$roleId",
            buildJsonObject {
                put("allow", allow)
                put("deny", deny)
            },
        )

    suspend fun removeChannelOverwrite(conversationId: String, roleId: String): JsonElement =
        api.delete("/conversations/$conversationId/permissions/$roleId")

    // ── Bans ─────────────────────────────────────────────────────────────────

    /**
     * Needs BAN_MEMBERS — the list names both the banned and the banner, so it
     * is staff information rather than part of the member roster.
     */
    suspend fun bans(id: String): BansEnvelope = api.get("/conversations/$id/bans")

    suspend fun ban(id: String, userId: String, reason: String? = null): JsonElement =
        api.post(
            "/conversations/$id/bans/$userId",
            buildJsonObject { reason?.let { put("reason", it) } },
        )

    suspend fun unban(id: String, userId: String): JsonElement =
        api.delete("/conversations/$id/bans/$userId")

    /**
     * @param mutedUntil Three-valued on purpose: [Unset] leaves it alone, a
     *   date sets a timed mute, and null clears one. A plain nullable could not
     *   say "clear" without also meaning "don't touch".
     */
    suspend fun setConversationState(
        id: String,
        muted: Boolean? = null,
        pinned: Boolean? = null,
        archived: Boolean? = null,
        draft: String? = null,
        mutedUntil: Any? = Unset,
    ): Ok = api.patch(
        "/conversations/$id/state",
        buildJsonObject {
            muted?.let { put("notificationLevel", if (it) "none" else "all") }
            pinned?.let { put("isPinned", it) }
            archived?.let { put("isArchived", it) }
            draft?.let { put("draft", it) }
            if (mutedUntil !== Unset) {
                val value = mutedUntil as String?
                if (value == null) put("mutedUntil", JsonNull) else put("mutedUntil", value)
            }
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

    /** People you already know inside this group — mutuals, follows, contacts. */
    suspend fun knownPeople(id: String): KnownPeople = api.get("/conversations/$id/mutuals")

    /** Who has this conversation open right now. Live changes arrive as events. */
    suspend fun viewersHere(id: String): ViewersEnvelope = api.get("/conversations/$id/here")

    /**
     * Bots anyone may add. Mounted at `/apps`, not `/bots` — the resource is an
     * *application*, and the bot user is one of the things it owns.
     */
    suspend fun botDirectory(): BotDirectory = api.get("/apps/directory")

    /** The media wall: image/video/GIF messages, newest first, seq-cursored. */
    suspend fun mediaWall(id: String, before: Long? = null, limit: Int = 30): HistoryEnvelope =
        api.get(
            "/conversations/$id/media",
            mapOf("limit" to limit.toString(), "before" to before?.toString()),
        )

    /** What happened here since you last read it. */
    suspend fun catchUp(id: String): CatchUp = api.get("/conversations/$id/catchup")

    suspend fun addMembers(id: String, userIds: List<String>): JsonElement =
        api.post(
            "/conversations/$id/members",
            buildJsonObject { putJsonArray("userIds") { userIds.forEach { add(it) } } },
        )

    suspend fun removeMember(id: String, userId: String): JsonElement =
        api.delete("/conversations/$id/members/$userId")

    /** `maxUses: 0` is unlimited; null [expiresInSeconds] never expires. */
    suspend fun createInvite(
        id: String,
        maxUses: Int = 0,
        expiresInSeconds: Int? = null,
        /** A role the link hands to whoever redeems it. Escalation-guarded
         *  server-side: you cannot give away bits you do not hold. */
        roleId: String? = null,
    ): InviteEnvelope =
        api.post(
            "/conversations/$id/invites",
            buildJsonObject {
                put("maxUses", maxUses)
                expiresInSeconds?.let { put("expiresInSeconds", it) }
                roleId?.let { put("roleId", it) }
            },
        )

    /**
     * Revoking is a soft delete server-side, so a link that has been shared
     * around stops working rather than silently rotating to a new owner.
     */
    suspend fun revokeInvite(id: String, code: String): JsonElement =
        api.delete("/conversations/$id/invites/$code")

    suspend fun invites(id: String): InvitesEnvelope = api.get("/conversations/$id/invites")

    /** What an invite code points at, without joining it. 404 means expired,
     *  revoked, or never real. */
    suspend fun invitePreview(code: String): InvitePreview =
        api.get("/conversations/invites/$code")

    suspend fun joinInvite(code: String): JoinResult =
        api.post("/conversations/invites/$code/join")

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
        // The newest page only — the one a reopened chat paints first. Cursored
        // pages are scrollback, and scrollback can wait a fetch.
        cacheTo = if (before == null && after == null && around == null) {
            "history_$conversationId"
        } else {
            null
        },
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
        /**
         * One ciphertext per recipient device, for a private send. When this
         * is set, `text` is the notice a client that cannot decrypt shows —
         * the real words are inside the envelopes.
         */
        envelopes: List<Pair<String, String>> = emptyList(),
    ): MessageEnvelope = api.post(
        "/conversations/$conversationId/messages",
        buildJsonObject {
            put("nonce", nonce)
            put("type", "text")
            put("content", text)
            if (envelopes.isNotEmpty()) {
                putJsonArray("envelopes") {
                    envelopes.forEach { (deviceId, ciphertext) ->
                        addJsonObject {
                            put("deviceId", deviceId)
                            put("ciphertext", ciphertext)
                        }
                    }
                }
            }
            replyToId?.let { put("replyToId", it) }
            threadRootId?.let { put("threadRootId", it) }
            if (mentions.isNotEmpty()) {
                putJsonArray("entities") {
                    mentions.forEach { m ->
                        add(
                            buildJsonObject {
                                put(
                                    "type",
                                    when {
                                        m.userId != null -> "mention"
                                        m.roleId != null -> "mention_role"
                                        else -> "mention_all"
                                    },
                                )
                                put("offset", m.offset)
                                put("length", m.length)
                                m.userId?.let { put("userId", it) }
                                m.roleId?.let { put("roleId", it) }
                            },
                        )
                    }
                }
            }
        },
    )

    /**
   * One @ in a message, of whichever kind.
   *
   * `userId` for a person, `roleId` for a role, and neither for the room.
   * Kept as one type because the composer builds them in one pass over the
   * text and they have to come out sorted together.
   */
    data class MentionSpan(
        val offset: Int,
        val length: Int,
        val userId: String? = null,
        val roleId: String? = null,
    )

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

    suspend fun discover(query: String? = null): DiscoverEnvelope =
        api.get("/conversations/discover", mapOf("limit" to "50", "q" to query?.takeIf { it.isNotBlank() }))

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

    /**
     * One member, as this group knows them: their roles here, their rank,
     * the nickname the group calls them by, when they joined.
     *
     * `user(id)` answers who somebody is everywhere and knows about no
     * group, which is why a profile opened from a chat could not say what
     * roles they held in it.
     */
    suspend fun member(conversationId: String, userId: String): MemberEnvelope =
        api.get("/conversations/$conversationId/members/$userId")

    /**
     * Everywhere this account was called, newest first.
     *
     * One list across every group. Paged by message id, which is a UUIDv7
     * and therefore already in time order.
     */
    suspend fun mentions(before: String? = null, limit: Int = 40): MentionsEnvelope =
        api.get(
            "/users/me/mentions",
            mapOf("limit" to limit.toString(), "before" to before),
        )

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
        /** Whether anyone who can speak may ping this role by name. */
        isMentionable: Boolean? = null,
        /** Whether holders get their own section in the member list. */
        isHoisted: Boolean? = null,
    ): RoleEnvelope =
        api.patch(
            "/conversations/$conversationId/roles/$roleId",
            buildJsonObject {
                name?.let { put("name", it) }
                color?.let { put("color", it) }
                permissions?.let { put("permissions", it) }
                isMentionable?.let { put("isMentionable", it) }
                isHoisted?.let { put("isHoisted", it) }
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
        api.get("/conversations/$spaceId/channels", cacheTo = "channels_$spaceId")

    suspend fun createChannel(
        spaceId: String,
        title: String,
        isAnnouncement: Boolean = false,
        position: Int = 0,
        isVoice: Boolean = false,
        /** Reads as a page of cards rather than a conversation. */
        isBoard: Boolean = false,
    ): ChannelEnvelope =
        api.post(
            "/conversations/$spaceId/channels",
            buildJsonObject {
                put("title", title)
                put("isAnnouncement", if (isVoice) false else isAnnouncement)
                put("position", position)
                put("isVoice", isVoice)
                put("isBoard", if (isVoice) false else isBoard)
            },
        )

    /** Drop into a voice channel — no ring, the room simply admits you. */
    suspend fun joinVoice(channelId: String): VoiceJoinEnvelope =
        api.post("/conversations/$channelId/voice/join", buildJsonObject {})

    suspend fun leaveVoice(channelId: String): JsonElement =
        api.post("/conversations/$channelId/voice/leave", buildJsonObject {})

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
        /** Voice and video notes: what the bubble prints before playing. */
        durationMs: Int? = null,
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
            durationMs?.let { put("durationMs", it) }
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

    /** The group's custom emoji — reaction keys like `:name:` resolve against these. */
    suspend fun groupEmojis(conversationId: String): GroupEmojisEnvelope =
        api.get("/conversations/$conversationId/emojis")

    /**
     * Read/delivered watermarks for every receipt-visible member. `seq = 0`
     * returns them all — the snapshot the ticks are drawn from.
     */
    suspend fun receipts(conversationId: String, seq: Long = 0): ReceiptsEnvelope =
        api.get("/conversations/$conversationId/receipts", mapOf("seq" to seq.toString()))

    suspend fun votePoll(conversationId: String, messageId: String, optionIds: List<String>): JsonElement =
        api.post(
            "/conversations/$conversationId/messages/$messageId/poll/vote",
            buildJsonObject { putJsonArray("optionIds") { optionIds.forEach { add(it) } } },
        )

    suspend fun markRead(conversationId: String, seq: Long): ReadAck =
        api.post("/conversations/$conversationId/read", buildJsonObject { put("seq", seq) })

    // ── Location ─────────────────────────────────────────────────────────────

    /** Share a place. A non-null [liveUntil] makes it a live share that moves. */
    suspend fun sendLocation(
        conversationId: String,
        latitude: Double,
        longitude: Double,
        name: String?,
        liveUntil: String?,
    ): MessageEnvelope = api.post(
        "/conversations/$conversationId/messages",
        buildJsonObject {
            put("type", "location")
            put("nonce", java.util.UUID.randomUUID().toString())
            putJsonObject("location") {
                put("latitude", latitude)
                put("longitude", longitude)
                if (name != null) put("name", name)
                if (liveUntil != null) put("liveUntil", liveUntil)
            }
        },
    )

    /**
     * Everything still moving here. Read on open — a share that started before
     * you arrived is exactly the one worth seeing.
     */
    suspend fun liveLocations(conversationId: String): LiveLocationsEnvelope =
        api.get("/conversations/$conversationId/live-locations")

    /** One ping. A 404 means the share is over and the sender should stop. */
    suspend fun pingLocation(
        conversationId: String,
        messageId: String,
        latitude: Double,
        longitude: Double,
        accuracy: Double?,
        heading: Double?,
    ): JsonElement = api.post(
        "/conversations/$conversationId/live-locations/$messageId",
        buildJsonObject {
            put("latitude", latitude)
            put("longitude", longitude)
            if (accuracy != null && accuracy >= 0) put("accuracy", accuracy)
            if (heading != null && heading >= 0) put("heading", heading)
        },
    )

    /** Stop early. The message stays; only the movement ends. */
    suspend fun stopLocation(conversationId: String, messageId: String): JsonElement =
        api.delete("/conversations/$conversationId/live-locations/$messageId")

    /**
     * Tell the room somebody screenshotted it.
     *
     * The server debounces and rate-limits, so the caller can report every
     * callback the platform delivers without counting them — some devices fire
     * twice for one press.
     */
    suspend fun reportScreenshot(conversationId: String): JsonElement =
        api.post("/conversations/$conversationId/screenshot")

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

    // ── Build metadata ───────────────────────────────────────────────────────

    /**
     * What the server is running, and whether this build is behind.
     *
     * Unauthenticated, so it also answers on the sign-in screen — an app too
     * old to complete the current auth flow can say so instead of failing with
     * something inscrutable.
     */
    suspend fun version(appVersion: String): VersionInfo =
        api.get("/meta/version", mapOf("platform" to "android", "version" to appVersion))

    /**
     * Release notes newer than [since]. Omit it to get the whole list, which is
     * what the Settings entry wants.
     */
    suspend fun changelog(since: String? = null): ChangelogEnvelope =
        api.get("/meta/changelog", mapOf("platform" to "android", "since" to since))

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

        /**
         * "Leave this field alone", distinct from "set it to null".
         *
         * Kotlin's `String?` has one absent value and the API needs two: a
         * PATCH that omits `mutedUntil` keeps whatever is stored, while one
         * that sends JSON null clears the timed mute. A sentinel object is the
         * cheapest way to say both without a wrapper type per field.
         */
        val Unset = Any()
    }
}
