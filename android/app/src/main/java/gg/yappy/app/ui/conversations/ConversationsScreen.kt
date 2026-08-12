package gg.yappy.app.ui.conversations

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Archive
import androidx.compose.material.icons.rounded.Call
import androidx.compose.material.icons.rounded.CloudOff
import androidx.compose.material.icons.rounded.Explore
import androidx.compose.material.icons.rounded.NotificationsOff
import androidx.compose.material.icons.rounded.Public
import androidx.compose.material.icons.rounded.PushPin
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.material.icons.rounded.Close
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import kotlinx.coroutines.launch
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import gg.yappy.app.LocalContainer
import gg.yappy.app.data.Conversation
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import gg.yappy.app.ui.components.Avatar
import gg.yappy.app.ui.components.BadgeMark
import gg.yappy.app.ui.components.FlairAvatar
import gg.yappy.app.ui.components.IdentityMarks
import gg.yappy.app.ui.components.LogoMarkGradient
import gg.yappy.app.ui.components.NeuButton
import gg.yappy.app.ui.components.NeuIconButton
import gg.yappy.app.ui.components.SectionLabel
import gg.yappy.app.ui.components.gradientFill
import gg.yappy.app.ui.components.softClickable
import gg.yappy.app.ui.components.titleColor
import gg.yappy.app.ui.components.NeuSurface
import gg.yappy.app.ui.components.NeuTextField
import gg.yappy.app.ui.theme.Neu
import gg.yappy.app.ui.theme.NeuState
import gg.yappy.app.ui.theme.PlaceShape
import gg.yappy.app.ui.theme.neu
import gg.yappy.app.ui.theme.neuColors
import gg.yappy.app.ui.util.relativeTime

