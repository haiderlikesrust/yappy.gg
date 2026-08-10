package gg.yappy.app.ui.conversations

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import gg.yappy.app.AppContainer
import gg.yappy.app.data.ApiException
import gg.yappy.app.data.Conversation
import gg.yappy.app.data.GatewayState
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

data class ConversationsState(
    val conversations: List<Conversation> = emptyList(),
    val loading: Boolean = true,
    val refreshing: Boolean = false,
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
    }

    private var searchJob: kotlinx.coroutines.Job? = null

    fun setQuery(value: String) {
        _state.update { it.copy(query = value) }

        // One search box, two result sets: conversations filter locally and
        // instantly; message search hits the server, debounced.
        searchJob?.cancel()
        if (value.trim().length < 2) {
            _state.update { it.copy(searchHits = emptyList()) }
            return
        }
        searchJob = viewModelScope.launch {
            kotlinx.coroutines.delay(350)
            val hits = runCatching { container.repo.searchMessages(value.trim()).results }
                .getOrDefault(emptyList())
            if (_state.value.query == value) _state.update { it.copy(searchHits = hits) }
        }
    }

    fun toggleArchived() {
        _state.update { it.copy(showArchived = !it.showArchived, loading = true) }
        load()
    }

    fun load(refresh: Boolean = false) {
        _state.update { it.copy(refreshing = refresh, error = null) }
        viewModelScope.launch {
            try {
                val result = container.repo.conversations(archived = _state.value.showArchived)
                val badge = runCatching { container.repo.badge() }.getOrNull()
                val online = runCatching { container.repo.onlineContacts().online }.getOrNull()
                val me = _state.value.me ?: runCatching { container.repo.me().user }.getOrNull()

                _state.update {
                    it.copy(
                        conversations = result.conversations,
                        loading = false,
                        refreshing = false,
                        unreadTotal = badge?.unreadConversations ?: it.unreadTotal,
                        online = online ?: it.online,
                        me = me,
                    )
                }

                me?.let(container::setMe)

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
            } catch (e: ApiException) {
                _state.update { it.copy(loading = false, refreshing = false, error = e.message) }
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
        viewModelScope.launch { runCatching { container.repo.setConversationState(conversation.id, muted = next) } }
    }

    /** Open (or create) the DM behind an Active Now bubble. */
    fun startDm(userId: String, onOpened: (String) -> Unit) {
        viewModelScope.launch {
            runCatching { container.repo.createDm(userId).conversation.id }.onSuccess(onOpened)
        }
    }

    fun archive(conversation: Conversation) {
        _state.update { s -> s.copy(conversations = s.conversations.filterNot { it.id == conversation.id }) }
        viewModelScope.launch {
            runCatching { container.repo.setConversationState(conversation.id, archived = !_state.value.showArchived) }
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
                    // and the per-group "here" counts. Cheap queries, and the
                    // liveness is the whole point of the home screen.
                    "presence.update" -> {
                        val online = runCatching { container.repo.onlineContacts().online }.getOrNull()
                        if (online != null) _state.update { it.copy(online = online) }
                    }

                    "conversation.state_update" -> {
                        val obj = event.data.jsonObject
                        val id = obj["conversationId"]?.jsonPrimitive?.content ?: return@collect
                        val unread = obj["unreadCount"]?.jsonPrimitive?.content?.toIntOrNull()
                        patchLocal(id) { conv ->
                            conv.copy(
                                self = conv.self?.copy(
                                    unreadCount = unread ?: conv.self.unreadCount,
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
