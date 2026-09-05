package gg.yappy.app.ui.conversations

import androidx.glance.appwidget.updateAll
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import gg.yappy.app.AppContainer
import gg.yappy.app.data.ApiException
import gg.yappy.app.data.Conversation
import gg.yappy.app.data.GatewayState
import gg.yappy.app.notifications.MessageNotifications
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

data class ConversationsState(
    val conversations: List<Conversation> = emptyList(),
    /** Nothing to draw yet — neither a snapshot nor a network answer. */
    val loading: Boolean = true,
    /** A fetch is in flight over a list that is already on screen. */
    val refreshing: Boolean = false,
    /**
     * Crossing between the live list and the archive. Kept apart from
     * [loading] for meaning, not behaviour: there is a list, it is the wrong
     * one for a moment. The screen folds both into the same skeleton today
     * (`loading || switching`), so this is the hook for a real veil later,
     * not a promise that one is drawn now.
     */
    val switching: Boolean = false,
    /**
     * The person pulled the list down. Distinct from [refreshing] because
     * the gateway also refreshes on every reconnect — including the one at
     * launch — and the pull indicator should answer a pull, not narrate the
     * socket. A spinner that appears uninvited at the top of the list on every
     * cold start is noise dressed as feedback.
     */
    val pulled: Boolean = false,
    val error: String? = null,
    val query: String = "",
    val showArchived: Boolean = false,
    val unreadTotal: Int = 0,
    val connected: Boolean = false,
    val me: gg.yappy.app.data.FullUser? = null,
    val online: List<gg.yappy.app.data.OnlineEntry> = emptyList(),
    /** conversationId → epoch-ms expiry of the newest typing signal. */
    val typingUntil: Map<String, Long> = emptyMap(),
    val searchHits: List<gg.yappy.app.data.SearchHit> = emptyList(),
    /** Accounts matching the query — the "People on yappy" search section. */
    val searchPeople: List<gg.yappy.app.data.PublicUser> = emptyList(),
) {
    fun isTyping(conversationId: String): Boolean =
        (typingUntil[conversationId] ?: 0) > System.currentTimeMillis()

    /**
     * Pinned first, then by recency. Sorted here rather than trusting the
     * server's order, because live events mutate the list in place and the
     * ordering has to survive that without a refetch.
     */
    val visible: List<Conversation>
        get() = conversations
            .filter { c ->
                query.isBlank() ||
                    c.displayName.contains(query, ignoreCase = true) ||
                    c.lastMessage?.preview?.contains(query, ignoreCase = true) == true
            }
            .sortedWith(
                compareByDescending<Conversation> { it.self?.isPinned == true }
                    .thenByDescending { it.lastMessageAt ?: "" },
            )
}

class ConversationsViewModel(private val container: AppContainer) : ViewModel() {

    private val _state = MutableStateFlow(ConversationsState())
    val state: StateFlow<ConversationsState> = _state.asStateFlow()

    init {
        /*
         * Paint from the last good answer before asking for a new one.
         *
         * The repository has been writing every `/conversations` response to
         * the "conversations" snapshot slot since the disk cache existed, and
         * nothing ever read it back — so every cold start spent its first
         * second on a spinner, and an offline launch spun and then announced
         * "Nobody here yet" to somebody with forty chats. Decoded off Main,
         * because a file read plus a JSON parse of fifty rows does not belong
         * in the first frames; applied only while the screen has nothing
         * drawn — still loading, or a fetch that already failed over an empty
         * list — because the network fetch launched right after can land
         * first and a stale snapshot must never overwrite a fresh answer.
         * The failed case is the offline one: with no signal the fetch loses
         * in a few milliseconds, faster than this decode, and it must not
         * veto the snapshot it was meant to be backed by.
         *
         * Only the live list: the archive is a place people go, not a place
         * the app wakes up, and the repository never snapshots it.
         */
        viewModelScope.launch(kotlinx.coroutines.Dispatchers.IO) {
            gg.yappy.app.data.DiskCache.decode<gg.yappy.app.data.ConversationsEnvelope>("conversations")
                ?.let { env ->
                    _state.update {
                        // A fresh answer — full or genuinely empty — has
                        // error == null and loading == false, and is never
                        // overwritten.
                        val nothingDrawn = it.loading || (it.error != null && it.conversations.isEmpty())
                        if (nothingDrawn && !it.showArchived) {
                            it.copy(conversations = env.conversations, loading = false, error = null)
                        } else it
                    }
                }
        }
        load()
        observeGateway()

        // The container's profile is the source of truth, and Settings writes
        // to it. This screen used to keep its own copy from one fetch at
        // start-up, so a new avatar showed everywhere except the home header
        // until the app was relaunched — the exact place the person looks to
        // confirm the change took.
        viewModelScope.launch {
            container.me.collect { user ->
                if (user != null) _state.update { it.copy(me = user) }
            }
        }

        // Read once and held, because the delivery ack below consults it for
        // every arriving message and a DataStore read per message is absurd.
        viewModelScope.launch { meId = container.session.currentUserId() }
    }

