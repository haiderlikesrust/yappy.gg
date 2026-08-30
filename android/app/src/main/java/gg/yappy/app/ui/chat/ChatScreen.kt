package gg.yappy.app.ui.chat

import androidx.compose.material3.HorizontalDivider
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.StartOffset
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.rounded.KeyboardArrowDown
import androidx.compose.runtime.derivedStateOf
import androidx.compose.ui.draw.alpha
import kotlinx.coroutines.delay
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.Call
import androidx.compose.material.icons.rounded.ContentCopy
import androidx.compose.material.icons.rounded.Delete
import androidx.compose.material.icons.rounded.Edit
import androidx.compose.material.icons.rounded.EmojiEmotions
import androidx.compose.material.icons.rounded.Forum
import androidx.compose.material.icons.rounded.PushPin
import androidx.compose.material.icons.rounded.Reply
import androidx.compose.material.icons.rounded.Shortcut
import androidx.compose.material.icons.rounded.Videocam
import androidx.compose.material.icons.rounded.VisibilityOff
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import gg.yappy.app.LocalContainer
import gg.yappy.app.data.Message
import gg.yappy.app.data.PublicUser
import gg.yappy.app.data.findPumpMints
import gg.yappy.app.ui.components.Avatar
import gg.yappy.app.ui.components.BadgeMark
import gg.yappy.app.ui.components.FlairAvatar
import gg.yappy.app.ui.media.MediaViewer
import gg.yappy.app.ui.media.ViewerItem
import gg.yappy.app.ui.components.NeuIconButton
import gg.yappy.app.ui.components.ringColors
import gg.yappy.app.ui.components.titleColor
import gg.yappy.app.ui.components.NeuSurface
import gg.yappy.app.ui.components.softClickable
import gg.yappy.app.ui.theme.Neu
import gg.yappy.app.ui.theme.neuColors
import gg.yappy.app.ui.util.ScreenshotWatcher
import gg.yappy.app.ui.util.crossesDay
import gg.yappy.app.ui.util.dayLabel
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen(
    conversationId: String,
    onBack: () -> Unit,
    onOpenProfile: (String) -> Unit,
    onOpenGroup: (String) -> Unit,
    onOpenCall: (String) -> Unit,
    onOpenThread: (rootMessageId: String) -> Unit,
) {
    val container = LocalContainer.current
    val vm: ChatViewModel = viewModel(
        key = "chat-$conversationId",
        factory = ChatViewModel.factory(container, conversationId),
    )
    val state by vm.state.collectAsStateWithLifecycle()
    val customEmoji by vm.customEmoji.collectAsStateWithLifecycle()
    val colors = neuColors
    val scope = rememberCoroutineScopeCompat()
    val clipboard = LocalClipboardManager.current
    val haptics = androidx.compose.ui.platform.LocalHapticFeedback.current
    val context = androidx.compose.ui.platform.LocalContext.current

    val listState = rememberLazyListState()

    /**
     * Who is typing, right now rather than who was.
     *
     * Each entry carries its own expiry and nothing recomposes when one lapses,
     * so a sender who closed the app mid-word would have left the dots up until
     * something else happened in the conversation. The tick runs only while
     * somebody is typing and stops on its own.
     */
    var typingTick by remember { mutableStateOf(0L) }
    LaunchedEffect(state.typing) {
        while (state.typing.isNotEmpty()) {
            delay(1_000)
            typingTick = System.currentTimeMillis()
        }
    }
    val typingNow = remember(state.typing, typingTick) {
        state.typing.filter { it.expiresAtMs > System.currentTimeMillis() }
    }

    var pickerOpen by remember { mutableStateOf(false) }
    var pollOpen by remember { mutableStateOf(false) }
    var locationOpen by remember { mutableStateOf(false) }
    var actionTarget by remember { mutableStateOf<Message?>(null) }
    /** The message whose full reaction grid is open — the "+" past the quick eight. */
    var reactionPickerFor by remember { mutableStateOf<Message?>(null) }
    /** Message id the media viewer should open on, or null when it is closed. */
    var viewerAt by remember { mutableStateOf<String?>(null) }
    var forwardTarget by remember { mutableStateOf<Message?>(null) }
    var reactionsTarget by remember { mutableStateOf<Message?>(null) }
    /** Non-null while the full-screen video player is up. */
    var videoUrl by remember { mutableStateOf<String?>(null) }
    var videoNoteOpen by remember { mutableStateOf(false) }
    /** Picked but not yet sent — the preview is up while this is set. */
    var pendingMedia by remember { mutableStateOf<android.net.Uri?>(null) }

    // Content shared at this conversation from the system share sheet. Text
    // lands in the composer, media in the same confirm sheet a picked photo
    // uses — nothing sends until the person says so.
    LaunchedEffect(conversationId) {
        container.consumeShare(conversationId)?.let { share ->
            share.text?.let(vm::setDraft)
            share.uri?.let { pendingMedia = it }
        }
    }

    // id → display name, so a system line can say who rather than "Someone".
    val memberNames = remember(state.members) {
        state.members.mapValues { (_, user) -> user.label }
    }

    /**
     * Somebody screenshotted this conversation.
     *
     * Collected here rather than in the activity so the report names the chat
     * that was actually on screen. Android 14 and up only — see
     * [ScreenshotWatcher] for why older versions stay silent.
     */
    LaunchedEffect(Unit) {
        ScreenshotWatcher.events.collect { vm.reportScreenshot() }
    }

    /**
     * The pre-Android-14 ask.
     *
     * Below 14 there is no capture callback, so the only way to notice one is
     * to watch the media store — which needs permission to read images. That is
     * a large grant for a small courtesy, so it is asked for exactly once, in a
     * chat where the feature means something, and never again whatever the
     * answer. Refusing leaves an app that stays quiet rather than one that
     * keeps asking.
     *
     * On 14 and up this never runs: `permission` is null there and the callback
     * needs nothing.
     */
    val screenshotPermission = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        val activity = context as? android.app.Activity
        if (granted && activity != null) ScreenshotWatcher.start(activity)
    }

    LaunchedEffect(Unit) {
        val required = ScreenshotWatcher.permission ?: return@LaunchedEffect
        if (!ScreenshotWatcher.needsPermission(context)) return@LaunchedEffect
        if (container.session.askedScreenshot()) return@LaunchedEffect
        container.session.setAskedScreenshot()
        screenshotPermission.launch(required)
    }

    val recorder = remember { VoiceRecorder(context) }
    val recording by recorder.recording.collectAsStateWithLifecycle()
    val recordedMs by recorder.elapsedMs.collectAsStateWithLifecycle()
    val recordLevel by recorder.level.collectAsStateWithLifecycle()

    // Asked at the moment the mic is tapped rather than on entry: a chat screen
    // that demands the microphone before a word has been typed is a chat screen
    // people deny the microphone to.
    val micPermission = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted -> if (granted) recorder.start(scope) }

    // The system photo picker: no storage permission, and the app never sees
    // anything the user did not explicitly hand over.
    val pickMedia = rememberLauncherForActivityResult(
        ActivityResultContracts.PickVisualMedia(),
    ) { uri -> if (uri != null) pendingMedia = uri }

    /**
     * This chat is on screen: its own notifications are suppressed, both the
     * system one and the in-app banner. A notification for the conversation you
     * are reading is noise.
     */
    androidx.compose.runtime.DisposableEffect(conversationId) {
        container.foregroundConversationId = conversationId
        onDispose {
            if (container.foregroundConversationId == conversationId) {
                container.foregroundConversationId = null
            }
            // A recording that survives leaving the screen is a hot mic nobody
            // asked for.
            recorder.cancel()
            container.voicePlayer.stop()
        }
    }

    // Stick to the bottom only when already near it — yanking the viewport
    // while someone is reading scrollback is the classic chat-app annoyance.
    LaunchedEffect(state.messages.size) {
        val firstVisible = listState.firstVisibleItemIndex
        if (firstVisible <= 3) listState.animateScrollToItem(0)
    }

    // Report the highest message actually on screen as read.
    LaunchedEffect(listState, state.messages) {
        snapshotFlow { listState.firstVisibleItemIndex }
            .debounce(400)
            .distinctUntilChanged()
            .collect { index ->
                val reversed = state.messages.asReversed()
                reversed.getOrNull(index)?.let { vm.markReadUpTo(it.seq) }
            }
    }

    Column(Modifier.fillMaxSize().imePadding()) {

        // Whatever the list that sent us here already knew, so the header is
        // right on the first frame rather than flashing "…" once per hop
        // between channels. Dropped the moment the real conversation lands.
        val seed = remember(conversationId) { container.headerSeeds[conversationId] }

        /**
         * A board is the same messages in a different posture.
         *
         * Cards read downwards from the top and nothing here is being typed at
         * anybody, so the list is not reversed and there is no composer for
         * somebody who cannot post — an input that returns an error is worse
         * than no input.
         */
        val isBoard = state.conversation?.isBoard == true
        val mayPost = state.conversation?.canPost != false

        ChatTopBar(
            appearance = state.conversation?.appearance ?: seed?.appearance,
            isGroup = state.conversation?.let { it.type != "dm" } ?: (seed?.isGroup ?: false),
            title = state.conversation?.displayName ?: seed?.title ?: "…",
            subtitle = state.typingLabel
                ?: state.conversation?.let { conv ->
                    when {
                        conv.type == "dm" -> conv.otherUser?.let { "@${it.username.orEmpty()}" }
                        // A channel says where it lives — the title alone
                        // ("general") is meaningless out of context.
                        conv.parentTitle != null -> "in ${conv.parentTitle} · ${conv.memberCount} members"
                        else -> "${conv.memberCount} members"
                    }
                }
                ?: seed?.subtitle,
            badge = state.conversation?.let { conv ->
                if (conv.type == "dm") conv.otherUser?.badge else conv.badge
            } ?: seed?.badge,
            avatarUrl = state.conversation?.displayAvatar ?: seed?.avatarUrl,
            avatarSeed = state.conversation?.avatarSeed ?: seed?.avatarSeed ?: conversationId,
            onBack = onBack,
            onTitleClick = {
                // A DM's header is a person; a group's header is a place.
                when (state.conversation?.type) {
                    "dm" -> state.conversation?.otherUser?.id?.let(onOpenProfile)
                    null -> Unit
                    // A channel's own profile is nearly empty — its people,
                    // roles and settings all live on the space.
                    else -> onOpenGroup(state.conversation?.parentId ?: conversationId)
                }
            },
            onCall = { video ->
                scope.launch { vm.startCall(video)?.let(onOpenCall) }
            },
        )

        state.conversation?.endsAt?.let { CampfireBar(it) }

        // Above the timeline rather than inside it. The list is inverted, so
        // "the top" is a different place in content coordinates than it looks —
        // and this is a thing about the conversation rather than a message in
        // it, which is the same reason the pinned bar lives out here.
        AnimatedVisibility(
            visible = state.catchUp != null,
            enter = expandVertically() + fadeIn(),
            exit = shrinkVertically() + fadeOut(),
        ) {
            state.catchUp?.let { missed ->
                CatchUpCard(
                    catchUp = missed,
                    onDismiss = vm::dismissCatchUp,
                    onOpenMessage = { messageId ->
                        // Reading the mention *is* catching up on it.
                        vm.dismissCatchUp()
                        // Only if it is already loaded. Paging history around an
                        // arbitrary message is a real feature (the server has
                        // `around` for it) and pretending to do it here by
                        // scrolling somewhere approximate would be worse than
                        // not moving at all.
                        val index = state.messages.reversed().indexOfFirst { it.id == messageId }
                        if (index >= 0) scope.launch { listState.animateScrollToItem(index) }
                    },
                )
            }
        }

        AnimatedVisibility(
            visible = state.viewers.isNotEmpty(),
            enter = expandVertically() + fadeIn(),
            exit = shrinkVertically() + fadeOut(),
        ) {
            HereNowBar(state.viewers)
        }

        AnimatedVisibility(
            visible = state.pinned.isNotEmpty(),
            enter = expandVertically() + fadeIn(),
            exit = shrinkVertically() + fadeOut(),
        ) {
            PinnedBar(state.pinned)
        }

        Box(Modifier.weight(1f)) {
            /**
             * The room's colour, as a whisper. A flaired group tints only the
             * top of its scrollback — strong enough that walking between two
             * groups feels like changing rooms, faint enough that no bubble,
             * timestamp or divider loses contrast against it. Confined to
             * this Box so the bars above and the composer below stay neutral.
             */
            state.conversation?.appearance?.ringColors()?.let { stops ->
                Box(
                    Modifier
                        .matchParentSize()
                        .background(
                            Brush.verticalGradient(
                                0f to stops[0].copy(alpha = 0.07f),
                                0.5f to stops[1].copy(alpha = 0.03f),
                                1f to Color.Transparent,
                            ),
                        ),
                )
            }
            when {
                state.loading -> Box(Modifier.fillMaxSize(), Alignment.Center) {
                    CircularProgressIndicator(color = colors.accent)
                }

                state.messages.isEmpty() -> Box(Modifier.fillMaxSize(), Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        state.conversation?.appearance?.emoji?.let {
                            Text(it, style = MaterialTheme.typography.displaySmall)
                            Spacer(Modifier.height(10.dp))
                        }
                        Text(
                            "It's quiet in here",
                            style = MaterialTheme.typography.titleMedium,
                            color = colors.textSecondary,
                        )
                        Spacer(Modifier.height(4.dp))
                        Text(
                            "Say something to get started",
                            style = MaterialTheme.typography.bodyMedium,
                            color = colors.textTertiary,
                        )
                    }
                }

                else -> CompositionLocalProvider(LocalCustomEmoji provides customEmoji) { LazyColumn(
                    state = listState,
                    // `fillMaxSize` is load-bearing. Without it the list wraps
                    // its content and the Box aligns that to the top, so a
                    // conversation with two messages pinned them under the
                    // header with a screen of void above the composer — a new
                    // chat read as an abandoned one. Filled, `reverseLayout`'s
                    // default Bottom arrangement settles short conversations
                    // where every other messenger puts them: next to the
                    // keyboard.
                    modifier = Modifier.fillMaxSize(),
                    // Reversed so index 0 is the newest message: new messages
                    // then extend the list at the anchored end and the viewport
                    // does not jump when older pages are prepended.
                    //
                    // Not on a board. A board is a page: it reads downwards from
                    // the top, and a card being rewritten every few seconds must
                    // not drag the view while somebody reads the one above it.
                    reverseLayout = !isBoard,
                    contentPadding = PaddingValues(horizontal = 14.dp, vertical = 8.dp),
                ) {
                    val ordered = if (isBoard) state.messages else state.messages.asReversed()

                    // A board holds statements, not events. "Channel created"
                    // at the top of a notice board is the clearest case of a
                    // chat idea leaking into a page.
                    val visible = if (isBoard) ordered.filter { !it.isSystem } else ordered

                    itemsIndexedKeyed(visible) { index, message ->
                        val newer = visible.getOrNull(index - 1)
                        val older = visible.getOrNull(index + 1)

                        val isMine = message.senderId != null && message.senderId == state.meId
                        // Grouping is a chat idea: several lines from one person
                        // in one breath. On a board each card is its own thing,
                        // posted at its own time, and running two together hides
                        // who wrote the second one.
                        val grouped = !isBoard &&
                            older?.senderId == message.senderId &&
                            older?.isSystem == false &&
                            !message.isSystem
                        // Avatar only on the last bubble of a run — that is what
                        // visually groups consecutive messages from one person.
                        // A page shows no avatars at all; the name carries it.
                        val showAvatar = !isBoard && !isMine &&
                            (newer?.senderId != message.senderId || newer?.isSystem == true)

                        Column(Modifier.animateItem()) {
                            // Air, then a hairline. A card needs to end
                            // visibly without being drawn inside a box —
                            // above rather than below, because the last card
                            // has nothing after it to divide from.
                            if (isBoard && index > 0) {
                                HorizontalDivider(
                                    color = colors.hairline,
                                    modifier = Modifier.padding(vertical = 10.dp),
                                )
                            }
                            /**
                             * Above the bubble, not below it.
                             *
                             * `reverseLayout` flips the order of *items*; it
                             * does not flip the contents of one. So a separator
                             * emitted after its bubble rendered underneath it,
                             * and since the condition fires on the first
                             * message of a new day, "Yesterday" appeared under
                             * yesterday's last message instead of over its
                             * first. Every separator was labelling the wrong
                             * side of the line.
                             */
                            // Not on a board. A date separator answers "when
                            // did this arrive relative to the last thing",
                            // which is a question about a timeline — on a page
                            // it puts "Today" between two notices that have
                            // nothing to do with each other.
                            if (!isBoard && crossesDay(older?.createdAt, message.createdAt)) {
                                DaySeparator(dayLabel(message.createdAt))
                            }

                            /**
                             * Where you were up to. Fires on the first message
                             * past the watermark this visit opened with — and
                             * not on your own or a pending one, because "new to
                             * you" cannot describe something you wrote.
                             */
                            state.unreadMarkerSeq?.let { marker ->
                                if (message.seq > marker &&
                                    !message.isPending &&
                                    message.senderId != state.meId &&
                                    (older == null || older.seq <= marker)
                                ) {
                                    UnreadDivider()
                                }
                            }

                            // A system line is not something you reply to, and a
                            // pending one has no id on the server yet. Nothing on
                            // a board is: it is a page, not a conversation.
                            SwipeToReply(
                                enabled = !isBoard && !message.isSystem && !message.isPending,
                                onReply = { vm.setReplyTo(message) },
                            ) {
                            MessageBubble(
                                message = message,
                                isMine = isMine,
                                showAvatar = showAvatar,
                                isGrouped = grouped,
                                isPinned = state.pinned.any { it.id == message.id },
                                readsAsPage = isBoard,
                                onLongPress = { actionTarget = message },
                                onReactionClick = { vm.toggleReaction(message, it) },
                                onVote = { vm.vote(message, it) },
                                appearance = state.conversation?.appearance,
                                onOpenThread = { onOpenThread(message.threadRootId ?: message.id) },
                                // Opening one photo opens the whole
                                // conversation's photos, positioned on this
                                // one — swiping between them is what people
                                // expect once they are in there. A video is
                                // not part of that gallery: it goes straight
                                // to the player.
                                onOpenMedia = {
                                    val video = message.attachments.firstOrNull()
                                        ?.takeIf { message.type == "video" || it.mimeType.startsWith("video/") }
                                    if (video != null) videoUrl = video.url else viewerAt = message.id
                                },
                                myUserId = state.meId,
                                pressingComponent = state.pressingComponent,
                                onPressComponent = { vm.pressComponent(it, message.id) },
                                receipt = if (isMine) {
                                    state.receiptFor(message)
                                } else {
                                    gg.yappy.app.data.MessageReceiptState.None
                                },
                                names = memberNames,
                                liveLocation = state.liveLocations[message.id],
                                onStopLocation = { vm.stopSharing(message.id) },
                                onDoubleTap = {
                                    haptics.performHapticFeedback(
                                        androidx.compose.ui.hapticfeedback.HapticFeedbackType.LongPress,
                                    )
                                    vm.toggleReaction(message, "❤️")
                                },
                                onMention = { username ->
                                    // Members first — the common case resolves
                                    // with no round trip at all. Only a mention
                                    // of someone who has left, or of a bot the
                                    // list has not loaded, reaches the server.
                                    val known = state.members.values
                                        .firstOrNull { it.username.equals(username, ignoreCase = true) }
                                    if (known != null) {
                                        onOpenProfile(known.id)
                                    } else {
                                        scope.launch {
                                            runCatching { container.repo.userByUsername(username).user }
                                                .getOrNull()?.let { onOpenProfile(it.id) }
                                        }
                                    }
                                },
                                voicePlayer = container.voicePlayer,
                                mediaFactory = container.mediaFactory,
                                onOpenUrl = { url ->
                                    runCatching {
                                        context.startActivity(
                                            android.content.Intent(
                                                android.content.Intent.ACTION_VIEW,
                                                android.net.Uri.parse(url),
                                            ),
                                        )
                                    }
                                },
                            )
                            }

                        }

                        if (index == ordered.lastIndex) {
                            LaunchedEffect(message.id) { vm.loadOlder() }
                        }
                    }
                } }
            }

            /**
             * The way back down, once scrolling up has taken it away.
             *
             * Appears only when genuinely away — a few rows of slack, so
             * glancing at the previous message does not flash a button — and
             * carries a count of what arrived *while* away, which is the only
             * number that means anything up there: total unread belongs to the
             * divider, this answers "did I miss something just now?".
             */
            val awayFromBottom by remember {
                derivedStateOf { listState.firstVisibleItemIndex > 4 }
            }
            var arrivedWhileAway by remember { mutableStateOf(0) }
            LaunchedEffect(awayFromBottom) { if (!awayFromBottom) arrivedWhileAway = 0 }
            LaunchedEffect(state.messages.size) {
                val newest = state.messages.lastOrNull()
                if (awayFromBottom && newest != null && newest.senderId != state.meId) {
                    arrivedWhileAway++
                }
            }

            androidx.compose.animation.AnimatedVisibility(
                visible = awayFromBottom,
                enter = fadeIn() + scaleIn(initialScale = 0.7f),
                exit = fadeOut() + scaleOut(targetScale = 0.7f),
                modifier = Modifier
                    .align(Alignment.BottomEnd)
                    .padding(end = 14.dp, bottom = 12.dp),
            ) {
                Box {
                    NeuIconButton(
                        Icons.Rounded.KeyboardArrowDown,
                        "Jump to latest",
                        {
                            arrivedWhileAway = 0
                            scope.launch { listState.animateScrollToItem(0) }
                        },
                        size = 42.dp,
                        iconSize = 22.dp,
                    )
                    if (arrivedWhileAway > 0) {
                        Text(
                            if (arrivedWhileAway > 99) "99+" else "$arrivedWhileAway",
                            style = MaterialTheme.typography.labelSmall,
                            color = colors.onAccent,
                            modifier = Modifier
                                .align(Alignment.TopEnd)
                                .offset(x = 4.dp, y = (-4).dp)
                                .clip(CircleShape)
                                .background(colors.accent)
                                .padding(horizontal = 5.dp, vertical = 1.dp),
                        )
                    }
                }
            }
        }

        /**
         * Between the timeline and the composer, not inside the list.
         *
         * It was an item at index 0 of a `reverseLayout` list, which is the
         * bottom — and it rendered there perfectly, off the bottom of the
         * screen. A lazy list holds its viewport against the item it was
         * already showing when the list grows, and the only thing that scrolls
         * this one to the end fires on `state.messages.size`, which does not
         * change when somebody starts typing. So the dots were drawn just below
         * the fold and nothing ever went to look.
         *
         * Being an item also quietly shifted every index-based lookup over the
         * list by one while it was there — the read watermark marked the wrong
         * message, and jump-to-message landed one row off. Out here it shifts
         * nothing, is always visible, and matches how the here-now and pinned
         * bars above already come and go.
         */
        val typingWho = typingNow.firstOrNull()?.let { state.members[it.userId] }
        AnimatedVisibility(
            visible = typingNow.isNotEmpty(),
            enter = expandVertically() + fadeIn(),
            exit = shrinkVertically() + fadeOut(),
        ) {
            TypingBubble(who = typingWho)
        }

        // The draft lives on its own flow (see ChatViewModel) and is collected
        // inside this wrapper, whose content lambda is its own recomposition
        // scope — so a keystroke re-runs this call and nothing else on the
        // screen. Before, the draft rode in ChatState and every character
        // re-emitted the whole chat.
        DraftAware(vm) { draft ->
        val previewCa = remember(draft) { findPumpMints(draft).firstOrNull() }
        Column {
        if (previewCa != null) {
            PumpChartCard(
                mint = previewCa,
                onOpenUrl = { url ->
                    runCatching {
                        context.startActivity(
                            android.content.Intent(
                                android.content.Intent.ACTION_VIEW,
                                android.net.Uri.parse(url),
                            ),
                        )
                    }
                },
                compact = true,
                modifier = Modifier.padding(horizontal = 14.dp, vertical = 4.dp),
            )
        }
        if (mayPost) Composer(
            draft = draft,
            onDraftChange = vm::setDraft,
            onSend = {
                // TextHandleMove, not LongPress: a send is routine, and the
                // heavy tick on every message would wear thin by the tenth.
                haptics.performHapticFeedback(
                    androidx.compose.ui.hapticfeedback.HapticFeedbackType.TextHandleMove,
                )
                vm.send()
            },
            replyTo = state.replyTo,
            onCancelReply = { vm.setReplyTo(null) },
            editing = state.editing,
            onCancelEdit = vm::cancelEditing,
            pickerOpen = pickerOpen,
            onTogglePicker = { pickerOpen = !pickerOpen },
            onOpenPoll = { pollOpen = true },
            onOpenLocation = { locationOpen = true },
            canSend = draft.isNotBlank(),
            accentOverride = state.conversation?.appearance?.titleColor(),
            // Remembered: this allocated a fresh filtered list on every
            // recomposition for a membership that changes almost never.
            mentionable = remember(state.members, state.meId) {
                state.members.values.filterNot { it.id == state.meId }
            },
            commands = state.commands,
            onPickMedia = {
                pickMedia.launch(
                    // Videos too. The uploader, the preview, the bubble and the
                    // player have all handled them for a while; the picker was
                    // the one place still saying no.
                    PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo),
                )
            },
            onRecordStart = {
                val granted = androidx.core.content.ContextCompat.checkSelfPermission(
                    context,
                    android.Manifest.permission.RECORD_AUDIO,
                ) == android.content.pm.PackageManager.PERMISSION_GRANTED

                if (granted) {
                    recorder.start(scope)
                } else {
                    micPermission.launch(android.Manifest.permission.RECORD_AUDIO)
                }
            },
            onRecordFinish = {
                scope.launch { recorder.finish()?.let(vm::sendVoiceNote) }
            },
            onRecordCancel = { recorder.cancel() },
            recordingMs = if (recording) recordedMs else null,
            recordingLevel = recordLevel,
            onOpenVideoNote = { videoNoteOpen = true },
        )
        }
        }

        AnimatedVisibility(
            visible = pickerOpen,
            enter = expandVertically() + fadeIn(),
            exit = shrinkVertically() + fadeOut(),
        ) {
            PickerSheet(
                packs = state.stickerPacks,
                recentStickers = state.recentStickers,
                gifs = state.gifs,
                gifQuery = state.gifQuery,
                gifsLoading = state.gifsLoading,
                onGifQueryChange = vm::searchGifs,
                onSticker = { vm.sendSticker(it); pickerOpen = false },
                onGif = { vm.sendGif(it); pickerOpen = false },
                onEmoji = { vm.setDraft(vm.draft.value + it) },
            )
        }

        // Send failures are worth a line of their own: the bubble disappears,
        // so without this the message would just vanish.
        state.error?.let { message ->
            LaunchedEffect(message) {
                kotlinx.coroutines.delay(4_000)
                vm.clearError()
            }
            Text(
                message,
                style = MaterialTheme.typography.labelSmall,
                color = colors.danger,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 4.dp),
            )
        }

        Spacer(Modifier.navigationBarsPadding())
    }

    // ── Message actions ──────────────────────────────────────────────────────

    actionTarget?.let { target ->
        val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
        ModalBottomSheet(
            onDismissRequest = { actionTarget = null },
            sheetState = sheetState,
            containerColor = colors.surface,
            contentColor = colors.textPrimary,
        ) {
            Column(Modifier.padding(horizontal = 16.dp).padding(bottom = 28.dp)) {
                QuickReactions(
                    onPick = { emoji ->
                        haptics.performHapticFeedback(
                            androidx.compose.ui.hapticfeedback.HapticFeedbackType.LongPress,
                        )
                        vm.toggleReaction(target, emoji)
                        actionTarget = null
                    },
                    onMore = {
                        reactionPickerFor = target
                        actionTarget = null
                    },
                )

                Spacer(Modifier.height(16.dp))

                ActionRow(Icons.Rounded.Reply, "Reply") {
                    vm.setReplyTo(target); actionTarget = null
                }
                ActionRow(Icons.Rounded.Forum, "Reply in thread") {
                    actionTarget = null
                    onOpenThread(target.threadRootId ?: target.id)
                }
                ActionRow(Icons.Rounded.Shortcut, "Forward") {
                    actionTarget = null; forwardTarget = target
                }
                if (target.reactions.isNotEmpty()) {
                    ActionRow(Icons.Rounded.EmojiEmotions, "Who reacted") {
                        actionTarget = null; reactionsTarget = target
                    }
                }
                if (!target.content.isNullOrBlank()) {
                    ActionRow(Icons.Rounded.ContentCopy, "Copy text") {
                        clipboard.setText(AnnotatedString(target.content))
                        actionTarget = null
                    }
                }
                ActionRow(
                    Icons.Rounded.PushPin,
                    if (state.pinned.any { it.id == target.id }) "Unpin" else "Pin",
                ) { vm.togglePin(target); actionTarget = null }

                if (target.senderId == state.meId && target.type == "text" && !target.isDeleted) {
                    ActionRow(Icons.Rounded.Edit, "Edit") { vm.startEditing(target); actionTarget = null }
                }
                // Offered for *anyone's* message, unlike "for everyone": hiding
                // something from your own timeline needs no permission over the
                // person who said it, and being unable to dismiss a message
                // someone else sent is exactly when you most want to.
                if (!target.isDeleted) {
                    ActionRow(Icons.Rounded.VisibilityOff, "Delete for me") {
                        vm.deleteMessage(target, forEveryone = false); actionTarget = null
                    }
                }
                if (target.senderId == state.meId && !target.isDeleted) {
                    ActionRow(Icons.Rounded.Delete, "Delete for everyone", danger = true) {
                        vm.deleteMessage(target, forEveryone = true); actionTarget = null
                    }
                }
            }
        }
    }

    // ── Full reaction grid — the "+" past the quick eight ───────────────────

    reactionPickerFor?.let { target ->
        val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
        ModalBottomSheet(
            onDismissRequest = { reactionPickerFor = null },
            sheetState = sheetState,
            containerColor = colors.surface,
            contentColor = colors.textPrimary,
        ) {
            Column(Modifier.padding(horizontal = 16.dp).padding(bottom = 28.dp)) {
                Text("React", style = MaterialTheme.typography.titleMedium, color = colors.textPrimary)
                Spacer(Modifier.height(10.dp))
                ReactionEmojiGrid(onPick = { emoji ->
                    haptics.performHapticFeedback(
                        androidx.compose.ui.hapticfeedback.HapticFeedbackType.LongPress,
                    )
                    vm.toggleReaction(target, emoji)
                    reactionPickerFor = null
                })
            }
        }
    }

    // ── Forward picker ───────────────────────────────────────────────────────

    forwardTarget?.let { target ->
        val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
        var candidates by remember { mutableStateOf<List<gg.yappy.app.data.Conversation>>(emptyList()) }
        LaunchedEffect(target.id) {
            candidates = runCatching { container.repo.conversations().conversations }
                .getOrDefault(emptyList())
        }
        ModalBottomSheet(
            onDismissRequest = { forwardTarget = null },
            sheetState = sheetState,
            containerColor = colors.surface,
            contentColor = colors.textPrimary,
        ) {
            Column(Modifier.padding(horizontal = 16.dp).padding(bottom = 28.dp)) {
                Text("Forward to", style = MaterialTheme.typography.titleMedium, color = colors.textPrimary)
                Spacer(Modifier.height(10.dp))
                candidates.take(12).forEach { conv ->
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(Neu.CornerSmall))
                            .softClickable { vm.forward(target, conv.id) { forwardTarget = null } }
                            .padding(vertical = 8.dp, horizontal = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        gg.yappy.app.ui.components.Avatar(
                            conv.displayAvatar, conv.displayName, conv.avatarSeed, size = 38.dp,
                        )
                        Spacer(Modifier.width(12.dp))
                        Text(
                            conv.displayName,
                            style = MaterialTheme.typography.bodyLarge,
                            color = colors.textPrimary,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
        }
    }

    // ── Media viewer ─────────────────────────────────────────────────────────
    // Built from the loaded timeline rather than a separate fetch: whatever is
    // on screen is what you can swipe through, which is both cheap and exactly
    // what someone tapping a photo in a conversation expects.
    viewerAt?.let { anchorId ->
        val items = remember(state.messages, anchorId) {
            // Every image of every message, not one per message — an album of
            // four photos used to contribute only its cover to the pager.
            state.messages.flatMap { m ->
                m.attachments
                    .filter { it.mimeType.startsWith("image/") }
                    .map { attachment ->
                        m.id to ViewerItem(
                            url = attachment.url,
                            caption = m.content,
                            senderName = m.sender?.label,
                            filename = attachment.filename,
                        )
                    }
            }
        }
        val index = items.indexOfFirst { it.first == anchorId }.coerceAtLeast(0)
        if (items.isEmpty()) {
            viewerAt = null
        } else {
            MediaViewer(
                items = items.map { it.second },
                initialIndex = index,
                onDismiss = { viewerAt = null },
            )
        }
    }

    // ── Video ────────────────────────────────────────────────────────────────

    // Full-screen video, over everything. Not routed through the nav graph: it
    // is a modal over this chat, and pushing a destination would put it in the
    // back stack where Back has to walk past it to leave the conversation.
    videoUrl?.let { url ->
        gg.yappy.app.ui.media.VideoPlayerScreen(
            url = url,
            mediaFactory = container.mediaFactory,
            onDismiss = { videoUrl = null },
        )
    }

    if (videoNoteOpen) {
        VideoNoteRecorderScreen(
            onSend = { file, durationMs -> vm.sendVideoNote(file, durationMs) },
            onDismiss = { videoNoteOpen = false },
        )
    }

    // ── Who reacted ──────────────────────────────────────────────────────────

    reactionsTarget?.let { target ->
        val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
        var details by remember { mutableStateOf<List<gg.yappy.app.data.ReactionDetail>>(emptyList()) }
        LaunchedEffect(target.id) {
            details = runCatching { container.repo.reactionsFor(conversationId, target.id).reactions }
                .getOrDefault(emptyList())
        }
        ModalBottomSheet(
            onDismissRequest = { reactionsTarget = null },
            sheetState = sheetState,
            containerColor = colors.surface,
            contentColor = colors.textPrimary,
        ) {
            Column(Modifier.padding(horizontal = 16.dp).padding(bottom = 28.dp)) {
                Text("Reactions", style = MaterialTheme.typography.titleMedium, color = colors.textPrimary)
                Spacer(Modifier.height(10.dp))
                details.forEach { detail ->
                    Row(
                        Modifier.fillMaxWidth().padding(vertical = 7.dp, horizontal = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(detail.emoji, style = MaterialTheme.typography.titleMedium)
                        Spacer(Modifier.width(12.dp))
                        gg.yappy.app.ui.components.Avatar(
                            detail.user.avatarUrl, detail.user.label, detail.user.id, size = 34.dp,
                        )
                        Spacer(Modifier.width(10.dp))
                        Text(
                            detail.user.label,
                            style = MaterialTheme.typography.bodyLarge,
                            color = colors.textPrimary,
                        )
                    }
                }
            }
        }
    }

    // Over everything, because it is a decision rather than a panel: the chat
    // showing through would invite the same mis-tap this exists to catch.
    pendingMedia?.let { uri ->
        AttachmentPreview(
            uri = uri,
            // Whatever was already typed comes with it, so a caption written
            // before opening the picker is not silently thrown away. Read once
            // at open — .value, not a collect: this dialog does not need to
            // follow further typing, only to inherit what existed.
            initialCaption = vm.draft.value,
            onCancel = { pendingMedia = null },
            onSend = { caption ->
                vm.sendImage(uri, caption)
                pendingMedia = null
            },
        )
    }

    if (locationOpen) {
        val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
        ModalBottomSheet(
            onDismissRequest = { locationOpen = false },
            sheetState = sheetState,
            containerColor = colors.surface,
            contentColor = colors.textPrimary,
        ) {
            LocationShareSheet { seconds ->
                vm.shareLocation(context, seconds)
                locationOpen = false
            }
        }
    }

    if (pollOpen) {
        val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
        ModalBottomSheet(
            onDismissRequest = { pollOpen = false },
            sheetState = sheetState,
            containerColor = colors.surface,
            contentColor = colors.textPrimary,
        ) {
            PollComposer(
                onDismiss = { pollOpen = false },
                onCreate = { q, opts, multi ->
                    vm.sendPoll(q, opts, multi)
                    pollOpen = false
                },
            )
        }
    }
}

@Composable
private fun ChatTopBar(
    appearance: gg.yappy.app.data.ConversationAppearance?,
    isGroup: Boolean,
    title: String,
    subtitle: String?,
    /** The group's badge, or for a DM the other person's. */
    badge: String?,
    avatarUrl: String?,
    avatarSeed: String,
    onBack: () -> Unit,
    onTitleClick: () -> Unit,
    onCall: (Boolean) -> Unit,
) {
    val colors = neuColors
    Row(
        Modifier
            .fillMaxWidth()
            .statusBarsPadding()
            .padding(horizontal = 14.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        NeuIconButton(Icons.AutoMirrored.Rounded.ArrowBack, "Back", onBack, size = 42.dp, iconSize = 19.dp)
        Spacer(Modifier.width(10.dp))

        Row(
            Modifier.weight(1f).softClickable(onClick = onTitleClick),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            FlairAvatar(
                appearance,
                url = avatarUrl,
                name = title,
                id = avatarSeed,
                size = 40.dp,
                shape = if (isGroup) gg.yappy.app.ui.theme.PlaceShape else androidx.compose.foundation.shape.CircleShape,
            )
            Spacer(Modifier.width(10.dp))
            Column {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        title,
                        style = MaterialTheme.typography.titleMedium,
                        color = appearance?.titleColor() ?: colors.textPrimary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                    if (badge != null) {
                        Spacer(Modifier.width(5.dp))
                        BadgeMark(badge, size = 15.dp)
                    }
                    appearance?.emoji?.let {
                        Spacer(Modifier.width(5.dp))
                        Text(it, style = MaterialTheme.typography.titleSmall)
                    }
                }
                if (subtitle != null) {
                    Text(
                        subtitle,
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.accent,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }

        NeuIconButton(Icons.Rounded.Call, "Voice call", { onCall(false) }, size = 42.dp, iconSize = 19.dp)
        Spacer(Modifier.width(8.dp))
        NeuIconButton(Icons.Rounded.Videocam, "Video call", { onCall(true) }, size = 42.dp, iconSize = 19.dp)
    }
}

@Composable
private fun PinnedBar(pinned: List<Message>) {
    val colors = neuColors
    val top = pinned.firstOrNull() ?: return
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 14.dp, vertical = 4.dp)
            .clip(RoundedCornerShape(Neu.CornerSmall))
            .background(colors.veil)
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Rounded.PushPin, null, tint = colors.accent, modifier = Modifier.size(14.dp))
        Spacer(Modifier.width(9.dp))
        Column(Modifier.weight(1f)) {
            Text(
                if (pinned.size > 1) "${pinned.size} pinned messages" else "Pinned message",
                style = MaterialTheme.typography.labelSmall,
                color = colors.accent,
            )
            Text(
                top.content ?: "Attachment",
                style = MaterialTheme.typography.bodyMedium,
                color = colors.textSecondary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

/**
 * The campfire countdown.
 *
 * Always visible rather than tucked into a settings screen, because the end is
 * the whole point of the room — a temporary place whose temporariness you have
 * to go looking for is just a group that deletes itself by surprise. Ticks once
 * a minute up to the last hour, then every second, so the final stretch reads
 * as urgent without burning a frame a second all day.
 */
@Composable
private fun CampfireBar(endsAt: String) {
    val colors = neuColors
    val endMs = remember(endsAt) {
        runCatching { java.time.Instant.parse(endsAt).toEpochMilli() }.getOrNull()
    } ?: return

    var remaining by remember(endsAt) { mutableStateOf(endMs - System.currentTimeMillis()) }
    LaunchedEffect(endsAt) {
        while (true) {
            remaining = endMs - System.currentTimeMillis()
            kotlinx.coroutines.delay(if (remaining < 3_600_000) 1_000 else 60_000)
        }
    }

    val urgent = remaining < 3_600_000
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 14.dp, vertical = 4.dp)
            .clip(RoundedCornerShape(Neu.CornerSmall))
            .background(if (urgent) colors.danger.copy(alpha = 0.14f) else colors.veil)
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("🔥", style = MaterialTheme.typography.labelMedium)
        Spacer(Modifier.width(9.dp))
        Text(
            if (remaining <= 0) "This campfire is going out…" else "Burns down in ${humanCountdown(remaining)}",
            style = MaterialTheme.typography.labelMedium,
            color = if (urgent) colors.danger else colors.textSecondary,
        )
    }
}

/** Coarse on purpose: nobody needs "6 days, 4 hours, 12 minutes and 9 seconds". */
private fun humanCountdown(ms: Long): String {
    val seconds = (ms / 1000).coerceAtLeast(0)
    val days = seconds / 86_400
    val hours = (seconds % 86_400) / 3_600
    val minutes = (seconds % 3_600) / 60
    return when {
        days > 0 -> if (hours > 0) "${days}d ${hours}h" else "${days}d"
        hours > 0 -> if (minutes > 0) "${hours}h ${minutes}m" else "${hours}h"
        minutes > 0 -> "${minutes}m ${seconds % 60}s"
        else -> "${seconds}s"
    }
}

/**
 * "Here now" — who else has this conversation open.
 *
 * Faces, not a count: the whole value is recognising someone. Capped at five
 * because past that it stops being people and starts being a crowd meter.
 */
@Composable
private fun HereNowBar(viewers: List<PublicUser>) {
    val colors = neuColors
    if (viewers.isEmpty()) return
    val shown = viewers.take(5)

    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 14.dp, vertical = 4.dp)
            .clip(RoundedCornerShape(Neu.CornerSmall))
            .background(colors.veil)
            .padding(horizontal = 12.dp, vertical = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // Overlapped, the way a stack of faces reads as "a few people" at a
        // glance without anyone having to count them.
        Row(horizontalArrangement = Arrangement.spacedBy((-8).dp)) {
            shown.forEach { person ->
                Avatar(
                    url = person.avatarUrl,
                    name = person.label,
                    id = person.id,
                    size = 22.dp,
                )
            }
        }
        Spacer(Modifier.width(12.dp))
        Text(
            when {
                viewers.size == 1 -> "${shown[0].label} is here"
                viewers.size == 2 -> "${shown[0].label} and ${shown[1].label} are here"
                else -> "${viewers.size} people are here"
            },
            style = MaterialTheme.typography.labelMedium,
            color = colors.textSecondary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/**
 * "New messages", where they start.
 *
 * A line rather than a chip like [DaySeparator]: a date is a fact about the
 * conversation, this is a fact about *you*, and the accent colour is what
 * separates the two at a glance.
 */
@Composable
private fun UnreadDivider() {
    val colors = neuColors
    Row(
        Modifier.fillMaxWidth().padding(vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier
                .weight(1f)
                .height(1.dp)
                .background(colors.accent.copy(alpha = 0.4f)),
        )
        Text(
            "New messages",
            style = MaterialTheme.typography.labelSmall,
            color = colors.accent,
            modifier = Modifier.padding(horizontal = 10.dp),
        )
        Box(
            Modifier
                .weight(1f)
                .height(1.dp)
                .background(colors.accent.copy(alpha = 0.4f)),
        )
    }
}

@Composable
private fun DaySeparator(label: String) {
    val colors = neuColors
    Box(Modifier.fillMaxWidth().padding(vertical = 14.dp), contentAlignment = Alignment.Center) {
        Box(
            Modifier
                .clip(CircleShape)
                .background(colors.veil)
                .padding(horizontal = 14.dp, vertical = 5.dp),
        ) {
            Text(label, style = MaterialTheme.typography.labelSmall, color = colors.textTertiary)
        }
    }
}

@Composable
private fun ActionRow(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    danger: Boolean = false,
    onClick: () -> Unit,
) {
    val colors = neuColors
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(Neu.CornerSmall))
            .softClickable(onClick = onClick)
            .padding(vertical = 13.dp, horizontal = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            icon,
            null,
            tint = if (danger) colors.danger else colors.textSecondary,
            modifier = Modifier.size(19.dp),
        )
        Spacer(Modifier.width(14.dp))
        Text(
            label,
            style = MaterialTheme.typography.bodyLarge,
            color = if (danger) colors.danger else colors.textPrimary,
        )
    }
}

/** `itemsIndexed` with a stable key, which the stock overload does not expose. */
private inline fun androidx.compose.foundation.lazy.LazyListScope.itemsIndexedKeyed(
    items: List<Message>,
    // The LazyItemScope receiver is passed through on purpose: it is what
    // makes Modifier.animateItem() reachable inside the row content.
    crossinline itemContent: @Composable androidx.compose.foundation.lazy.LazyItemScope.(index: Int, item: Message) -> Unit,
) = items(
    count = items.size,
    key = { items[it].id },
) { index -> itemContent(index, items[index]) }

@Composable
private fun rememberCoroutineScopeCompat() = androidx.compose.runtime.rememberCoroutineScope()

/**
 * Somebody is typing, at the end of the timeline where the message will land.
 *
 * The header already says who, in words. This says *where* — it occupies the
 * spot the next bubble will appear in, so the conversation visibly makes room
 * for it. That is the part a line of header text cannot do, and the reason
 * every messenger worth copying puts it here.
 *
 * Sits below the list rather than in it, for the reasons at the call site.
 */
@Composable
private fun TypingBubble(who: PublicUser?) {
    val colors = neuColors

    Row(
        Modifier.fillMaxWidth().padding(horizontal = 14.dp).padding(top = 2.dp, bottom = 6.dp),
        horizontalArrangement = Arrangement.Start,
        verticalAlignment = Alignment.Bottom,
    ) {
        // The same 32dp avatar and 8dp gutter every incoming bubble uses, so
        // the dots line up with the column of messages rather than beside it.
        Avatar(url = who?.avatarUrl, name = who?.label, id = who?.id ?: "typing", size = 32.dp)
        Spacer(Modifier.width(8.dp))

        Box(
            Modifier
                .clip(RoundedCornerShape(topStart = 5.dp, topEnd = 16.dp, bottomStart = 16.dp, bottomEnd = 16.dp))
                .background(colors.incoming)
                .padding(horizontal = 14.dp, vertical = 13.dp),
        ) {
            Row(horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically) {
                val transition = rememberInfiniteTransition(label = "typing")
                repeat(3) { i ->
                    // One transition, three phases. Staggering the start rather
                    // than running three animations means the dots stay in step
                    // with each other for as long as the bubble is on screen.
                    val alpha by transition.animateFloat(
                        initialValue = 0.28f,
                        targetValue = 1f,
                        animationSpec = infiniteRepeatable(
                            tween(560),
                            repeatMode = RepeatMode.Reverse,
                            initialStartOffset = StartOffset(i * 160),
                        ),
                        label = "dot$i",
                    )
                    Box(
                        Modifier
                            .size(7.dp)
                            .alpha(alpha)
                            .clip(CircleShape)
                            .background(colors.textSecondary),
                    )
                }
            }
        }
    }
}

/**
 * A recomposition firewall around the composer.
 *
 * Collects the draft here so the content lambda — and only it — re-runs per
 * keystroke. See the call site.
 */
@Composable
private fun DraftAware(
    vm: ChatViewModel,
    content: @Composable (draft: String) -> Unit,
) {
    val draft by vm.draft.collectAsStateWithLifecycle()
    content(draft)
}
