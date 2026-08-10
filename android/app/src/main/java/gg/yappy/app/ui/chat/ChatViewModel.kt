package gg.yappy.app.ui.chat

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import gg.yappy.app.AppContainer
import gg.yappy.app.data.ApiException
import gg.yappy.app.data.AppJson
import gg.yappy.app.data.Conversation
import gg.yappy.app.data.GatewayState
import gg.yappy.app.data.GifResult
import gg.yappy.app.data.Message
import gg.yappy.app.data.MessageReceiptState
import gg.yappy.app.data.PublicUser
import gg.yappy.app.data.Sticker
import gg.yappy.app.data.StickerPack
import gg.yappy.app.data.YappyRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

data class TypingUser(val userId: String, val expiresAtMs: Long)

data class ChatState(
    val conversation: Conversation? = null,
    val messages: List<Message> = emptyList(),
    val pinned: List<Message> = emptyList(),
    val loading: Boolean = true,
    val loadingOlder: Boolean = false,
    val hasMore: Boolean = true,
    val error: String? = null,
    val draft: String = "",
    val replyTo: Message? = null,
    val editing: Message? = null,
    val typing: List<TypingUser> = emptyList(),
    val stickerPacks: List<StickerPack> = emptyList(),
    val recentStickers: List<Sticker> = emptyList(),
    val gifs: List<GifResult> = emptyList(),
    val gifQuery: String = "",
    val gifsLoading: Boolean = false,
    val members: Map<String, PublicUser> = emptyMap(),
    val meId: String? = null,
    /** Slash commands offered by bots here, for composer autocomplete. */
    val commands: List<gg.yappy.app.data.BotCommand> = emptyList(),
    /** customId of a button waiting on the server, so it can show a spinner. */
    val pressingComponent: String? = null,
    /**
     * Delivered and read watermarks, highest across every other member.
     *
     * Two numbers rather than a per-message map: a member has read *up to* a
     * seq, so one comparison per bubble draws every tick in the timeline.
     */
    val deliveredSeq: Long = 0,
    val readSeq: Long = 0,
) {
    /** What the tick on one of your own bubbles should say. */
    fun receiptFor(message: Message): MessageReceiptState = when {
        message.isPending -> MessageReceiptState.Pending
        message.seq <= readSeq -> MessageReceiptState.Read
        message.seq <= deliveredSeq -> MessageReceiptState.Delivered
        else -> MessageReceiptState.Sent
    }

    val typingLabel: String?
        get() {
            val now = System.currentTimeMillis()
            val active = typing.filter { it.expiresAtMs > now }
            if (active.isEmpty()) return null
            val names = active.mapNotNull { members[it.userId]?.label }
            return when {
                names.isEmpty() -> "typing…"
                names.size == 1 -> "${names[0]} is typing…"
                names.size == 2 -> "${names[0]} and ${names[1]} are typing…"
                else -> "${names.size} people are typing…"
            }
        }
}