    /** Cached so the message.create handler can tell our own echoes apart. */
    private var meId: String? = null

    private var searchJob: kotlinx.coroutines.Job? = null

    fun setQuery(value: String) {
        _state.update { it.copy(query = value) }

        // One search box, three result sets: conversations filter locally and
        // instantly; messages and people hit the server, debounced, together.
        searchJob?.cancel()
        if (value.trim().length < 2) {
            _state.update { it.copy(searchHits = emptyList(), searchPeople = emptyList()) }
            return
        }
        searchJob = viewModelScope.launch {
            kotlinx.coroutines.delay(350)
            val term = value.trim()
            val hitsDeferred = async {
                runCatching { container.repo.searchMessages(term).results }.getOrDefault(emptyList())
            }
            val peopleDeferred = async {
                runCatching { container.repo.searchUsers(term).users }.getOrDefault(emptyList())
            }
            val hits = hitsDeferred.await()
            val people = peopleDeferred.await().filter { it.id != meId }
            if (_state.value.query == value) {
                _state.update { it.copy(searchHits = hits, searchPeople = people) }
            }
        }
    }

    /*
     * Crossing into the archive no longer drops to a bare spinner.
     *
     * This used to set `loading`, which put a centred spinner where forty
     * rows had been. Now the screen crossfades the list to the skeleton in
     * the list's own gutters until the other list answers; only an account
     * with nothing drawn at all gets the true loading state.
     */
    fun toggleArchived() {
        _state.update {
            it.copy(
                showArchived = !it.showArchived,
                switching = it.conversations.isNotEmpty(),
                loading = it.conversations.isEmpty(),
                error = null,
            )
        }
        load()
    }

    /** The pull gesture. Same fetch as a reconnect, but this one shows. */
    fun refreshFromPull() {
        _state.update { it.copy(pulled = true) }
        load(refresh = true)
    }

    /**
     * Try-again from the error state: back to the skeleton, then the same
     * fetch. Calling [load] directly cleared the error with nothing drawn
     * behind it, so the screen fell through to "Nobody here yet" for the
     * length of the request — the emptiest screen in the app, shown to
     * someone who just asked it to try harder.
     */
    fun retry() {
        _state.update { it.copy(loading = it.conversations.isEmpty(), error = null) }
        load()
    }