@Composable
fun ConversationsScreen(
    onOpenChat: (String) -> Unit,
    /** A space opens its channel list; it has no timeline of its own. */
    onOpenSpace: (String) -> Unit,
    onNewChat: () -> Unit,
    onSettings: () -> Unit,
    onExplore: () -> Unit,
) {
    val container = LocalContainer.current
    val vm: ConversationsViewModel = viewModel(factory = ConversationsViewModel.factory(container))
    val state by vm.state.collectAsStateWithLifecycle()
    val colors = neuColors
    val scope = rememberCoroutineScope()

    // Starts hidden and appears once the answer is known. The other way round
    // shows the card for a frame to somebody who dismissed it a week ago, which
    // is a worse first impression than never having offered it.
    var starterDismissed by remember { mutableStateOf(true) }
    LaunchedEffect(Unit) { starterDismissed = container.session.dismissedStarter() }

    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().statusBarsPadding()) {

            Row(
                Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 14.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    // The lockup is the one place the app says its own name:
                    // mark then wordmark, both in the brand gradient so they
                    // read as one object rather than a logo next to a title.
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        LogoMarkGradient(height = 22.dp)
                        Spacer(Modifier.width(9.dp))
                        Text(
                            "yappy",
                            style = MaterialTheme.typography.headlineMedium.copy(fontWeight = FontWeight.ExtraBold),
                            color = colors.textPrimary,
                            modifier = Modifier.gradientFill(
                                Brush.linearGradient(listOf(colors.accent, Color(0xFF00CEC9))),
                            ),
                        )
                    }
                    // A quiet status line instead of a banner: it matters, but
                    // not enough to steal a row from the list.
                    when {
                        state.showArchived -> Text(
                            "Archived",
                            style = MaterialTheme.typography.labelSmall,
                            color = colors.textTertiary,
                        )
                        !state.connected -> Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(
                                Icons.Rounded.CloudOff,
                                null,
                                tint = colors.textTertiary,
                                modifier = Modifier.size(13.dp),
                            )
                            Spacer(Modifier.width(5.dp))
                            Text(
                                "Connecting…",
                                style = MaterialTheme.typography.labelSmall,
                                color = colors.textTertiary,
                            )
                        }
                    }
                }

                NeuIconButton(Icons.Rounded.Explore, "Explore public groups", onExplore)
                Spacer(Modifier.width(10.dp))
                NeuIconButton(Icons.Rounded.Archive, "Archived", vm::toggleArchived, active = state.showArchived)
                Spacer(Modifier.width(10.dp))
                // Your own face is the door to settings — apps have profiles,
                // yappy has people.
                Box(Modifier.softClickable(onClick = onSettings)) {
                    Avatar(
                        url = state.me?.avatarUrl,
                        name = state.me?.displayName,
                        id = state.me?.id ?: "me",
                        size = 44.dp,
                        presence = "online",
                    )
                }
            }

            NeuTextField(
                value = state.query,
                onValueChange = vm::setQuery,
                placeholder = "Search",
                leading = {
                    Icon(Icons.Rounded.Search, null, tint = colors.textTertiary, modifier = Modifier.size(19.dp))
                },
                shape = RoundedCornerShape(Neu.CornerPill),
                modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp),
            )

            // ── Active now: friends online, one tap from a conversation ──────
            if (state.online.isNotEmpty() && !state.showArchived) {
                Spacer(Modifier.height(14.dp))
                LazyRow(
                    contentPadding = PaddingValues(horizontal = 20.dp),
                    horizontalArrangement = Arrangement.spacedBy(14.dp),
                ) {
                    items(state.online, key = { it.user.id }) { entry ->
                        Column(
                            horizontalAlignment = Alignment.CenterHorizontally,
                            modifier = Modifier.softClickable { vm.startDm(entry.user.id, onOpenChat) },
                        ) {
                            Avatar(
                                url = entry.user.avatarUrl,
                                name = entry.user.label,
                                id = entry.user.id,
                                size = 54.dp,
                                presence = entry.status,
                            )
                            Spacer(Modifier.height(4.dp))
                            Text(
                                entry.user.displayName?.substringBefore(' ') ?: entry.user.label,
                                style = MaterialTheme.typography.labelSmall,
                                color = colors.textSecondary,
                                maxLines = 1,
                            )
                        }
                    }
                }
            }

            Spacer(Modifier.height(12.dp))

            when {
                state.loading -> Box(Modifier.fillMaxSize(), Alignment.Center) {
                    CircularProgressIndicator(color = colors.accent)
                }

                state.visible.isEmpty() -> EmptyState(
                    archived = state.showArchived,
                    searching = state.query.isNotBlank(),
                )

                else -> LazyColumn(
                    contentPadding = PaddingValues(start = 12.dp, end = 12.dp, bottom = 110.dp),
                    verticalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    // Group-first, structurally: places are cards, people are
                    // rows. The home screen argues the product's thesis.
                    val groups = state.visible.filter { it.type != "dm" }
                    val dms = state.visible.filter { it.type == "dm" }

                    if (groups.isNotEmpty()) {
                        item(key = "places-label") {
                            SectionLabel("Places", Modifier.padding(start = 12.dp, top = 4.dp))
                        }
                        items(groups, key = { it.id }) { conversation ->
                            Box(Modifier.animateItem().padding(vertical = 5.dp)) {
                                SwipeRow(
                                    pinned = conversation.self?.isPinned == true,
                                    onPin = { vm.togglePin(conversation) },
                                    onArchive = { vm.archive(conversation) },
                                ) {
                                    ConversationRow(
                                        conversation = conversation,
                                        isTyping = state.isTyping(conversation.id),
                                        asCard = true,
                                        onClick = {
                                            if (conversation.isSpace) onOpenSpace(conversation.id)
                                            else onOpenChat(conversation.id)
                                        },
                                        onPin = { vm.togglePin(conversation) },
                                        onMute = { vm.toggleMute(conversation) },
                                        onArchive = { vm.archive(conversation) },
                                    )
                                }
                            }
                        }
                    }

                    if (dms.isNotEmpty()) {
                        item(key = "people-label") {
                            SectionLabel(
                                "People",
                                Modifier.padding(start = 12.dp, top = if (groups.isEmpty()) 4.dp else 14.dp),
                            )
                        }
                        items(dms, key = { it.id }) { conversation ->
                            Box(Modifier.animateItem()) {
                                SwipeRow(
                                    pinned = conversation.self?.isPinned == true,
                                    onPin = { vm.togglePin(conversation) },
                                    onArchive = { vm.archive(conversation) },
                                ) {
                                    ConversationRow(
                                        conversation = conversation,
                                        isTyping = state.isTyping(conversation.id),
                                        asCard = false,
                                        onClick = { onOpenChat(conversation.id) },
                                        onPin = { vm.togglePin(conversation) },
                                        onMute = { vm.toggleMute(conversation) },
                                        onArchive = { vm.archive(conversation) },
                                    )
                                }
                            }
                        }
                    }

                    /**
                     * No places yet, on a screen whose whole argument is that
                     * places are the product.
                     *
                     * The empty state below only fires at *zero* rows, so an
                     * account with one bot DM and no groups got a single row
                     * and then a screen of nothing — the emptiest surface in
                     * the app was the one that should be selling hardest.
                     * Hidden while searching, where a prompt to start a group
                     * is an answer to a question nobody asked.
                     */
                    if (groups.isEmpty() && !state.showArchived && state.query.isBlank() && !starterDismissed) {
                        item(key = "start-here") {
                            StarterCard(
                                onNewGroup = onNewChat,
                                onExplore = onExplore,
                                onDismiss = {
                                    starterDismissed = true
                                    scope.launch { container.session.setDismissedStarter() }
                                },
                                modifier = Modifier.padding(top = if (dms.isEmpty()) 4.dp else 18.dp),
                            )
                        }
                    }

                    // Server-side message search under the local filter results.
                    if (state.query.isNotBlank() && state.searchHits.isNotEmpty()) {
                        item(key = "search-header") {
                            SectionLabel(
                                "Messages",
                                Modifier.padding(start = 12.dp, top = 16.dp),
                            )
                        }
                        items(state.searchHits, key = { "hit-${it.messageId}" }) { hit ->
                            val conv = state.conversations.find { it.id == hit.conversationId }
                            Row(
                                Modifier
                                    .fillMaxWidth()
                                    .clip(RoundedCornerShape(Neu.CornerSmall))
                                    .softClickable { onOpenChat(hit.conversationId) }
                                    .padding(horizontal = 10.dp, vertical = 8.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Column(Modifier.weight(1f)) {
                                    Text(
                                        conv?.displayName ?: "Conversation",
                                        style = MaterialTheme.typography.labelMedium,
                                        color = colors.textTertiary,
                                    )
                                    Text(
                                        snippetStyled(hit.snippet, colors.accent),
                                        style = MaterialTheme.typography.bodyMedium,
                                        color = colors.textPrimary,
                                        maxLines = 2,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                }
                                Spacer(Modifier.width(8.dp))
                                Text(
                                    relativeTime(hit.createdAt),
                                    style = MaterialTheme.typography.labelSmall,
                                    color = colors.textTertiary,
                                )
                            }
                        }
                    }
                }
            }
        }

        NeuIconButton(
            icon = Icons.Rounded.Add,
            contentDescription = "New chat",
            onClick = onNewChat,
            accent = true,
            size = 62.dp,
            iconSize = 27.dp,
            modifier = Modifier
                .align(Alignment.BottomEnd)
                .padding(end = 22.dp, bottom = 34.dp),
        )
    }
}

