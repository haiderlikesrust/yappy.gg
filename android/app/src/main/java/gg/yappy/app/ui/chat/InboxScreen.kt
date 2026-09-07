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
 * The whole feed is marked read on open. There is no per-row dismiss to
 * honour, and a bell that stays lit after you have looked at what lit it is
 * a bell people learn to ignore.
 */
private sealed interface InboxRow {
    val at: String

    data class Mention(val entry: MentionEntry) : InboxRow {
        override val at: String get() = entry.message?.createdAt.orEmpty()
    }

    data class Notice(val entry: NotificationEntry) : InboxRow {
        override val at: String get() = entry.createdAt
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

    var rows by remember { mutableStateOf<List<InboxRow>?>(null) }
    var failed by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        // Independently: a notification centre that goes blank because the
        // mentions query failed would be the more annoying half taking the
        // more important half down with it.
        val notices = runCatching { container.repo.notifications().notifications }.getOrNull()
        val mentions = runCatching { container.repo.mentions().mentions }.getOrNull()
        if (notices == null && mentions == null) {
            failed = true
            return@LaunchedEffect
        }
        rows = buildList {
            notices.orEmpty().filter { copyFor(it) != null }.forEach { add(InboxRow.Notice(it)) }
            mentions.orEmpty().forEach { add(InboxRow.Mention(it)) }
        }.sortedByDescending { it.at }

        // After the list is drawn, and never allowed to fail it: the count is
        // the server's, and the bell reads it again on the next open.
        if (notices != null && runCatching { container.repo.readNotifications() }.isSuccess) {
            container.setUnreadNotifications(0)
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

            rows!!.isEmpty() -> Empty(
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
                items(
                    rows!!,
                    key = { row ->
                        when (row) {
                            is InboxRow.Mention ->
                                "m:" + (row.entry.message?.id ?: row.entry.conversation.id)
                            is InboxRow.Notice -> "n:" + row.entry.id
                        }
                    },
                ) { row ->
                    when (row) {
                        is InboxRow.Mention -> MentionRow(row.entry) {
                            val seq = row.entry.message?.seq ?: return@MentionRow
                            onOpenMessage(row.entry.conversation.id, seq)
                        }

                        is InboxRow.Notice -> NoticeRow(
                            entry = row.entry,
                            onOpenGroup = onOpenGroup,
                            onOpenProfile = onOpenProfile,
                            onOpenMessage = onOpenMessage,
                        )
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