    /**
     * Four independent fetches, four coroutines.
     *
     * These used to run in one coroutine, one after another, and nothing was
     * assigned until all four had answered — so the list, which arrives first
     * and is the only thing this screen actually needs, waited on three more
     * round trips it does not depend on. The badge count, the Active Now strip
     * and the profile now each land whenever they land.
     *
     * The list is the screen; everything else is decoration on it. iOS was
     * fixed for exactly this and kept the serial version's comment as a
     * warning — this is the port.
     */
    fun load(refresh: Boolean = false) {
        _state.update {
            it.copy(
                refreshing = refresh,
                error = null,
                // Leaving an error with nothing drawn — a reconnect, a
                // conversation.create — veils the fetch the same way [retry]
                // does, rather than showing the empty state while it is out.
                // Guarded on the error so a genuinely empty account does not
                // flash the skeleton over "Nobody here yet" on every reconnect.
                loading = it.loading || (it.error != null && it.conversations.isEmpty()),
            )
        }

        viewModelScope.launch {
            try {
                val result = container.repo.conversations(archived = _state.value.showArchived)
                _state.update {
                    it.copy(
                        conversations = result.conversations,
                        loading = false,
                        refreshing = false,
                        pulled = false,
                        switching = false,
                    )
                }

                // Leave the name and avatar behind for whichever chat is opened
                // next, so its header paints on the first frame instead of
                // flashing "…" while the conversation fetch lands.
                container.headerSeeds.remember(result.conversations)

                // The in-app banner has no other way to know a conversation is
                // muted: it is built from a socket event, not from a loaded
                // conversation.
                result.conversations.forEach { c ->
                    container.notificationLevels[c.id] = c.self?.notificationLevel ?: "all"
                }

                // Persist cursors so the next gateway IDENTIFY can ask for a
                // delta instead of a full snapshot.
                container.session.saveCursors(result.conversations.associate { c -> c.id to c.latestSeq })

                // The OS surfaces fed from this list: launcher shortcuts and
                // share-sheet targets get the top chats, the homescreen widget
                // gets fresh here-counts. Off the main path — icon fetches do
                // network — and never allowed to fail the load that matters.
                viewModelScope.launch(kotlinx.coroutines.Dispatchers.IO) {
                    runCatching {
                        gg.yappy.app.data.ConversationShortcuts.publish(
                            container.appContext,
                            result.conversations,
                        )
                    }
                    runCatching {
                        gg.yappy.app.widget.HereWidget().updateAll(container.appContext)
                    }
                }
            } catch (e: ApiException) {
                // Only an error state when there is nothing else to draw. With a
                // list already on screen a failed refresh is better left silent:
                // the gateway reconnect retries it anyway, and replacing a
                // usable screen with an error message helps nobody.
                //
                // Except when the failure was a *switch*: the header already
                // says "Archived" and the rows underneath are still the live
                // list, so every swipe on them offers Restore on a conversation
                // that was never archived. The other mode's list goes.
                _state.update {
                    val stale = it.switching
                    it.copy(
                        loading = false,
                        refreshing = false,
                        pulled = false,
                        switching = false,
                        conversations = if (stale) emptyList() else it.conversations,
                        error = if (stale || it.conversations.isEmpty()) e.message else null,
                    )
                }
            }
        }

        viewModelScope.launch {
            runCatching { container.repo.badge() }.getOrNull()?.let { badge ->
                _state.update { it.copy(unreadTotal = badge.unreadConversations) }
            }
        }

        viewModelScope.launch {
            runCatching { container.repo.onlineContacts().online }.getOrNull()?.let { online ->
                _state.update { it.copy(online = online) }
            }
        }

        // The profile lives on the container so every screen that draws your
        // face sees the same one. The collector in `init` mirrors it into this
        // screen's state, so there is nothing to assign here.
        viewModelScope.launch {
            if (_state.value.me == null) {
                runCatching { container.repo.me().user }.getOrNull()?.let(container::setMe)
            }
        }
    }

    fun togglePin(conversation: Conversation) {
        val next = !(conversation.self?.isPinned ?: false)
        patchLocal(conversation.id) { it.copy(self = it.self?.copy(isPinned = next)) }
        viewModelScope.launch { runCatching { container.repo.setConversationState(conversation.id, pinned = next) } }
    }

    fun toggleMute(conversation: Conversation) {
        val next = !conversation.isMuted
        patchLocal(conversation.id) {
            it.copy(self = it.self?.copy(notificationLevel = if (next) "none" else "all", mutedUntil = null))
        }
        // The timed mute is cleared on the server too, in both directions.
        // Left unset, the PATCH only touched the level: "Unmute" over a
        // one-hour mute flipped the row locally and the next reload brought
        // the hour back, pushes still held. Choosing a level is the person
        // saying how it is now, and a leftover expiry has no say in that.
        viewModelScope.launch {
            runCatching { container.repo.setConversationState(conversation.id, muted = next, mutedUntil = null) }
        }
    }

    /**
     * A timed mute: quiet for an hour or an evening, then back on its own.
     *
     * The level is left alone and only `mutedUntil` is set, which is what the
     * server's own timed mute means — "do not interrupt me until", not "I
     * have stopped caring". The row still reads as muted, because
     * [Conversation.isMuted] counts a pending expiry.
     */
    fun muteFor(conversation: Conversation, duration: java.time.Duration) {
        val until = java.time.Instant.now().plus(duration).toString()
        patchLocal(conversation.id) { it.copy(self = it.self?.copy(mutedUntil = until)) }
        viewModelScope.launch {
            runCatching { container.repo.setConversationState(conversation.id, mutedUntil = until) }
        }
    }