@Composable
private fun ConversationRow(
    conversation: Conversation,
    isTyping: Boolean,
    asCard: Boolean,
    onClick: () -> Unit,
    onPin: () -> Unit,
    onMute: () -> Unit,
    onArchive: () -> Unit,
) {
    val colors = neuColors
    var menuOpen by remember { mutableStateOf(false) }
    val unread = conversation.unread

    Box {
        // Places are raised cards — they are the few objects the "few raised
        // elements" rule budgets for. People stay flat rows.
        NeuSurface(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(Neu.CornerMedium),
            state = if (asCard) NeuState.Raised else NeuState.Flat,
            elevation = if (asCard) 5.dp else 0.dp,
            contentPadding = if (asCard) 14.dp else 12.dp,
            onClick = onClick,
            onLongClick = { menuOpen = true },
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                FlairAvatar(
                    appearance = conversation.appearance,
                    url = conversation.displayAvatar,
                    name = conversation.displayName,
                    id = conversation.avatarSeed,
                    size = if (asCard) 54.dp else 48.dp,
                    shape = if (asCard) PlaceShape else CircleShape,
                )

                Spacer(Modifier.width(13.dp))

                Column(Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            conversation.displayName,
                            style = MaterialTheme.typography.titleMedium.copy(
                                fontWeight = if (unread > 0) FontWeight.Bold else FontWeight.SemiBold,
                            ),
                            color = conversation.appearance?.titleColor() ?: colors.textPrimary,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f, fill = false),
                        )
                        // A DM row shows the *person's* marks; a group row shows
                        // the group's own. Same slot either way, because the
                        // row is always answering "who is this".
                        if (conversation.type == "dm") {
                            conversation.otherUser?.let { other ->
                                if (other.badge != null || other.affiliation != null) {
                                    Spacer(Modifier.width(5.dp))
                                    IdentityMarks(other, size = 14.dp)
                                }
                            }
                        } else if (conversation.badge != null) {
                            Spacer(Modifier.width(5.dp))
                            BadgeMark(conversation.badge, size = 14.dp)
                        }
                        conversation.appearance?.emoji?.let {
                            Spacer(Modifier.width(5.dp))
                            Text(it, style = MaterialTheme.typography.titleSmall)
                        }
                        if (conversation.isPublic) {
                            Spacer(Modifier.width(6.dp))
                            Icon(
                                Icons.Rounded.Public,
                                "Public group",
                                tint = conversation.appearance?.titleColor() ?: colors.textTertiary,
                                modifier = Modifier.size(13.dp),
                            )
                        }
                        // The pulse: people are in this group right now.
                        if (conversation.hereCount > 0 && conversation.type != "dm") {
                            Spacer(Modifier.width(7.dp))
                            Row(
                                Modifier
                                    .clip(RoundedCornerShape(Neu.CornerPill))
                                    .background(colors.success.copy(alpha = 0.14f))
                                    .padding(horizontal = 7.dp, vertical = 2.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Box(Modifier.size(6.dp).background(colors.success, CircleShape))
                                Spacer(Modifier.width(4.dp))
                                Text(
                                    "${conversation.hereCount} here",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = colors.success,
                                )
                            }
                        }
                        if (conversation.self?.isPinned == true) {
                            Spacer(Modifier.width(6.dp))
                            Icon(
                                Icons.Rounded.PushPin,
                                null,
                                tint = colors.textTertiary,
                                modifier = Modifier.size(13.dp),
                            )
                        }
                        if (conversation.isMuted) {
                            Spacer(Modifier.width(6.dp))
                            Icon(
                                Icons.Rounded.NotificationsOff,
                                null,
                                tint = colors.textTertiary,
                                modifier = Modifier.size(13.dp),
                            )
                        }
                    }

                    if (asCard) {
                        Text(
                            "${conversation.memberCount} members",
                            style = MaterialTheme.typography.labelSmall,
                            color = colors.textTertiary,
                        )
                    }

                    Spacer(Modifier.height(3.dp))

                    if (isTyping) {
                        Text(
                            "typing…",
                            style = MaterialTheme.typography.bodyMedium.copy(fontStyle = FontStyle.Italic),
                            color = colors.accent,
                        )
                    } else {
                        Text(
                            conversation.lastMessage?.preview ?: "No messages yet",
                            style = MaterialTheme.typography.bodyMedium,
                            color = if (unread > 0) colors.textSecondary else colors.textTertiary,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }

                Spacer(Modifier.width(10.dp))

                Column(horizontalAlignment = Alignment.End) {
                    Text(
                        relativeTime(conversation.lastMessageAt),
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.textTertiary,
                    )
                    Spacer(Modifier.height(6.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        // Unanswered mention outranks a plain unread count.
                        if ((conversation.self?.mentionCount ?: 0) > 0) {
                            Box(
                                Modifier
                                    .clip(CircleShape)
                                    .background(colors.danger)
                                    .padding(horizontal = 7.dp, vertical = 3.dp),
                            ) {
                                Text("@", style = MaterialTheme.typography.labelSmall, color = colors.onAccent)
                            }
                            Spacer(Modifier.width(5.dp))
                        }
                        if (unread > 0) {
                            Box(
                                Modifier
                                    .clip(CircleShape)
                                    .background(colors.accent)
                                    .padding(horizontal = if (unread > 9) 7.dp else 8.dp, vertical = 3.dp),
                            ) {
                                Text(
                                    if (unread > 99) "99+" else unread.toString(),
                                    style = MaterialTheme.typography.labelSmall,
                                    color = colors.onAccent,
                                )
                            }
                        }
                    }
                    if (conversation.activeCall != null) {
                        Spacer(Modifier.height(5.dp))
                        Row(
                            Modifier
                                .clip(RoundedCornerShape(Neu.CornerPill))
                                .background(colors.success.copy(alpha = 0.16f))
                                .padding(horizontal = 7.dp, vertical = 2.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Icon(
                                Icons.Rounded.Call,
                                null,
                                tint = colors.success,
                                modifier = Modifier.size(10.dp),
                            )
                            Spacer(Modifier.width(3.dp))
                            Text("Live", style = MaterialTheme.typography.labelSmall, color = colors.success)
                        }
                    }
                }
            }
        }

        DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
            DropdownMenuItem(
                text = { Text(if (conversation.self?.isPinned == true) "Unpin" else "Pin to top") },
                onClick = { menuOpen = false; onPin() },
            )
            DropdownMenuItem(
                text = { Text(if (conversation.isMuted) "Unmute" else "Mute") },
                onClick = { menuOpen = false; onMute() },
            )
            DropdownMenuItem(
                text = { Text("Archive") },
                onClick = { menuOpen = false; onArchive() },
            )
        }
    }
}

