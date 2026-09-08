package gg.yappy.app.ui.chat

import gg.yappy.app.ui.components.AppHeader
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.customActions
import gg.yappy.app.ui.components.LocalSnackbar
import kotlinx.coroutines.launch
import androidx.compose.foundation.background
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import gg.yappy.app.data.MentionEntry
import gg.yappy.app.data.NotificationEntry
import gg.yappy.app.LocalContainer
import gg.yappy.app.ui.components.Avatar
import gg.yappy.app.ui.components.BADGE_PARTNER
import gg.yappy.app.ui.components.BADGE_VERIFIED
import gg.yappy.app.ui.components.BadgeMark
import gg.yappy.app.ui.components.softClickable
import gg.yappy.app.ui.theme.Neu
import gg.yappy.app.ui.theme.PlaceShape
import gg.yappy.app.ui.theme.neuColors
import gg.yappy.app.ui.util.relativeTime

/**
 * One list of everything that happened to you.
 *
 * This began as the mentions screen behind the "@" in the header, which
 * answered exactly one question — where was I pinged while I was away — and
 * left the app with nowhere to say anything else. Everything the platform did
 * *to* somebody happened in silence: a group verified after its admins asked
 * and waited, an affiliate badge granted, a promotion to administrator. Those
 * arrived as a push, if the push arrived at all, and then existed nowhere.
 *
 * So the "@" became a bell and this became the inbox: mentions and those
 * notices in one time-ordered list. Two sources rather than one endpoint,
 * merged here, because a mention already has a rich shape the server computes
 * — the room, the sender, the snippet, whether it is still unread — and
 * flattening it into a generic notification row would cost all of that to
 * save one request.
 *
 * The whole feed is marked read on open — a bell that stays lit after you
 * have looked at what lit it is a bell people learn to ignore. Read is not
 * the same as cleared, though: a notice can be swiped away for good, which is
 * the only way a feed of things you have already seen stops being a wall to
 * scroll past.
 */
private sealed interface InboxRow {
    val at: String

    /** Stable across pages, so a row fetched twice is drawn once. */
    val key: String

    data class Mention(val entry: MentionEntry) : InboxRow {
        override val at: String get() = entry.message?.createdAt.orEmpty()
        override val key: String get() = "m:" + (entry.message?.id ?: entry.conversation.id)
    }

    data class Notice(val entry: NotificationEntry) : InboxRow {
        override val at: String get() = entry.createdAt
        override val key: String get() = "n:" + entry.id
    }
}

