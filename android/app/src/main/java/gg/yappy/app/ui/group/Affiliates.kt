package gg.yappy.app.ui.group

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import gg.yappy.app.LocalContainer
import gg.yappy.app.data.MemberEntry
import gg.yappy.app.ui.components.Avatar
import gg.yappy.app.ui.components.BadgeMark
import gg.yappy.app.ui.components.softClickable
import gg.yappy.app.ui.theme.Neu
import gg.yappy.app.ui.theme.neuColors

/**
 * Who a badged group has vouched for.
 *
 * Affiliation has always been visible one person at a time — a small logo
 * beside a name, in a chat, if you happened to be looking — and never from
 * the group's side. Which is the side that matters: the mark says "this
 * account speaks for us", and the honest way to check a claim like that is to
 * ask the organisation making it for the list.
 *
 * Read from the group's own endpoint, which verifies membership as it reads,
 * so somebody who left or was removed is gone from here the moment they are
 * gone from the group. A roster that outlives its members is worse than none:
 * a stale credential is exactly what somebody would want to trade on.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AffiliatesSheet(
    conversationId: String,
    groupTitle: String,
    badge: String?,
    onOpenProfile: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    val container = LocalContainer.current
    val colors = neuColors
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    var affiliates by remember(conversationId) { mutableStateOf<List<MemberEntry>?>(null) }
    var failed by remember(conversationId) { mutableStateOf(false) }

    LaunchedEffect(conversationId) {
        runCatching { container.repo.affiliates(conversationId).affiliates }
            .onSuccess { affiliates = it }
            .onFailure { failed = true }
    }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = colors.surface,
        contentColor = colors.textPrimary,
    ) {
        Column(Modifier.padding(horizontal = 20.dp).padding(bottom = 28.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    "Affiliates",
                    style = MaterialTheme.typography.headlineSmall,
                    color = colors.textPrimary,
                )
                if (badge != null) {
                    Spacer(Modifier.width(8.dp))
                    BadgeMark(badge, size = 18.dp)
                }
            }
            Spacer(Modifier.padding(top = 4.dp))
            Text(
                "People $groupTitle vouches for. Its badge can sit beside their name.",
                style = MaterialTheme.typography.bodyMedium,
                color = colors.textTertiary,
            )
            Spacer(Modifier.padding(top = 14.dp))

            when {
                failed -> Note("Couldn't load the list.")

                affiliates == null -> Note("Loading…")

                affiliates!!.isEmpty() -> Note(
                    "Nobody yet. Admins can affiliate a member from their row on the group page.",
                )

                else -> LazyColumn(
                    // Bounded so the sheet never grows past the screen on a
                    // group with a hundred of them; the list scrolls inside.
                    Modifier.heightIn(max = 420.dp),
                    verticalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    items(affiliates!!, key = { it.user.id }) { member ->
                        AffiliateRow(member) { onOpenProfile(member.user.id) }
                    }
                }
            }
        }
    }
}

@Composable
private fun AffiliateRow(member: MemberEntry, onClick: () -> Unit) {
    val colors = neuColors
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(Neu.CornerMedium))
            .softClickable(onClick = onClick)
            .padding(horizontal = 8.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Avatar(
            url = member.user.avatarUrl,
            name = member.user.label,
            id = member.user.id,
            size = 38.dp,
        )
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(
                member.nickname ?: member.user.label,
                style = MaterialTheme.typography.labelLarge,
                color = colors.textPrimary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            member.user.username?.let {
                Text(
                    "@$it",
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.textTertiary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        // The role, when it is one worth naming. An affiliate who also runs
        // the place is a different fact about them than an affiliate who does
        // not, and the list is short enough to afford saying so.
        if (member.role == "owner" || member.role == "admin") {
            Text(
                member.role.replaceFirstChar { it.uppercase() },
                style = MaterialTheme.typography.labelSmall,
                color = colors.textTertiary,
            )
        }
    }
}

@Composable
private fun Note(text: String) {
    val colors = neuColors
    Box(Modifier.fillMaxWidth().padding(vertical = 20.dp), contentAlignment = Alignment.Center) {
        Text(text, style = MaterialTheme.typography.bodyMedium, color = colors.textTertiary)
    }
}