/** Postgres ts_headline marks matches with <em> tags; render them as accents. */
private fun snippetStyled(snippet: String, highlight: Color) =
    androidx.compose.ui.text.buildAnnotatedString {
        var rest = snippet
        while (true) {
            val start = rest.indexOf("<em>")
            if (start < 0) { append(rest); break }
            append(rest.substring(0, start))
            val end = rest.indexOf("</em>", start)
            if (end < 0) { append(rest.substring(start + 4)); break }
            withStyle(
                androidx.compose.ui.text.SpanStyle(color = highlight, fontWeight = FontWeight.SemiBold),
            ) { append(rest.substring(start + 4, end)) }
            rest = rest.substring(end + 5)
        }
    }

@Composable
private fun EmptyState(archived: Boolean, searching: Boolean) {
    val colors = neuColors
    Box(Modifier.fillMaxSize(), Alignment.Center) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier.padding(40.dp),
        ) {
            Box(
                Modifier
                    .size(88.dp)
                    .neu(CircleShape, colors, NeuState.Pressed, 8.dp),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    if (archived) Icons.Rounded.Archive else Icons.Rounded.Add,
                    null,
                    tint = colors.textTertiary,
                    modifier = Modifier.size(34.dp),
                )
            }
            Spacer(Modifier.height(18.dp))
            Text(
                when {
                    searching -> "Nothing matches that"
                    archived -> "No archived chats"
                    else -> "Nobody here yet"
                },
                style = MaterialTheme.typography.titleMedium,
                color = colors.textSecondary,
            )
            Spacer(Modifier.height(6.dp))
            Text(
                when {
                    searching -> "Try a different search."
                    archived -> "Chats you archive will show up here."
                    // Not "start a conversation" — with whom? Somebody who has
                    // just arrived knows nobody here, so the one action the
                    // screen used to offer was the one they could not take.
                    else -> "Make a group and send the link to your friends. Tap +, or ask @yapper."
                },
                style = MaterialTheme.typography.bodyMedium,
                color = colors.textTertiary,
            )
        }
    }
}

