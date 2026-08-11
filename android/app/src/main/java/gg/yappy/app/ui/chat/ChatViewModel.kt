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
import gg.yappy.app.data.LiveLocation
import gg.yappy.app.data.Message
import gg.yappy.app.data.MessageReceiptState
import gg.yappy.app.data.PublicUser
import gg.yappy.app.data.Sticker
import gg.yappy.app.data.StickerPack
import gg.yappy.app.data.YappyRepository
import gg.yappy.app.ui.util.Locator
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
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
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
    /** messageId → where that share is now. Only the ones still moving. */
    val liveLocations: Map<String, LiveLocation> = emptyMap(),
    /**
     * What was missed, when there is enough of it to be worth a card.
     *
     * Cleared the moment it is dismissed *or* the reader scrolls to the
     * bottom — by then they have caught up for real and a summary of it is
     * just something in the way.
     */
    val catchUp: gg.yappy.app.data.CatchUp? = null,
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
    /**
     * Who else has this conversation open right now — ambient co-presence.
     *
     * Not "who is online": these are people looking at this room, which is the
     * difference between a chat and a place.
     */
    val viewers: List<PublicUser> = emptyList(),
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
        enterRoom()
    }

    /**
     * Ambient co-presence: announce arrival, then fetch whoever is already
     * here.
     *
     * Both halves are needed. The socket only carries *changes*, so without the
     * fetch a room somebody has been sitting in for an hour looks empty; without
     * the announce, they never see us either.
     */
    private fun enterRoom() {
        container.gateway.setViewing(conversationId)
        viewModelScope.launch {
            val ids = runCatching { repo.viewersHere(conversationId).userIds }.getOrNull() ?: return@launch
            _state.update { s -> s.copy(viewers = ids.mapNotNull { s.members[it] }) }
        }
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
                // Anything still moving. The socket carries only *changes*, so
                // without this a share that started before we opened the chat
                // draws where it began and never moves again.
                val liveTask = async {
                    runCatching { repo.liveLocations(conversationId).locations }.getOrDefault(emptyList())
                }
                // Alongside the timeline rather than in front of it: a card
                // about what was missed must never be the reason the messages
                // themselves are late.
                val catchUpTask = async { runCatching { repo.catchUp(conversationId) }.getOrNull() }
                val conv = convTask.await()
                val history = historyTask.await()
                val pins = pinsTask.await()
                val live = liveTask.await().associateBy { it.messageId }
                val missed = catchUpTask.await()?.takeIf { it.worthShowing }

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
                        liveLocations = live,
                        catchUp = missed,
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

    /**
     * The draft is spent — clear it here *and* on the server.
     *
     * Clearing the local one was all that happened, and the server kept the
     * text. Drafts are restored on open, so sending a message and then leaving
     * the chat put what you had just sent straight back into the composer when
     * you returned: `/badge @someone` typed once, sent, and waiting in the box
     * for ever after.
     *
     * The pending typing job would eventually have written the empty draft, so
     * this only bit people who left within four seconds of sending — which is
     * most people, most of the time, because sending is often the last thing
     * you do in a chat.
     */
    private fun clearDraft() {
        typingJob?.cancel()
        lastTypingSent = 0
        container.gateway.typing(conversationId, false)
        _state.update { it.copy(draft = "") }
        viewModelScope.launch {
            runCatching { repo.setConversationState(conversationId, draft = "") }
        }
    }

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

    /** Put the card away. Also happens on its own once they reach the bottom. */
    fun dismissCatchUp() = _state.update { it.copy(catchUp = null) }

    fun setReplyTo(message: Message?) = _state.update { it.copy(replyTo = message, editing = null) }

    fun startEditing(message: Message) =
        _state.update { it.copy(editing = message, draft = message.content.orEmpty(), replyTo = null) }

    fun cancelEditing() {
        _state.update { it.copy(editing = null) }
        clearDraft()
    }

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
            _state.update { it.copy(editing = null) }
            clearDraft()
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
            it.copy(messages = it.messages + optimistic, replyTo = null)
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
    /**
     * Send a picked image.
     *
     * The caption arrives as an argument rather than being lifted off the
     * draft. It used to be whatever happened to be in the composer when the
     * picker was opened — text written before choosing the picture, silently
     * attached to it and cleared from the box. It is now written on the
     * preview, about the image visibly in front of you.
     */
    fun sendImage(uri: android.net.Uri, caption: String? = null) {
        val s = _state.value
        val nonce = YappyRepository.newNonce()

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

        _state.update { it.copy(messages = it.messages + optimistic) }
        clearDraft()

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

    /**
     * @param forEveryone true removes it for the whole conversation and leaves
     *   a tombstone; false hides it for this account only, on every device, and
     *   the row is simply gone — there is nothing to tombstone, because for
     *   everyone else the message is still there.
     *
     * The local change is applied only if the request succeeded. It used to run
     * regardless, so a failed delete still looked deleted until the next load.
     */
    fun deleteMessage(message: Message, forEveryone: Boolean) {
        viewModelScope.launch {
            val ok = runCatching { repo.deleteMessage(conversationId, message.id, forEveryone) }.isSuccess
            if (!ok) {
                _state.update { it.copy(error = "Could not delete that message.") }
                return@launch
            }
            if (forEveryone) {
                patchMessage(message.id) { it.copy(deletedAt = java.time.Instant.now().toString(), content = null) }
            } else {
                _state.update { s -> s.copy(messages = s.messages.filterNot { it.id == message.id }) }
            }
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

    // ── Location ─────────────────────────────────────────────────────────────

    /**
     * Share a place. A null [durationSeconds] sends a pin; anything else starts
     * a live share that keeps moving until it ends.
     *
     * The fix is taken here rather than cached, because a stale point sent as
     * "here I am" is the one bug in this feature that would genuinely mislead
     * somebody.
     */
    fun shareLocation(context: android.content.Context, durationSeconds: Long?) {
        viewModelScope.launch {
            val fix = Locator.current(context) ?: Locator.lastKnown(context)
            if (fix == null) {
                _state.update { it.copy(error = "Could not get your location") }
                return@launch
            }
            val liveUntil = durationSeconds?.let {
                java.time.Instant.now().plusSeconds(it).toString()
            }
            runCatching {
                repo.sendLocation(conversationId, fix.latitude, fix.longitude, null, liveUntil)
            }.onSuccess { envelope ->
                appendIfMissing(envelope.message)
                if (durationSeconds != null) {
                    LiveShare.start(container, conversationId, envelope.message.id)
                }
            }.onFailure {
                _state.update { it.copy(error = "Could not share your location") }
            }
        }
    }

    /** End our own live share. The message stays; only the movement stops. */
    fun stopSharing(messageId: String) {
        LiveShare.stopIfSharing(messageId)
        viewModelScope.launch {
            runCatching { repo.stopLocation(conversationId, messageId) }
            _state.update { s ->
                val live = s.liveLocations.toMutableMap()
                live[messageId] = live[messageId]?.copy(endedAt = java.time.Instant.now().toString())
                    ?: return@update s
                s.copy(liveLocations = live)
            }
        }
    }

    /**
     * Report a screenshot of this conversation.
     *
     * Fire and forget, silent on failure: the person who took it is not waiting
     * on an answer, and an error about a notice they never asked to send would
     * be worse than the notice not arriving. The line comes back down the socket
     * like any other system message.
     */
    fun reportScreenshot() {
        viewModelScope.launch { runCatching { repo.reportScreenshot(conversationId) } }
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
                        // `forMe` arrives only on the actor's own topic: another
                        // device on this account hid it, so it goes entirely
                        // rather than leaving a "message was deleted" stub the
                        // person never asked anyone else to see.
                        if (obj["forMe"]?.jsonPrimitive?.booleanOrNull == true) {
                            _state.update { s -> s.copy(messages = s.messages.filterNot { it.id == id }) }
                        } else {
                            patchMessage(id) {
                                it.copy(deletedAt = java.time.Instant.now().toString(), content = null)
                            }
                        }
                    }

                    /** Disappearing messages swept server-side, in bulk. */
                    "message.bulk_delete" -> {
                        if (target != conversationId) return@collect
                        val ids = obj["messageIds"]?.jsonArray
                            ?.mapNotNull { runCatching { it.jsonPrimitive.content }.getOrNull() }
                            ?.toSet() ?: return@collect
                        _state.update { s -> s.copy(messages = s.messages.filterNot { it.id in ids }) }
                    }

                    /** Someone walked into, or out of, this room. */
                    "presence.viewing" -> {
                        if (target != conversationId) return@collect
                        val userId = obj["userId"]?.jsonPrimitive?.content ?: return@collect
                        if (userId == _state.value.meId) return@collect
                        val here = obj["viewing"]?.jsonPrimitive?.booleanOrNull ?: return@collect
                        _state.update { s ->
                            val without = s.viewers.filterNot { it.id == userId }
                            // Only people already in `members` get a face; a
                            // stranger's id with no name to put on it would draw
                            // an empty circle.
                            val person = s.members[userId]
                            s.copy(viewers = if (here && person != null) without + person else without)
                        }
                    }

                    /**
                     * A live share moved.
                     *
                     * Its own event because a share is hundreds of these;
                     * treating each as a message update would rebuild a bubble
                     * from scratch every few seconds for hours.
                     */
                    "location.update" -> {
                        if (target != conversationId) return@collect
                        val point = runCatching {
                            AppJson.decodeFromJsonElement(LiveLocation.serializer(), event.data)
                        }.getOrNull() ?: return@collect
                        _state.update { s ->
                            s.copy(liveLocations = s.liveLocations + (point.messageId to point))
                        }
                    }

                    "location.end" -> {
                        if (target != conversationId) return@collect
                        val messageId = obj["messageId"]?.jsonPrimitive?.content ?: return@collect
                        LiveShare.stopIfSharing(messageId)
                        _state.update { s ->
                            val existing = s.liveLocations[messageId] ?: return@update s
                            // Kept with an end time rather than dropped: the card
                            // should say "ended" over the last known point, not
                            // quietly revert to where the share began.
                            s.copy(
                                liveLocations = s.liveLocations +
                                    (messageId to existing.copy(endedAt = java.time.Instant.now().toString())),
                            )
                        }
                    }

                    /**
                     * Somebody joined or left while this screen was open.
                     *
                     * Two things went stale without this, and both were visible:
                     * the header count, read straight off the conversation
                     * loaded on open, and the names in "Alex added Sam", drawn
                     * from `members` — which cannot contain somebody who
                     * arrived a second ago. The count comes from the event
                     * rather than being incremented here, so two people adding
                     * at once cannot drift it.
                     *
                     * `users` is identity, not membership: on a remove it
                     * carries the person who just left, precisely so the line
                     * about them has a name.
                     */
                    "member.add", "member.remove" -> {
                        if (target != conversationId) return@collect
                        val people = (obj["users"] as? JsonArray).orEmpty().mapNotNull {
                            runCatching { AppJson.decodeFromJsonElement(PublicUser.serializer(), it) }.getOrNull()
                        }
                        val count = obj["memberCount"]?.jsonPrimitive?.intOrNull
                        if (people.isEmpty() && count == null) return@collect
                        _state.update { s ->
                            s.copy(
                                members = if (people.isEmpty()) s.members
                                else s.members + people.associateBy { it.id },
                                conversation = if (count == null) s.conversation
                                else s.conversation?.copy(memberCount = count),
                            )
                        }
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
        // Leaving the screen is leaving the room. Null rather than "some other
        // conversation", because the next screen may not be a chat at all.
        container.gateway.setViewing(null)
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