class ChatViewModel(
    private val container: AppContainer,
    private val conversationId: String,
) : ViewModel() {

    private val _state = MutableStateFlow(ChatState())
    val state: StateFlow<ChatState> = _state.asStateFlow()

    private val repo get() = container.repo
    private var typingJob: Job? = null
    private var lastTypingSent = 0L
    private var readAckJob: Job? = null

    /** Highest seq the *server* has confirmed, not merely the highest seen. */
    private var ackedSeq: Long = 0

    init {
        viewModelScope.launch { _state.update { it.copy(meId = container.session.currentUserId()) } }
        load()
        observeGateway()
        loadPickers()
    }

    // ── Loading ──────────────────────────────────────────────────────────────

    /** What a chat leaves behind for its next opening. */
    data class TimelineSnapshot(
        val conversation: Conversation?,
        val messages: List<Message>,
        val deliveredSeq: Long,
        val readSeq: Long,
    )

    private fun load() {
        // Last visit's timeline, painted before any request is made. WhatsApp
        // and Telegram open instantly because they draw from a local store and
        // reconcile after — this is that, one screen at a time. The tick
        // watermarks ride along, or every own bubble would flash back to a
        // single grey check and "re-earn" its blue on each open.
        container.screenSnapshots.get<TimelineSnapshot>("timeline_$conversationId")?.let { snap ->
            _state.update { s ->
                s.copy(
                    conversation = snap.conversation ?: s.conversation,
                    messages = snap.messages,
                    deliveredSeq = snap.deliveredSeq,
                    readSeq = snap.readSeq,
                    members = buildMap {
                        snap.messages.forEach { m -> m.sender?.let { put(it.id, it) } }
                    },
                    loading = false,
                )
            }
        }

        viewModelScope.launch {
            try {
                // Started together — serially these were two full round trips
                // before the first bubble could settle, and the timeline only
                // needs the second of them.
                val convTask = async { repo.conversation(conversationId).conversation }
                val historyTask = async { repo.history(conversationId, limit = 50) }
                val pinsTask = async {
                    runCatching { repo.pins(conversationId).pins.map { it.message } }.getOrDefault(emptyList())
                }
                val conv = convTask.await()
                val history = historyTask.await()
                val pins = pinsTask.await()

                val people = buildMap {
                    conv.otherUser?.let { put(it.id, it) }
                    conv.memberPreview.forEach { put(it.id, it) }
                    history.messages.forEach { m -> m.sender?.let { put(it.id, it) } }
                }

                _state.update {
                    it.copy(
                        conversation = conv,
                        messages = history.messages,
                        pinned = pins,
                        hasMore = history.hasMore,
                        loading = false,
                        draft = conv.self?.draft.orEmpty(),
                        members = people,
                    )
                }

                container.gateway.subscribe(conversationId)
                markReadUpTo(history.messages.lastOrNull()?.seq ?: 0)
                loadReceipts()
                saveTimelineSnapshot()

                // Fetched once per conversation: the list is small, changes
                // only when a bot is added or updates its manifest, and the
                // composer must be able to answer a "/" keypress instantly.
                runCatching { repo.conversationCommands(conversationId).commands }
                    .getOrNull()
                    ?.let { list -> _state.update { s -> s.copy(commands = list) } }

                // Full member list for @-mention autocomplete. Groups only —
                // a DM's two participants are already in the map.
                if (conv.type != "dm") {
                    runCatching { repo.members(conversationId).members }.getOrNull()?.let { list ->
                        _state.update { s ->
                            s.copy(members = s.members + list.associate { it.user.id to it.user })
                        }
                    }
                }
            } catch (e: ApiException) {
                _state.update { it.copy(loading = false, error = e.message) }
            }
        }
    }

    fun loadOlder() {
        val s = _state.value
        if (s.loadingOlder || !s.hasMore || s.messages.isEmpty()) return
        _state.update { it.copy(loadingOlder = true) }

        viewModelScope.launch {
            try {
                val oldest = s.messages.first().seq
                val page = repo.history(conversationId, before = oldest, limit = 50)
                _state.update { current ->
                    current.copy(
                        // Prepend, and de-duplicate by id: a live event can land
                        // in the same window a page request is covering.
                        messages = (page.messages + current.messages).distinctBy { m -> m.id },
                        hasMore = page.hasMore,
                        loadingOlder = false,
                        members = current.members + page.messages.mapNotNull { m -> m.sender?.let { it.id to it } },
                    )
                }
            } catch (_: ApiException) {
                _state.update { it.copy(loadingOlder = false) }
            }
        }
    }

    private fun loadPickers() {
        viewModelScope.launch {
            runCatching { repo.installedPacks().packs }.getOrNull()?.let { packs ->
                _state.update { it.copy(stickerPacks = packs) }
            }
            runCatching { repo.recentStickers().stickers }.getOrNull()?.let { recent ->
                _state.update { it.copy(recentStickers = recent) }
            }
            runCatching { repo.recentGifs().results }.getOrNull()?.let { gifs ->
                _state.update { it.copy(gifs = gifs) }
            }
        }
    }

    // ── Composing ────────────────────────────────────────────────────────────

    fun setDraft(value: String) {
        _state.update { it.copy(draft = value) }

        // Throttled to one every three seconds: the server refreshes an 8s TTL,
        // so anything faster is wasted frames on every other member's device.
        val now = System.currentTimeMillis()
        if (value.isNotBlank() && now - lastTypingSent > 3_000) {
            lastTypingSent = now
            container.gateway.typing(conversationId, true)
        }

        typingJob?.cancel()
        typingJob = viewModelScope.launch {
            delay(4_000)
            container.gateway.typing(conversationId, false)
            lastTypingSent = 0
            // Draft is synced to the server so it follows the user across
            // devices, but only once they stop typing.
            runCatching { repo.setConversationState(conversationId, draft = _state.value.draft) }
        }
    }

    fun setReplyTo(message: Message?) = _state.update { it.copy(replyTo = message, editing = null) }

    fun startEditing(message: Message) =
        _state.update { it.copy(editing = message, draft = message.content.orEmpty(), replyTo = null) }

    fun cancelEditing() = _state.update { it.copy(editing = null, draft = "") }

    /**
     * Send with an optimistic bubble.
     *
     * The nonce is generated here and reused as the local message id, so when
     * the server's copy arrives over the socket it replaces the placeholder
     * instead of appearing beside it.
     */
    fun send() {
        val s = _state.value
        val text = s.draft.trim()
        if (text.isEmpty()) return

        s.editing?.let { editing ->
            _state.update { it.copy(draft = "", editing = null) }
            viewModelScope.launch {
                runCatching { repo.editMessage(conversationId, editing.id, text) }
                    .onSuccess { env -> replaceMessage(env.message) }
            }
            return
        }

        val nonce = YappyRepository.newNonce()
        val optimistic = Message(
            id = nonce,
            conversationId = conversationId,
            seq = Message.PENDING_SEQ,
            type = "text",
            content = text,
            senderId = s.meId,
            sender = s.meId?.let { s.members[it] },
            replyTo = s.replyTo?.let {
                gg.yappy.app.data.ReplyStub(it.id, it.seq, it.senderId, it.content, it.type)
            },
            createdAt = java.time.Instant.now().toString(),
            nonce = nonce,
        )

        _state.update {
            it.copy(messages = it.messages + optimistic, draft = "", replyTo = null)
        }
        container.gateway.typing(conversationId, false)

        viewModelScope.launch {
            try {
                val sent = repo.sendText(conversationId, text, nonce, s.replyTo?.id, mentions = mentionSpans(text))
                replacePending(nonce, sent.message)
            } catch (e: ApiException) {
                // Leave the bubble in place but mark it failed — silently
                // dropping a message the user watched appear is much worse.
                _state.update { current ->
                    current.copy(
                        messages = current.messages.map { m ->
                            if (m.id == nonce) m.copy(content = m.content, seq = Message.PENDING_SEQ) else m
                        },
                        error = e.message,
                    )
                }
            }
        }
    }

    /**
     * Press a button on a bot's message.
     *
     * Not optimistic. Everywhere else in this app a local guess is right often
     * enough to be worth it, but a button's effect is the bot's to decide — it
     * may approve a sign-in, refuse, or find the request already expired — and
     * showing an outcome we invented would sometimes be a lie about something
     * that matters. So: spinner, then whatever the server says the message now
     * is.
     */
    fun pressComponent(button: gg.yappy.app.data.MessageButton, messageId: String) {
        if (_state.value.pressingComponent != null) return
        _state.update { it.copy(pressingComponent = button.customId) }

        viewModelScope.launch {
            try {
                val updated = repo.pressComponent(conversationId, messageId, button.customId)
                replaceMessage(updated.message)
            } catch (e: ApiException) {
                _state.update { it.copy(error = e.message) }
            } finally {
                _state.update { it.copy(pressingComponent = null) }
            }
        }
    }

    /**
     * Send a picked photo.
     *
     * The bubble appears immediately showing the *local* file — Coil renders a
     * `content://` URI as happily as an https one — so the upload happens behind
     * something the user can already see. A failed upload removes the bubble and
     * surfaces the reason rather than leaving a permanent ghost.
     */
    fun sendImage(uri: android.net.Uri) {
        val s = _state.value
        val nonce = YappyRepository.newNonce()
        val caption = s.draft.trim().takeIf { it.isNotEmpty() }

        val optimistic = Message(
            id = nonce,
            conversationId = conversationId,
            seq = Message.PENDING_SEQ,
            type = "image",
            content = caption,
            senderId = s.meId,
            sender = s.meId?.let { s.members[it] },
            attachments = listOf(
                gg.yappy.app.data.Attachment(id = nonce, url = uri.toString(), mimeType = "image/*"),
            ),
            createdAt = java.time.Instant.now().toString(),
            nonce = nonce,
        )

        _state.update { it.copy(messages = it.messages + optimistic, draft = "") }

        viewModelScope.launch {
            try {
                val uploaded = container.uploader.upload(uri)
                val sent = repo.sendAttachment(conversationId, listOf(uploaded.mediaId), caption, nonce = nonce)
                replacePending(nonce, sent.message)
            } catch (e: Exception) {
                _state.update { current ->
                    current.copy(
                        messages = current.messages.filterNot { it.id == nonce },
                        error = e.message ?: "Could not send that photo",
                    )
                }
            }
        }
    }

    /**
     * Send a recorded voice note.
     *
     * The optimistic bubble carries the recorder's own waveform and duration,
     * so it draws its real shape from the first frame rather than the
     * placeholder derived from a message id — and the local file plays if it is
     * tapped before the upload finishes.
     */
    fun sendVoiceNote(recorded: RecordedVoice) {
        val s = _state.value
        val nonce = YappyRepository.newNonce()
        val filename = "voice-$nonce.m4a"

        val optimistic = Message(
            id = nonce,
            conversationId = conversationId,
            seq = Message.PENDING_SEQ,
            type = "audio",
            senderId = s.meId,
            sender = s.meId?.let { s.members[it] },
            attachments = listOf(
                gg.yappy.app.data.Attachment(
                    id = nonce,
                    url = "",
                    mimeType = "audio/mp4",
                    durationMs = recorded.durationMs,
                    waveform = recorded.waveform,
                    filename = filename,
                ),
            ),
            createdAt = java.time.Instant.now().toString(),
            nonce = nonce,
        )

        _state.update { it.copy(messages = it.messages + optimistic) }

        viewModelScope.launch {
            try {
                val uploaded = container.uploader.uploadBytes(
                    bytes = recorded.bytes,
                    filename = filename,
                    mimeType = "audio/mp4",
                    durationMs = recorded.durationMs,
                )
                val sent = repo.sendAttachment(
                    conversationId,
                    listOf(uploaded.mediaId),
                    type = "audio",
                    nonce = nonce,
                )
                replacePending(nonce, sent.message)
            } catch (e: Exception) {
                _state.update { current ->
                    current.copy(
                        messages = current.messages.filterNot { it.id == nonce },
                        error = e.message ?: "Could not send that voice note",
                    )
                }
            }
        }
    }

    /**
     * Send a recorded video note.
     *
     * The file is read and deleted here rather than in the recorder: the
     * recorder's screen is gone by the time this runs, and a temp file that
     * outlives its sender is how a cache directory fills up.
     */
    fun sendVideoNote(file: java.io.File, durationMs: Int) {
        val s = _state.value
        val nonce = YappyRepository.newNonce()

        val optimistic = Message(
            id = nonce,
            conversationId = conversationId,
            seq = Message.PENDING_SEQ,
            type = "video",
            senderId = s.meId,
            sender = s.meId?.let { s.members[it] },
            attachments = listOf(
                gg.yappy.app.data.Attachment(
                    id = nonce,
                    // Coil renders a local path as happily as an https URL, so
                    // the poster frame is there before the upload starts.
                    url = file.absolutePath,
                    mimeType = "video/mp4",
                    durationMs = durationMs,
                    filename = file.name,
                ),
            ),
            createdAt = java.time.Instant.now().toString(),
            nonce = nonce,
        )

        _state.update { it.copy(messages = it.messages + optimistic) }

        viewModelScope.launch {
            try {
                val bytes = withContext(Dispatchers.IO) { file.readBytes() }
                val uploaded = container.uploader.uploadBytes(
                    bytes = bytes,
                    filename = file.name,
                    mimeType = "video/mp4",
                    durationMs = durationMs,
                )
                val sent = repo.sendAttachment(
                    conversationId,
                    listOf(uploaded.mediaId),
                    type = "video",
                    nonce = nonce,
                )
                replacePending(nonce, sent.message)
            } catch (e: Exception) {
                _state.update { current ->
                    current.copy(
                        messages = current.messages.filterNot { it.id == nonce },
                        error = e.message ?: "Could not send that video note",
                    )
                }
            } finally {
                withContext(Dispatchers.IO) { file.delete() }
            }
        }
    }

    fun clearError() = _state.update { it.copy(error = null) }

    fun sendSticker(sticker: Sticker) {
        viewModelScope.launch {
            runCatching { repo.sendSticker(conversationId, sticker.id) }
                .onSuccess { appendIfMissing(it.message) }
        }
    }

    fun sendGif(gif: GifResult) {
        viewModelScope.launch {
            runCatching { repo.sendGif(conversationId, gif) }.onSuccess { appendIfMissing(it.message) }
            runCatching { repo.rememberGif(gif) }
        }
    }

    fun sendPoll(question: String, options: List<String>, multiSelect: Boolean) {
        viewModelScope.launch {
            runCatching { repo.sendPoll(conversationId, question, options, multiSelect) }
                .onSuccess { appendIfMissing(it.message) }
        }
    }

    /**
     * Mentions are derived from the final text rather than tracked while
     * typing: whatever "@username" tokens survive editing are what gets sent,
     * which matches what the user sees.
     */
    private fun mentionSpans(text: String): List<YappyRepository.MentionSpan> {
        val spans = mutableListOf<YappyRepository.MentionSpan>()
        for (user in _state.value.members.values) {
            val username = user.username ?: continue
            val needle = "@$username"
            var idx = text.indexOf(needle)
            while (idx >= 0) {
                val after = text.getOrNull(idx + needle.length)
                if (after == null || !after.isLetterOrDigit()) {
                    spans += YappyRepository.MentionSpan(idx, needle.length, user.id)
                }
                idx = text.indexOf(needle, idx + needle.length)
            }
        }
        return spans
    }

    fun forward(message: Message, toConversationId: String, onDone: () -> Unit) {
        viewModelScope.launch {
            runCatching { repo.forward(listOf(message.id), listOf(toConversationId)) }
            onDone()
        }
    }

    // ── Message actions ──────────────────────────────────────────────────────

    fun toggleReaction(message: Message, emoji: String) {
        val had = message.myReactions.contains(emoji)

        // Applied locally first: a reaction that waits for a round trip feels
        // broken, and the server event will reconcile either way.
        patchMessage(message.id) { m ->
            val counts = m.reactions.toMutableMap()
            val next = (counts[emoji] ?: 0) + if (had) -1 else 1
            if (next <= 0) counts.remove(emoji) else counts[emoji] = next
            m.copy(
                reactions = counts,
                myReactions = if (had) m.myReactions - emoji else m.myReactions + emoji,
            )
        }

        viewModelScope.launch {
            runCatching {
                if (had) repo.unreact(conversationId, message.id, emoji)
                else repo.react(conversationId, message.id, emoji)
            }
        }
    }

    fun togglePin(message: Message) {
        val pinned = _state.value.pinned.any { it.id == message.id }
        viewModelScope.launch {
            runCatching {
                if (pinned) repo.unpin(conversationId, message.id) else repo.pin(conversationId, message.id)
            }.onSuccess {
                _state.update { s ->
                    s.copy(pinned = if (pinned) s.pinned.filterNot { it.id == message.id } else s.pinned + message)
                }
            }
        }
    }

    fun deleteMessage(message: Message, forEveryone: Boolean) {
        viewModelScope.launch {
            runCatching { repo.deleteMessage(conversationId, message.id, forEveryone) }
            patchMessage(message.id) { it.copy(deletedAt = java.time.Instant.now().toString(), content = null) }
        }
    }

    fun vote(message: Message, optionId: String) {
        val poll = message.poll ?: return
        val next = when {
            poll.multiSelect && poll.myVotes.contains(optionId) -> poll.myVotes - optionId
            poll.multiSelect -> poll.myVotes + optionId
            poll.myVotes.contains(optionId) -> emptyList()
            else -> listOf(optionId)
        }
        viewModelScope.launch {
            runCatching { repo.votePoll(conversationId, message.id, next) }
            patchMessage(message.id) { m -> m.copy(poll = m.poll?.copy(myVotes = next)) }
        }
    }

    // ── GIF picker ───────────────────────────────────────────────────────────

    fun searchGifs(query: String) {
        _state.update { it.copy(gifQuery = query, gifsLoading = true) }
        viewModelScope.launch {
            delay(300) // debounce keystrokes into one provider call
            if (_state.value.gifQuery != query) return@launch
            val result = runCatching {
                if (query.isBlank()) repo.recentGifs() else repo.searchGifs(query)
            }.getOrNull()
            _state.update { it.copy(gifs = result?.results.orEmpty(), gifsLoading = false) }
        }
    }

    // ── Read state ───────────────────────────────────────────────────────────

    /**
     * Debounced: scrolling fires this constantly and only the highest matters.
     *
     * Over the socket when there is one, over REST when there is not. The
     * socket path alone was silently lossy: `command()` is `socket?.send(...)`,
     * so while disconnected the ack went on the floor while this still marked
     * the conversation read locally. The count came back on the next sync, and
     * a chat opened from a cold start — precisely when the socket is still
     * connecting — did its first ack into nothing.
     *
     * `ackedSeq` is what makes a failure recoverable: it only moves once the
     * server has actually been told, so a later scroll or the flush on leaving
     * retries rather than assuming the job is done.
     */
    fun markReadUpTo(seq: Long) {
        if (seq <= 0 || seq <= ackedSeq) return
        readAckJob?.cancel()
        readAckJob = viewModelScope.launch {
            delay(500)

            val delivered = if (container.gateway.state.value is GatewayState.Connected) {
                container.gateway.markRead(conversationId, seq)
                true
            } else {
                runCatching { repo.markRead(conversationId, seq) }.isSuccess
            }
            if (!delivered) return@launch

            ackedSeq = seq
            _state.update { s ->
                s.copy(conversation = s.conversation?.let { c ->
                    c.copy(self = c.self?.copy(lastReadSeq = seq, unreadCount = 0))
                })
            }
            // Tell the home list directly, so its badge clears the moment the
            // person backs out instead of a server round trip later.
            container.conversationRead.tryEmit(conversationId)
        }
    }

    // ── Receipts ─────────────────────────────────────────────────────────────

    /**
     * The tick watermarks, as one snapshot.
     *
     * `seq = 0` returns every receipt-visible member, and the highest watermark
     * among *other* people is what the ticks mean: "someone else has this" and
     * "someone else has read it". Your own row is excluded, or every message
     * would show as read the instant you sent it.
     */
    private fun loadReceipts() {
        viewModelScope.launch {
            val entries = runCatching { repo.receipts(conversationId).readBy }.getOrNull() ?: return@launch
            val meId = _state.value.meId
            val others = entries.filterNot { it.user.id == meId }
            _state.update {
                it.copy(
                    deliveredSeq = others.maxOfOrNull { entry -> entry.deliveredSeq } ?: 0,
                    readSeq = others.maxOfOrNull { entry -> entry.seq } ?: 0,
                )
            }
            saveTimelineSnapshot()
        }
    }

    /** Leave the timeline behind for the next opening of this chat. */
    private fun saveTimelineSnapshot() {
        val s = _state.value
        if (s.messages.isEmpty()) return
        container.screenSnapshots.put(
            "timeline_$conversationId",
            // The tail is enough — the next visit fetches a page of fifty
            // anyway, and this exists to fill one frame.
            TimelineSnapshot(s.conversation, s.messages.takeLast(50), s.deliveredSeq, s.readSeq),
        )
    }

    // ── Calls ────────────────────────────────────────────────────────────────

    suspend fun startCall(video: Boolean): String? =
        runCatching { repo.startCall(conversationId, video).call.id }.getOrNull()

    // ── Live events ──────────────────────────────────────────────────────────

    private fun observeGateway() {
        viewModelScope.launch {
            container.gateway.events.collect { event ->
                val obj = runCatching { event.data.jsonObject }.getOrNull() ?: return@collect
                val target = obj["conversationId"]?.jsonPrimitive?.content

                when (event.type) {
                    "message.create" -> {
                        if (target != conversationId) return@collect
                        val message = runCatching { AppJson.decodeFromJsonElement(Message.serializer(), event.data) }
                            .getOrNull() ?: return@collect
                        appendIfMissing(message)
                        markReadUpTo(message.seq)
                    }

                    "message.update" -> {
                        if (target != conversationId) return@collect
                        runCatching { AppJson.decodeFromJsonElement(Message.serializer(), event.data) }
                            .getOrNull()?.let { replaceMessage(it) }
                    }

                    "message.delete" -> {
                        if (target != conversationId) return@collect
                        val id = obj["id"]?.jsonPrimitive?.content ?: return@collect
                        patchMessage(id) { it.copy(deletedAt = java.time.Instant.now().toString(), content = null) }
                    }

                    "reaction.add", "reaction.remove" -> {
                        if (target != conversationId) return@collect
                        val id = obj["messageId"]?.jsonPrimitive?.content ?: return@collect
                        val emoji = obj["emoji"]?.jsonPrimitive?.content ?: return@collect
                        val userId = obj["userId"]?.jsonPrimitive?.content
                        val adding = event.type == "reaction.add"

                        // Skip our own echo — the optimistic update already
                        // applied it, and re-applying would double-count.
                        if (userId != null && userId == _state.value.meId) return@collect

                        patchMessage(id) { m ->
                            val counts = m.reactions.toMutableMap()
                            val next = (counts[emoji] ?: 0) + if (adding) 1 else -1
                            if (next <= 0) counts.remove(emoji) else counts[emoji] = next
                            m.copy(reactions = counts)
                        }
                    }

                    "typing.start" -> {
                        if (target != conversationId) return@collect
                        val userId = obj["userId"]?.jsonPrimitive?.content ?: return@collect
                        if (userId == _state.value.meId) return@collect
                        _state.update { s ->
                            s.copy(
                                typing = s.typing.filterNot { it.userId == userId } +
                                    TypingUser(userId, System.currentTimeMillis() + 8_000),
                            )
                        }
                    }

                    "typing.stop" -> {
                        val userId = obj["userId"]?.jsonPrimitive?.content ?: return@collect
                        _state.update { s -> s.copy(typing = s.typing.filterNot { it.userId == userId }) }
                    }

                    // Someone else moved a watermark. Applied straight from the
                    // event rather than refetching: the ticks are the most
                    // frequently-changing thing on the screen, and a round trip
                    // per read in a busy group is a lot of nothing.
                    //
                    // Both events already exclude their own sender server-side,
                    // so anything arriving here is genuinely someone else.
                    "read.receipt" -> {
                        if (target != conversationId) return@collect
                        val seq = obj["seq"]?.jsonPrimitive?.content?.toLongOrNull() ?: return@collect
                        _state.update { s ->
                            s.copy(
                                readSeq = maxOf(s.readSeq, seq),
                                // Read implies delivered: a device that has read
                                // a message unquestionably has it.
                                deliveredSeq = maxOf(s.deliveredSeq, seq),
                            )
                        }
                    }

                    "delivery.receipt" -> {
                        if (target != conversationId) return@collect
                        val seq = obj["seq"]?.jsonPrimitive?.content?.toLongOrNull() ?: return@collect
                        _state.update { s -> s.copy(deliveredSeq = maxOf(s.deliveredSeq, seq)) }
                    }

                    "pin.add", "pin.remove" -> {
                        if (target != conversationId) return@collect
                        runCatching { repo.pins(conversationId).pins.map { it.message } }
                            .getOrNull()?.let { pins -> _state.update { it.copy(pinned = pins) } }
                    }

                    "poll.vote" -> {
                        if (target != conversationId) return@collect
                        val messageId = obj["messageId"]?.jsonPrimitive?.content ?: return@collect
                        runCatching { repo.history(conversationId, around = _state.value.messages.find { it.id == messageId }?.seq) }
                            .getOrNull()?.messages?.find { it.id == messageId }
                            ?.let { replaceMessage(it) }
                    }
                }
            }
        }

        // Typing indicators expire client-side too; the stop event can be lost.
        viewModelScope.launch {
            while (true) {
                delay(2_000)
                val now = System.currentTimeMillis()
                _state.update { s ->
                    val live = s.typing.filter { it.expiresAtMs > now }
                    if (live.size == s.typing.size) s else s.copy(typing = live)
                }
            }
        }
    }

    // ── List helpers ─────────────────────────────────────────────────────────

    private fun appendIfMissing(message: Message) {
        _state.update { s ->
            if (s.messages.any { it.id == message.id }) return@update s
            // Replace the optimistic placeholder if this is our own message
            // coming back with a real id and seq.
            val withoutPending = s.messages.filterNot { it.nonce != null && it.nonce == message.nonce }
            s.copy(
                messages = (withoutPending + message).sortedBy { if (it.isPending) Long.MAX_VALUE else it.seq },
                members = s.members + (message.sender?.let { mapOf(it.id to it) } ?: emptyMap()),
            )
        }
    }

    private fun replacePending(nonce: String, message: Message) {
        _state.update { s ->
            s.copy(messages = s.messages.map { if (it.id == nonce) message else it }.distinctBy { it.id })
        }
    }

    private fun replaceMessage(message: Message) {
        _state.update { s -> s.copy(messages = s.messages.map { if (it.id == message.id) message else it }) }
    }

    private fun patchMessage(id: String, transform: (Message) -> Message) {
        _state.update { s -> s.copy(messages = s.messages.map { if (it.id == id) transform(it) else it }) }
    }

    override fun onCleared() {
        container.gateway.typing(conversationId, false)
        // The state as the person last saw it, including anything sent since
        // the fetch — the snapshot from load() alone would repaint a reopened
        // chat *without* their newest messages for a beat, which reads as the
        // send having been lost.
        saveTimelineSnapshot()
        super.onCleared()
    }

    companion object {
        fun factory(container: AppContainer, conversationId: String) = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T =
                ChatViewModel(container, conversationId) as T
        }
    }
}