/**
 * The nudge for an account with no places yet.
 *
 * Two doors rather than one, because "start a group" only helps someone who
 * already has people to put in it. Anyone arriving alone needs somewhere that
 * is already warm, which is what Explore is for.
 */
@Composable
private fun StarterCard(
    onNewGroup: () -> Unit,
    onExplore: () -> Unit,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = neuColors

    NeuSurface(
        modifier = modifier.fillMaxWidth().padding(horizontal = 4.dp),
        shape = RoundedCornerShape(Neu.CornerLarge),
        contentPadding = 18.dp,
    ) {
        Column {
            Row(verticalAlignment = Alignment.Top) {
                Column(Modifier.weight(1f)) {
                    Text(
                        "Places are the point",
                        style = MaterialTheme.typography.titleMedium,
                        color = colors.textPrimary,
                    )
                    Spacer(Modifier.height(4.dp))
                    Text(
                        "A group in yappy is somewhere you go, not a thread you scroll. " +
                            "It keeps its own pins, photos and whoever is around right now.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = colors.textTertiary,
                    )
                }
                // An argument you cannot put down is a lecture. It has been
                // read by the time it is in the way, and it does not come back.
                Spacer(Modifier.width(8.dp))
                NeuIconButton(
                    Icons.Rounded.Close,
                    "Dismiss",
                    onDismiss,
                    size = 30.dp,
                    iconSize = 15.dp,
                )
            }
            Spacer(Modifier.height(16.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                NeuButton(
                    onClick = onNewGroup,
                    accent = true,
                    modifier = Modifier.weight(1f),
                ) {
                    Text(
                        "Start a group",
                        style = MaterialTheme.typography.labelLarge,
                        color = colors.onAccent,
                    )
                }
                NeuButton(
                    onClick = onExplore,
                    modifier = Modifier.weight(1f),
                ) {
                    Text(
                        "Explore",
                        style = MaterialTheme.typography.labelLarge,
                        color = colors.textPrimary,
                    )
                }
            }
        }
    }
}