    /**
     * Undo for either mute. Restores the row's whole `self` as it was before
     * the tap and posts the same shape back, so a timed mute that was undone
     * does not come back as an open-ended one.
     */
    fun restoreMuteState(before: Conversation) {
        val self = before.self
        patchLocal(before.id) { it.copy(self = self ?: it.self) }
        viewModelScope.launch {
            runCatching {
                container.repo.setConversationState(
                    before.id,
                    muted = self?.notificationLevel == "none",
                    mutedUntil = self?.mutedUntil,
                )
            }
        }
    }

    /**
     * Clears the badge from the list without opening the chat. The server's
     * `conversation.state_update` echo lands afterwards and agrees.
     */
    fun markRead(conversation: Conversation) {
        patchLocal(conversation.id) { it.copy(self = it.self?.copy(unreadCount = 0, mentionCount = 0)) }
        viewModelScope.launch {
            runCatching { container.repo.markRead(conversation.id, conversation.latestSeq) }
        }
    }

    /** Leaving is the one row action with no undo, so the sheet asks twice. */
    fun leave(conversation: Conversation) {
        _state.update { s -> s.copy(conversations = s.conversations.filterNot { it.id == conversation.id }) }
        viewModelScope.launch {
            runCatching { container.repo.leaveConversation(conversation.id) }
                // Refused — a sole owner, say. The row comes back rather than
                // pretending the server agreed.
                .onFailure { load() }
        }
    }

    /** Open (or create) the DM behind an Active Now bubble. */
    fun startDm(userId: String, onOpened: (String) -> Unit) {
        viewModelScope.launch {
            runCatching { container.repo.createDm(userId).conversation.id }.onSuccess(onOpened)
        }
    }

    /**
     * In the live list this archives; in the archive it restores. Returns the
     * row's index so an Undo can put it back where it was rather than at the
     * top, where a row that was fourth by recency would look like news.
     */
    fun archive(conversation: Conversation): Int {
        val index = _state.value.conversations.indexOfFirst { it.id == conversation.id }
        _state.update { s -> s.copy(conversations = s.conversations.filterNot { it.id == conversation.id }) }
        viewModelScope.launch {
            runCatching { container.repo.setConversationState(conversation.id, archived = !_state.value.showArchived) }
        }
        return index
    }

    /**
     * The snackbar's Undo. Re-inserts at the remembered slot and posts the
     * opposite flag; if the list has changed shape underneath — a message
     * arrived, a row left — the index is clamped rather than trusted.
     */
    fun unarchive(conversation: Conversation, index: Int) {
        _state.update { s ->
            if (s.conversations.any { it.id == conversation.id }) return@update s
            val at = index.coerceIn(0, s.conversations.size)
            s.copy(conversations = s.conversations.toMutableList().apply { add(at, conversation) })
        }
        viewModelScope.launch {
            runCatching { container.repo.setConversationState(conversation.id, archived = _state.value.showArchived) }
        }
    }

