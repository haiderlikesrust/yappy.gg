package gg.yappy.app.ui.chat

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
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
import androidx.compose.foundation.lazy.LazyColumn
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
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
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
import gg.yappy.app.ui.components.BadgeMark
import gg.yappy.app.ui.components.FlairAvatar
import gg.yappy.app.ui.media.MediaViewer
import gg.yappy.app.ui.media.ViewerItem
import gg.yappy.app.ui.components.NeuIconButton
import gg.yappy.app.ui.components.titleColor
import gg.yappy.app.ui.components.NeuSurface
import gg.yappy.app.ui.components.softClickable
import gg.yappy.app.ui.theme.Neu
import gg.yappy.app.ui.theme.neuColors
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
    val colors = neuColors
    val scope = rememberCoroutineScopeCompat()
    val clipboard = LocalClipboardManager.current
    val context = androidx.compose.ui.platform.LocalContext.current

    val listState = rememberLazyListState()
    var pickerOpen by remember { mutableStateOf(false) }
    var pollOpen by remember { mutableStateOf(false) }
    var actionTarget by remember { mutableStateOf<Message?>(null) }
    /** Message id the media viewer should open on, or null when it is closed. */
    var viewerAt by remember { mutableStateOf<String?>(null) }
    var forwardTarget by remember { mutableStateOf<Message?>(null) }
    var reactionsTarget by remember { mutableStateOf<Message?>(null) }

    // The system photo picker: no storage permission, and the app never sees
    // anything the user did not explicitly hand over.
    val pickMedia = rememberLauncherForActivityResult(
        ActivityResultContracts.PickVisualMedia(),
    ) { uri -> if (uri != null) vm.sendImage(uri) }

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

        ChatTopBar(
            appearance = state.conversation?.appearance,
            isGroup = state.conversation != null && state.conversation?.type != "dm",
            title = state.conversation?.displayName ?: "…",
            subtitle = state.typingLabel
                ?: state.conversation?.let { conv ->
                    when {
                        conv.type == "dm" -> conv.otherUser?.let { "@${it.username.orEmpty()}" }
                        // A channel says where it lives — the title alone
                        // ("general") is meaningless out of context.
                        conv.parentTitle != null -> "in ${conv.parentTitle} · ${conv.memberCount} members"
                        else -> "${conv.memberCount} members"
                    }
                },
            badge = state.conversation?.let { conv ->
                if (conv.type == "dm") conv.otherUser?.badge else conv.badge
            },
            avatarUrl = state.conversation?.displayAvatar,
            avatarSeed = state.conversation?.avatarSeed ?: conversationId,
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

        AnimatedVisibility(
            visible = state.pinned.isNotEmpty(),
            enter = expandVertically() + fadeIn(),
            exit = shrinkVertically() + fadeOut(),
        ) {
            PinnedBar(state.pinned)
        }

        Box(Modifier.weight(1f)) {
            when {
                state.loading -> Box(Modifier.fillMaxSize(), Alignment.Center) {
                    CircularProgressIndicator(color = colors.accent)
                }

                state.messages.isEmpty() -> Box(Modifier.fillMaxSize(), Alignment.Center) {
                    Text(
                        "Say something to get started",
                        style = MaterialTheme.typography.bodyMedium,
                        color = colors.textTertiary,
                    )
                }

                else -> LazyColumn(
                    state = listState,
                    // Reversed so index 0 is the newest message: new messages
                    // then extend the list at the anchored end and the viewport
                    // does not jump when older pages are prepended.
                    reverseLayout = true,
                    contentPadding = PaddingValues(horizontal = 14.dp, vertical = 8.dp),
                ) {
                    val ordered = state.messages.asReversed()

                    itemsIndexedKeyed(ordered) { index, message ->
                        val newer = ordered.getOrNull(index - 1)
                        val older = ordered.getOrNull(index + 1)

                        val isMine = message.senderId != null && message.senderId == state.meId
                        val grouped = older?.senderId == message.senderId &&
                            older?.isSystem == false &&
                            !message.isSystem
                        // Avatar only on the last bubble of a run — that is what
                        // visually groups consecutive messages from one person.
                        val showAvatar = !isMine &&
                            (newer?.senderId != message.senderId || newer?.isSystem == true)

                        Column {
                            MessageBubble(
                                message = message,
                                isMine = isMine,
                                showAvatar = showAvatar,
                                isGrouped = grouped,
                                isPinned = state.pinned.any { it.id == message.id },
                                onLongPress = { actionTarget = message },
                                onReactionClick = { vm.toggleReaction(message, it) },
                                onVote = { vm.vote(message, it) },
                                appearance = state.conversation?.appearance,
                                onOpenThread = { onOpenThread(message.threadRootId ?: message.id) },
                                // Opening one photo opens the whole
                                // conversation's photos, positioned on this
                                // one — swiping between them is what people
                                // expect once they are in there.
                                onOpenMedia = { viewerAt = message.id },
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

                            // Day separator sits *below* in a reversed list.
                            if (crossesDay(older?.createdAt, message.createdAt)) {
                                DaySeparator(dayLabel(message.createdAt))
                            }
                        }

                        if (index == ordered.lastIndex) {
                            LaunchedEffect(message.id) { vm.loadOlder() }
                        }
                    }
                }
            }
        }

        Composer(
            draft = state.draft,
            onDraftChange = vm::setDraft,
            onSend = vm::send,
            replyTo = state.replyTo,
            onCancelReply = { vm.setReplyTo(null) },
            editing = state.editing,
            onCancelEdit = vm::cancelEditing,
            pickerOpen = pickerOpen,
            onTogglePicker = { pickerOpen = !pickerOpen },
            onOpenPoll = { pollOpen = true },
            canSend = state.draft.isNotBlank(),
            accentOverride = state.conversation?.appearance?.titleColor(),
            mentionable = state.members.values.filterNot { it.id == state.meId },
            onPickMedia = {
                pickMedia.launch(
                    PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly),
                )
            },
        )

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
                onEmoji = { vm.setDraft(state.draft + it) },
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
                QuickReactions(onPick = { emoji ->
                    vm.toggleReaction(target, emoji)
                    actionTarget = null
                })

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
                if (target.senderId == state.meId && !target.isDeleted) {
                    ActionRow(Icons.Rounded.Delete, "Delete for everyone", danger = true) {
                        vm.deleteMessage(target, forEveryone = true); actionTarget = null
                    }
                }
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
            state.messages
                .filter { it.attachments.any { a -> a.mimeType.startsWith("image/") } }
                .map { m ->
                    val attachment = m.attachments.first { it.mimeType.startsWith("image/") }
                    m.id to ViewerItem(
                        url = attachment.url,
                        caption = m.content,
                        senderName = m.sender?.label,
                        filename = attachment.filename,
                    )
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
            .background(colors.dark.copy(alpha = 0.08f))
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

@Composable
private fun DaySeparator(label: String) {
    val colors = neuColors
    Box(Modifier.fillMaxWidth().padding(vertical = 14.dp), contentAlignment = Alignment.Center) {
        Box(
            Modifier
                .clip(CircleShape)
                .background(colors.dark.copy(alpha = 0.10f))
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
    crossinline itemContent: @Composable (index: Int, item: Message) -> Unit,
) = items(
    count = items.size,
    key = { items[it].id },
) { index -> itemContent(index, items[index]) }

@Composable
private fun rememberCoroutineScopeCompat() = androidx.compose.runtime.rememberCoroutineScope()
