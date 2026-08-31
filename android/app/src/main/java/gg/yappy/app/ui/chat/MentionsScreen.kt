package gg.yappy.app.ui.chat

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
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
import androidx.compose.foundation.shape.RoundedCornerShape
import gg.yappy.app.data.MentionEntry
import gg.yappy.app.LocalContainer
import gg.yappy.app.ui.components.Avatar
import gg.yappy.app.ui.components.NeuIconButton
import gg.yappy.app.ui.components.softClickable
import gg.yappy.app.ui.theme.Neu
import gg.yappy.app.ui.theme.neuColors

/**
 * Everywhere you were called.
 *
 * One list across every group, so "where was I pinged while I was away" is a
 * question with an answer — before this it could only be reconstructed by
 * opening each room and looking for the badge, which is exactly the work a
 * notification list exists to save.
 */
@Composable
fun MentionsScreen(
    onBack: () -> Unit,
    /** Opens the room *at* the message, not merely at the bottom of it. */
    onOpenMessage: (conversationId: String, seq: Long) -> Unit,
) {
    val container = LocalContainer.current
    val colors = neuColors

    var entries by remember { mutableStateOf<List<MentionEntry>?>(null) }
    var failed by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        runCatching { container.repo.mentions().mentions }
            .onSuccess { entries = it }
            .onFailure { failed = true }
    }

    Column(
        Modifier
            .fillMaxSize()
            .background(colors.surface)
            // The screen draws edge to edge, so the header has to make room
            // for the clock rather than sitting under it.
            .statusBarsPadding(),
    ) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            NeuIconButton(Icons.AutoMirrored.Rounded.ArrowBack, "Back", onBack)
            Spacer(Modifier.width(12.dp))
            Text(
                "Mentions",
                // headlineSmall, not titleLarge: the app's type scale does not
                // define titleLarge at all, so it fell through to Material's
                // default font and this one title was set in Roboto.
                style = MaterialTheme.typography.headlineSmall,
                color = colors.textPrimary,
            )
        }

        when {
            failed -> Empty("Couldn't load your mentions.")

            entries == null -> Empty("Loading…")

            entries!!.isEmpty() -> Empty(
                "Nobody has called you yet. When somebody uses your name, a role you " +
                    "hold, or @everyone, it lands here.",
            )

            else -> LazyColumn(
                Modifier.fillMaxSize(),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(
                    horizontal = 12.dp,
                    vertical = 6.dp,
                ),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                items(entries!!, key = { it.message?.id ?: it.conversation.id }) { entry ->
                    MentionRow(entry) {
                        val seq = entry.message?.seq ?: return@MentionRow
                        onOpenMessage(entry.conversation.id, seq)
                    }
                }
            }
        }
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