@Composable
fun InboxScreen(
    onBack: () -> Unit,
    /** Opens the room *at* the message, not merely at the bottom of it. */
    onOpenMessage: (conversationId: String, seq: Long) -> Unit,
    onOpenGroup: (conversationId: String) -> Unit,
    onOpenProfile: (userId: String) -> Unit,
) {
    val container = LocalContainer.current
    val colors = neuColors
    val scope = rememberCoroutineScope()
    val snackbar = LocalSnackbar.current

    var rows by remember { mutableStateOf<List<InboxRow>?>(null) }
    var failed by remember { mutableStateOf(false) }

    /**
     * Two sources, two cursors, one list.
     *
     * The feed stopped at one page of each — forty notices and forty mentions
     * and then nothing, with no indication that the rest existed. Both
     * endpoints have always paged; nothing was asking for the second page.
     *
     * Null means "not asked yet", and a source that answers with no cursor is
     * spent. They advance together on each load, which is the simple thing;
     * see [cutoff] for the one place that costs something.
     */
    var noticeCursor by remember { mutableStateOf<String?>(null) }
    var mentionCursor by remember { mutableStateOf<String?>(null) }
    var noticesDone by remember { mutableStateOf(false) }
    var mentionsDone by remember { mutableStateOf(false) }
    var loadingMore by remember { mutableStateOf(false) }

    /**
     * Rows this screen has hidden but not yet told the server about.
     *
     * A dismiss is a delete, and a delete offered without a way back is a
     * delete people are afraid to use. So the row goes now, the request goes
     * when the Undo has had its say, and anything still pending when the
     * screen closes is flushed — the same bargain "Delete for me" makes in a
     * chat, for the same reason.
     */
    val pendingDismiss = remember { mutableStateMapOf<String, NotificationEntry>() }

    suspend fun loadPage(first: Boolean) {
        if (loadingMore) return
        loadingMore = true
        val notices = if (noticesDone && !first) null else {
            runCatching { container.repo.notifications(cursor = noticeCursor) }.getOrNull()
        }
        val mentions = if (mentionsDone && !first) null else {
            runCatching { container.repo.mentions(before = mentionCursor) }.getOrNull()
        }
        if (first && notices == null && mentions == null) {
            failed = true
            loadingMore = false
            return
        }

        notices?.let {
            noticeCursor = it.nextCursor
            if (it.nextCursor == null) noticesDone = true
        }
        mentions?.let {
            mentionCursor = it.nextCursor
            if (it.nextCursor == null) mentionsDone = true
        }

        val fresh = buildList {
            notices?.notifications.orEmpty()
                .filter { copyFor(it) != null }
                .forEach { add(InboxRow.Notice(it)) }
            mentions?.mentions.orEmpty().forEach { add(InboxRow.Mention(it)) }
        }
        rows = ((rows ?: emptyList()) + fresh).distinctBy { it.key }.sortedByDescending { it.at }
        loadingMore = false

        // After the list is drawn, and never allowed to fail it: the count is
        // the server's, and the bell reads it again on the next open.
        if (first && notices != null && runCatching { container.repo.readNotifications() }.isSuccess) {
            container.setUnreadNotifications(0)
        }
    }

    LaunchedEffect(Unit) { loadPage(first = true) }

    /**
     * How far down the merged list is actually settled.
     *
     * Two time-ordered sources merged by date are only complete down to the
     * newer of their two tails: below that, one source has rows fetched and
     * the other does not, so an item shown there could be jumped over by one
     * still on the server. Rows past this are held back rather than drawn in
     * the wrong place — they arrive, correctly ordered, on the next page.
     * Null once both are spent, at which point everything is settled.
     */
    val cutoff: String? = when {
        noticesDone && mentionsDone -> null
        noticesDone -> rows?.filterIsInstance<InboxRow.Mention>()?.minOfOrNull { it.at }
        mentionsDone -> rows?.filterIsInstance<InboxRow.Notice>()?.minOfOrNull { it.at }
        else -> listOfNotNull(
            rows?.filterIsInstance<InboxRow.Notice>()?.minOfOrNull { it.at },
            rows?.filterIsInstance<InboxRow.Mention>()?.minOfOrNull { it.at },
        ).maxOrNull()
    }

    val visible = remember(rows, cutoff, pendingDismiss.size) {
        rows.orEmpty()
            .filter { cutoff == null || it.at >= cutoff }
            .filterNot { it is InboxRow.Notice && pendingDismiss.containsKey(it.entry.id) }
    }

    // Whatever is still parked when the screen goes: the dismiss was asked
    // for, and the snackbar it was waiting on left with the composition.
    androidx.compose.runtime.DisposableEffect(Unit) {
        onDispose {
            val leftover = pendingDismiss.keys.toList()
            pendingDismiss.clear()
            leftover.forEach { id ->
                container.scope.launch { runCatching { container.repo.dismissNotification(id) } }
            }
        }
    }

    Column(
        Modifier
            .fillMaxSize()
            .background(colors.surface)
            // The screen draws edge to edge, so the header has to make room
            // for the clock rather than sitting under it.
            .statusBarsPadding(),
    ) {
        InboxHeader(onBack)

        when {
            failed -> Empty("Couldn't load your notifications.")

            rows == null -> Empty("Loading…")

            visible.isEmpty() -> Empty(
                "Nothing yet. Mentions land here, and so does anything that happens to " +
                    "you or to a place you run — a badge granted, an affiliation, a new role.",
            )

            else -> LazyColumn(
                Modifier.fillMaxSize(),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(
                    horizontal = 12.dp,
                    vertical = 6.dp,
                ),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                items(visible, key = { it.key }) { row ->
                    when (row) {
                        is InboxRow.Mention -> MentionRow(row.entry) {
                            val seq = row.entry.message?.seq ?: return@MentionRow
                            onOpenMessage(row.entry.conversation.id, seq)
                        }

                        is InboxRow.Notice -> DismissibleNotice(
                            entry = row.entry,
                            onDismiss = {
                                pendingDismiss[row.entry.id] = row.entry
                                scope.launch {
                                    val result = snackbar.showSnackbar(
                                        "Dismissed",
                                        actionLabel = "Undo",
                                        duration = SnackbarDuration.Short,
                                    )
                                    if (result == SnackbarResult.ActionPerformed) {
                                        pendingDismiss.remove(row.entry.id)
                                    } else if (pendingDismiss.remove(row.entry.id) != null) {
                                        runCatching { container.repo.dismissNotification(row.entry.id) }
                                    }
                                }
                            },
                        ) {
                            NoticeRow(
                                entry = row.entry,
                                onOpenGroup = onOpenGroup,
                                onOpenProfile = onOpenProfile,
                                onOpenMessage = onOpenMessage,
                            )
                        }
                    }
                }

                // The foot of the list is the trigger. Composed only when it
                // has been scrolled to, which is the whole signal — no
                // scroll-offset arithmetic, and it cannot fire on a list
                // shorter than the screen because it is never reached.
                if (!noticesDone || !mentionsDone) {
                    item(key = "more") {
                        LaunchedEffect(visible.size) { loadPage(first = false) }
                        Box(
                            Modifier.fillMaxWidth().padding(vertical = 20.dp),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(
                                "Loading…",
                                style = MaterialTheme.typography.bodySmall,
                                color = colors.textTertiary,
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
internal fun InboxHeader(onBack: () -> Unit) {
    AppHeader("Notifications", onBack = onBack)
}

/**
 * Swipe a notice away.
 *
 * Only notices. A mention is not a row somebody filed — it is a message that
 * exists, and dismissing it here would either lie about the room's unread
 * state or quietly mark something read that nobody read.
 *
 * Either direction: this is a list, not a form, and making somebody remember
 * which way clears a row is the kind of detail that turns a gesture back into
 * a decision.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DismissibleNotice(
    entry: NotificationEntry,
    onDismiss: () -> Unit,
    content: @Composable () -> Unit,
) {
    val colors = neuColors
    val haptics = LocalHapticFeedback.current
    val state = rememberSwipeToDismissBoxState(
        confirmValueChange = {
            if (it != SwipeToDismissBoxValue.Settled) {
                haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                onDismiss()
            }
            // Never settle into a dismissed state: the row leaves the list
            // because it left `visible`, and a box that also held itself open
            // would animate a gap the list has already closed.
            false
        },
    )

    SwipeToDismissBox(
        state = state,
        backgroundContent = {
            // Only while a swipe is actually under way. A row's own fill is a
            // tint rather than an opaque colour — an unread notice sits on
            // accentSoft — so a backdrop drawn at rest reads straight through
            // it, and every notice in the list carried a ghostly "Dismiss"
            // behind its title.
            if (state.dismissDirection != SwipeToDismissBoxValue.Settled) {
                Box(
                    Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(Neu.CornerMedium))
                        .background(colors.veil)
                        .padding(horizontal = 20.dp, vertical = 14.dp),
                    contentAlignment = if (state.dismissDirection == SwipeToDismissBoxValue.EndToStart) {
                        Alignment.CenterEnd
                    } else {
                        Alignment.CenterStart
                    },
                ) {
                    Text(
                        "Dismiss",
                        style = MaterialTheme.typography.labelLarge,
                        color = colors.textTertiary,
                    )
                }
            }
        },
        // Named for the reader: without it a swipe is an unlabelled gesture
        // and there is no other way to reach the action at all.
        modifier = Modifier.semantics {
            customActions = listOf(CustomAccessibilityAction("Dismiss") { onDismiss(); true })
        },
        content = { content() },
    )
}

/**
 * What a notice says, and where tapping it goes.
 *
 * Written from the row's own `data` rather than from a lookup: the group may
 * have been deleted, the affiliation revoked, the role taken back — and a
 * feed whose history rewrites itself as the world changes is a feed that
 * cannot be trusted to tell you what happened.
 */
private data class NoticeCopy(
    val title: String,
    val body: String,
    /** Squircle for a place, circle for a person — the shape does the explaining. */
    val isPlace: Boolean,
)

private fun copyFor(entry: NotificationEntry): NoticeCopy? {
    if (entry.kind in setOf("message_reminder", "event_reminder", "event_updated", "scheduled_failed")) return NoticeCopy(entry.text("title") ?: "Reminder", entry.text("body") ?: "Open to view this update.", true)
    if (entry.kind in systemNoticeKinds) {
        return NoticeCopy(
            title = entry.text("title") ?: "Account update",
            body = entry.text("body") ?: "Tap to view details.",
            isPlace = false,
        )
    }
    val title = entry.text("title") ?: "a group"
    val badge = entry.text("badge") ?: "verified"
    val actor = entry.actor?.label ?: "Someone"
    return when (entry.kind) {
        "group_verified" -> NoticeCopy(
            if (badge == BADGE_PARTNER) "$title is a yappy partner" else "$title is $badge",
            "The badge is on the group now. Admins can affiliate members from the group page.",
            isPlace = true,
        )

        // The same kind carries a decline and a revocation; `granted` is what
        // tells them apart, and a badge that disappears unexplained is the
        // thing this exists to prevent.
        "group_verification_declined" -> NoticeCopy(
            "$title is no longer $badge",
            "Its affiliates lose the badge with it. You can ask again from group settings.",
            isPlace = true,
        )

        "affiliate_granted" -> NoticeCopy(
            "$title made you an affiliate",
            "Its badge can sit beside your name — turn it on in Settings.",
            isPlace = true,
        )

        "affiliate_revoked" -> NoticeCopy(
            "$title removed your affiliate status",
            "Its badge no longer appears beside your name.",
            isPlace = true,
        )

        "role_granted" -> NoticeCopy(
            "You're ${entry.text("role") ?: "an admin"} of $title",
            "$actor gave you the role.",
            isPlace = true,
        )

        "follow" -> NoticeCopy("$actor followed you", "Tap to see their profile.", isPlace = false)
        "follow_back" -> NoticeCopy(
            "$actor followed you back",
            "You follow each other now.",
            isPlace = false,
        )

        // A kind this build has never heard of — a newer server, an older
        // phone. Skipped rather than rendered as a blank row: a feed with
        // holes in it reads as broken, a shorter feed reads as quiet.
        else -> null
    }
}

@Composable
internal fun NoticeRow(
    entry: NotificationEntry,
    onOpenGroup: (String) -> Unit,
    onOpenProfile: (String) -> Unit,
    onOpenMessage: ((String, Long) -> Unit)? = null,
) {
    val colors = neuColors
    val copy = copyFor(entry) ?: return
    val unread = entry.readAt == null
    val systemNotice = entry.kind in systemNoticeKinds || entry.kind == "scheduled_failed"
    var detailsOpen by remember(entry.id) { mutableStateOf(false) }
    val badge = (entry.text("badge") ?: BADGE_VERIFIED).takeIf {
        entry.kind == "group_verified" && (it == BADGE_VERIFIED || it == BADGE_PARTNER)
    }

    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(Neu.CornerMedium))
            // The same treatment an unread mention gets — one list, one rule
            // for "this is still waiting for you".
            .then(if (unread) Modifier.background(colors.accentSoft) else Modifier)
            .softClickable {
                if (systemNotice) {
                    detailsOpen = true
                    return@softClickable
                }
                val id = entry.targetId ?: return@softClickable
                if (entry.kind == "message_reminder" && onOpenMessage != null) {
                    entry.text("seq")?.toLongOrNull()?.let { onOpenMessage(id, it); return@softClickable }
                }
                when (entry.targetType) {
                    "conversation" -> onOpenGroup(id)
                    "user" -> onOpenProfile(id)
                }
            }
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (unread) {
            Box(
                Modifier
                    .width(2.dp)
                    .height(36.dp)
                    .clip(RoundedCornerShape(Neu.CornerPill))
                    .background(colors.accent),
            )
            Spacer(Modifier.width(8.dp))
        }
        Box(Modifier.size(36.dp)) {
            if (systemNotice) {
                SystemNoticeIcon(entry.kind)
            } else {
                Avatar(
                    // A place notice identifies the group, not the staff actor.
                    url = if (copy.isPlace) entry.text("avatarUrl") else entry.actor?.avatarUrl,
                    name = if (copy.isPlace) entry.text("title") else entry.actor?.label,
                    id = entry.targetId ?: entry.id,
                    size = 36.dp,
                    shape = if (copy.isPlace) PlaceShape else CircleShape,
                    contentDescription = if (copy.isPlace) entry.text("title") else entry.actor?.label,
                )
                if (badge != null) {
                    // The event title names the badge for TalkBack. The seal adds
                    // a visual cue without changing the inbox's shared row layout.
                    BadgeMark(
                        badge,
                        size = 17.dp,
                        modifier = Modifier
                            .align(Alignment.BottomEnd)
                            .offset(x = 4.dp, y = 4.dp)
                            .background(if (unread) colors.accentSoft else colors.surface, CircleShape)
                            .padding(2.dp),
                    )
                }
            }
        }
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(
                copy.title,
                style = MaterialTheme.typography.labelLarge,
                color = colors.textPrimary,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            Spacer(Modifier.height(2.dp))
            Text(
                copy.body,
                style = MaterialTheme.typography.bodyMedium,
                color = colors.textSecondary,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Spacer(Modifier.width(8.dp))
        Text(
            relativeTime(entry.createdAt),
            style = MaterialTheme.typography.labelSmall,
            color = colors.textTertiary,
        )
    }
    if (detailsOpen) {
        NoticeDetails(
            copy.title, copy.body, entry.text("detail"), onDismiss = { detailsOpen = false },
            kind = entry.kind, until = entry.text("until"), supportUrl = entry.text("supportUrl"),
        )
    }
}

@Composable
private fun Empty(text: String) {
    val colors = neuColors
    Box(Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) {
        Text(
            text,
            style = MaterialTheme.typography.bodyMedium,
            color = colors.textTertiary,
        )
    }
}

@Composable
private fun MentionRow(entry: MentionEntry, onClick: () -> Unit) {
    val colors = neuColors
    val sender = entry.message?.sender

    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(Neu.CornerMedium))
            /*
             * A mention still waiting for you.
             *
             * A tint plus a bar down the leading edge rather than a bolder
             * row: the list is already dense with names and room titles, and
             * making half of it heavier makes the whole thing harder to scan.
             * The bar is what the eye finds; the tint says where the run ends.
             *
             * `accentSoft` rather than a hardcoded colour, because it is
             * defined per theme — a pale violet on the light surface and a
             * deep one on the dark. A fixed rgba would have been legible in
             * exactly one of them.
             */
            .then(if (entry.unread) Modifier.background(colors.accentSoft) else Modifier)
            .softClickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 10.dp),
    ) {
        if (entry.unread) {
            Box(
                Modifier
                    .width(2.dp)
                    .height(36.dp)
                    .clip(RoundedCornerShape(Neu.CornerPill))
                    .background(colors.accent),
            )
            Spacer(Modifier.width(8.dp))
        }
        Avatar(
            url = sender?.avatarUrl,
            name = sender?.label,
            id = entry.message?.senderId ?: entry.conversation.id,
            size = 36.dp,
        )
        Spacer(Modifier.width(10.dp))
        Column(Modifier.fillMaxWidth()) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    // A channel names its space: "#general" alone is the title
                    // of half the channels anybody is in.
                    entry.conversation.parentTitle?.let { "$it / ${entry.conversation.title ?: "channel"}" }
                        ?: (entry.conversation.title ?: "Direct message"),
                    style = MaterialTheme.typography.labelLarge,
                    color = colors.textPrimary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                // A direct mention and a broadcast are not the same event to
                // the person receiving one — somebody used your name, or you
                // were in a room that got called.
                if (entry.isBroadcast) {
                    Spacer(Modifier.width(6.dp))
                    Text(
                        "GROUP",
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.textTertiary,
                        modifier = Modifier
                            .clip(RoundedCornerShape(5.dp))
                            .background(colors.veil)
                            .padding(horizontal = 5.dp, vertical = 1.dp),
                    )
                }
            }
            Spacer(Modifier.height(2.dp))
            Text(
                buildString {
                    sender?.label?.let { append(it).append("  ") }
                    append(entry.message?.content?.trim()?.takeIf { it.isNotEmpty() } ?: "sent something")
                },
                style = MaterialTheme.typography.bodyMedium,
                color = colors.textSecondary,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}