    /**
     * Live updates.
     *
     * The list is patched in place from gateway events rather than refetched:
     * a refetch per incoming message would make a busy account issue a request
     * every few seconds, and the scroll position would fight the user.
     */
    private fun observeGateway() {
        // The chat just told the server it was read; clear the badge in the
        // same frame rather than after the server's echo. The
        // conversation.state_update below still lands and agrees.
        viewModelScope.launch {
            container.conversationRead.collect { id ->
                patchLocal(id) { conv ->
                    conv.copy(self = conv.self?.copy(unreadCount = 0, mentionCount = 0))
                }
            }
        }

        viewModelScope.launch {
            container.gateway.events.collect { event ->
                when (event.type) {
                    "message.create" -> {
                        val obj = event.data.jsonObject
                        val conversationId = obj["conversationId"]?.jsonPrimitive?.content ?: return@collect
                        val seq = obj["seq"]?.jsonPrimitive?.content?.toLongOrNull() ?: return@collect
                        val preview = obj["content"]?.jsonPrimitive?.contentOrNull()
                        val createdAt = obj["createdAt"]?.jsonPrimitive?.content

                        val known = _state.value.conversations.any { it.id == conversationId }
                        if (!known) {
                            // First message in a conversation this client has
                            // never seen. Only case that justifies a fetch.
                            runCatching { container.repo.conversation(conversationId).conversation }
                                .getOrNull()
                                ?.let { fresh ->
                                    /**
                                     * Channels are never home-list rows — they
                                     * live inside their space, and the list
                                     * endpoint excludes them. This insert used
                                     * to skip that filter, so the first message
                                     * in any channel planted it on the home
                                     * screen as a phantom top-level group,
                                     * duplicating the one inside the space —
                                     * and re-planted it after every reload.
                                     */
                                    if (fresh.type == "channel") return@collect
                                    _state.update { s -> s.copy(conversations = listOf(fresh) + s.conversations) }
                                }
                            return@collect
                        }

                        patchLocal(conversationId) { conv ->
                            conv.copy(
                                latestSeq = seq,
                                lastMessageAt = createdAt ?: conv.lastMessageAt,
                                lastMessage = conv.lastMessage?.copy(seq = seq, preview = preview)
                                    ?: gg.yappy.app.data.LastMessageStub(seq = seq, preview = preview),
                                self = conv.self?.copy(
                                    unreadCount = (conv.self.unreadCount + 1),
                                ),
                            )
                        }

                        // This device has the message — say so, or the sender's
                        // second tick never arrives. The open chat's read ack
                        // covers whichever conversation is on screen; this
                        // covers every other one, which is where a delivery
                        // tick is the only signal there is.
                        val senderId = obj["senderId"]?.jsonPrimitive?.contentOrNull()
                        val self = meId ?: _state.value.me?.id
                        if (self != null && senderId != self) {
                            container.gateway.deliveryAck(conversationId, seq)
                        }
                    }

                    "conversation.create" -> load()

                    // Title/description/flair edits, applied in place so a
                    // group changing its look repaints every member's list
                    // without a refetch.
                    "conversation.update" -> {
                        val obj = event.data.jsonObject
                        val id = obj["id"]?.jsonPrimitive?.content ?: return@collect
                        val appearance = obj["appearance"]?.let { element ->
                            if (element is kotlinx.serialization.json.JsonNull) null
                            else runCatching {
                                lenientJson.decodeFromJsonElement(
                                    gg.yappy.app.data.ConversationAppearance.serializer(),
                                    element,
                                )
                            }.getOrNull()
                        }
                        // A group that just became a space needs its type
                        // corrected in place — otherwise tapping it opens an
                        // empty chat instead of the channel list, until some
                        // later reload happens to fix it.
                        val nextType = (obj["type"] as? kotlinx.serialization.json.JsonPrimitive)
                            ?.contentOrNull()
                        patchLocal(id) { conv ->
                            conv.copy(
                                type = nextType ?: conv.type,
                                title = (obj["title"] as? kotlinx.serialization.json.JsonPrimitive)
                                    ?.contentOrNull() ?: conv.title,
                                description = (obj["description"] as? kotlinx.serialization.json.JsonPrimitive)
                                    ?.contentOrNull() ?: conv.description,
                                isPublic = obj["isPublic"]?.jsonPrimitive?.content?.toBooleanStrictOrNull()
                                    ?: conv.isPublic,
                                // Only overwrite when the key is present: a null
                                // avatarUrl in the payload means "cleared", but
                                // an absent key means "unchanged".
                                avatarUrl = if (obj.containsKey("avatarUrl")) {
                                    (obj["avatarUrl"] as? kotlinx.serialization.json.JsonPrimitive)?.contentOrNull()
                                } else conv.avatarUrl,
                                appearance = if (obj.containsKey("appearance")) appearance else conv.appearance,
                            )
                        }
                    }

                    "conversation.delete" -> {
                        val id = event.data.jsonObject["id"]?.jsonPrimitive?.content ?: return@collect
                        _state.update { s -> s.copy(conversations = s.conversations.filterNot { it.id == id }) }
                    }

                    // "Alan is typing…" directly on the list row. The stop
                    // event may be lost, so entries expire on their own.
                    "typing.start" -> {
                        val obj = event.data.jsonObject
                        val conversationId = obj["conversationId"]?.jsonPrimitive?.content ?: return@collect
                        _state.update {
                            it.copy(typingUntil = it.typingUntil + (conversationId to System.currentTimeMillis() + 8_000))
                        }
                    }

                    "typing.stop" -> {
                        val obj = event.data.jsonObject
                        val conversationId = obj["conversationId"]?.jsonPrimitive?.content ?: return@collect
                        _state.update { it.copy(typingUntil = it.typingUntil - conversationId) }
                    }

                    // Someone came online or left: refresh the Active Now strip
                    // and the per-group "here" counts. The liveness is the
                    // whole point of the home screen — but these arrive in
                    // bursts (one per device of every contact), and each used
                    // to fire its own round trip plus a whole-screen state
                    // emission. Coalesced: one refresh per quiet half-second.
                    "presence.update" -> schedulePresenceRefresh()

                    "conversation.state_update" -> {
                        val obj = event.data.jsonObject
                        val id = obj["conversationId"]?.jsonPrimitive?.content ?: return@collect
                        val unread = obj["unreadCount"]?.jsonPrimitive?.content?.toIntOrNull()
                        /*
                         * The mention count travels on this event too, and was
                         * being dropped.
                         *
                         * It matters most for the one case the id alone cannot
                         * express: reading a *channel* changes its space's
                         * rolled-up count, so the server sends a second update
                         * naming the space. Ignoring the field meant the @
                         * badge sat at four long after the mentions were read.
                         */
                        val mentions = obj["mentionCount"]?.jsonPrimitive?.content?.toIntOrNull()

                        // Read to zero — here, or on another device. The
                        // chat's own screen clears its notification on open;
                        // this covers the phone in your pocket while the
                        // laptop reads, which used to be a blanket sweep of
                        // the shade on every resume and is now the one
                        // conversation the server named. Cancelling an id
                        // that is not posted is a no-op, so no lookup first.
                        // Not while that chat is the one on screen here: its
                        // own screen already cleared the notification on open,
                        // and when it is open in a bubble the notification *is*
                        // the bubble — cancelling it would pop the window the
                        // person is reading in, on the read receipt it sent.
                        if (unread == 0 && container.foregroundConversationId != id) {
                            MessageNotifications.dismiss(container.appContext, id)
                        }

                        patchLocal(id) { conv ->
                            conv.copy(
                                self = conv.self?.copy(
                                    unreadCount = unread ?: conv.self.unreadCount,
                                    mentionCount = mentions ?: conv.self.mentionCount,
                                    isPinned = obj["isPinned"]?.jsonPrimitive?.content?.toBoolean() ?: conv.self.isPinned,
                                ),
                            )
                        }
                    }
                }
            }
        }

        // Prune expired typing signals so "typing…" cannot outlive the typist.
        viewModelScope.launch {
            while (true) {
                kotlinx.coroutines.delay(2_000)
                val now = System.currentTimeMillis()
                _state.update { s ->
                    val live = s.typingUntil.filterValues { it > now }
                    if (live.size == s.typingUntil.size) s else s.copy(typingUntil = live)
                }
            }
        }

        viewModelScope.launch {
            container.gateway.state.collect { gwState ->
                _state.update { it.copy(connected = gwState is GatewayState.Connected) }
                // Reconnecting is the moment to reconcile: events that arrived
                // while the socket was down were never delivered.
                if (gwState is GatewayState.Connected) load(refresh = true)
            }
        }
    }

    /**
     * One /contacts/online refresh per quiet half-second, however many
     * presence events arrive inside it. The first event arms the fetch;
     * the rest fall into the same window.
     */
    private var presenceRefresh: kotlinx.coroutines.Job? = null
    private var presenceDirty = false
    private fun schedulePresenceRefresh() {
        // A dirty flag rather than "is a job running": an event that lands
        // while the fetch is already in flight must trigger another fetch,
        // or the strip settles on an answer the server computed before it.
        presenceDirty = true
        if (presenceRefresh?.isActive == true) return
        presenceRefresh = viewModelScope.launch {
            while (presenceDirty) {
                presenceDirty = false
                kotlinx.coroutines.delay(500)
                runCatching { container.repo.onlineContacts().online }.getOrNull()
                    ?.let { online -> _state.update { it.copy(online = online) } }
            }
        }
    }

    private fun patchLocal(id: String, transform: (Conversation) -> Conversation) {
        _state.update { s ->
            s.copy(conversations = s.conversations.map { if (it.id == id) transform(it) else it })
        }
    }

    companion object {
        fun factory(container: AppContainer) = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T =
                ConversationsViewModel(container) as T
        }
    }
}

private fun kotlinx.serialization.json.JsonPrimitive.contentOrNull(): String? =
    if (this is kotlinx.serialization.json.JsonNull) null else content

private val lenientJson = kotlinx.serialization.json.Json { ignoreUnknownKeys = true }
