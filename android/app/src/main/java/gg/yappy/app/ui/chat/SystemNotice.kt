package gg.yappy.app.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Block
import androidx.compose.material.icons.rounded.BugReport
import androidx.compose.material.icons.rounded.Schedule
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Devices
import androidx.compose.material.icons.rounded.Flag
import androidx.compose.material.icons.rounded.GroupRemove
import androidx.compose.material.icons.rounded.Shield
import androidx.compose.material.icons.rounded.WorkspacePremium
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import gg.yappy.app.data.SupportLinks
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.Dp
import gg.yappy.app.ui.components.NeuButton
import gg.yappy.app.ui.components.NeuIconButton
import gg.yappy.app.ui.components.NeuSurface
import gg.yappy.app.ui.theme.NeuState
import gg.yappy.app.ui.theme.neuColors
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

internal val systemNoticeKinds = setOf(
    "account_suspended", "account_restored", "new_sign_in", "badge_granted", "badge_revoked",
    "group_removed", "group_banned", "group_unbanned", "report_reviewed", "bug_updated",
)

@Composable
internal fun SystemNoticeIcon(kind: String, size: Dp = 36.dp) {
    val colors = neuColors
    val tint = when (kind) {
        "account_suspended", "group_banned" -> colors.danger
        "new_sign_in" -> colors.warning
        else -> colors.accent
    }
    val icon = when (kind) {
        "account_suspended", "group_banned" -> Icons.Rounded.Block
        "new_sign_in" -> Icons.Rounded.Devices
        "badge_granted", "badge_revoked" -> Icons.Rounded.WorkspacePremium
        "group_removed" -> Icons.Rounded.GroupRemove
        "report_reviewed" -> Icons.Rounded.Flag
        "bug_updated" -> Icons.Rounded.BugReport
        else -> Icons.Rounded.Shield
    }
    Box(Modifier.size(size).background(tint.copy(alpha = 0.12f), CircleShape), contentAlignment = Alignment.Center) {
        Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(size * 0.58f))
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun NoticeDetails(
    title: String,
    body: String,
    detail: String?,
    onDismiss: () -> Unit,
    kind: String = "account_update",
    until: String? = null,
    supportUrl: String? = null,
) {
    val colors = neuColors
    val uriHandler = LocalUriHandler.current
    val suspension = kind == "account_suspended"
    val deadline = until?.let { runCatching { Instant.parse(it) }.getOrNull() }
    // Older event snapshots included the expiry in their first paragraph.
    val explanation = if (deadline != null && detail?.startsWith("Suspended until ") == true) {
        detail.substringAfter("\n\n", "")
    } else detail
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = colors.surface,
        contentColor = colors.textPrimary,
    ) {
        Column(
            Modifier.verticalScroll(rememberScrollState()).padding(horizontal = 20.dp).padding(bottom = 28.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                SystemNoticeIcon(kind, size = 44.dp)
                Text(title, style = MaterialTheme.typography.headlineSmall, modifier = Modifier.weight(1f))
                NeuIconButton(Icons.Rounded.Close, "Close", onDismiss, size = 40.dp)
            }
            NeuSurface(Modifier.fillMaxWidth(), state = NeuState.Pressed, elevation = 3.dp) {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (suspension) Text("Reason", style = MaterialTheme.typography.labelMedium, color = colors.danger)
                    SelectionContainer {
                        Text(body, style = MaterialTheme.typography.bodyLarge, color = colors.textPrimary)
                    }
                }
            }
            if (deadline != null) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Rounded.Schedule, contentDescription = null, tint = colors.accent, modifier = Modifier.size(22.dp))
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(
                            if (deadline.isAfter(Instant.now())) "Scheduled to end" else "Ended",
                            style = MaterialTheme.typography.labelMedium, color = colors.textTertiary,
                        )
                        Text(
                            DateTimeFormatter.ofPattern("d MMM yyyy · h:mm a z", Locale.getDefault())
                                .withZone(ZoneId.systemDefault()).format(deadline),
                            style = MaterialTheme.typography.labelLarge, color = colors.textPrimary,
                        )
                    }
                }
            }
            if (!explanation.isNullOrBlank()) SelectionContainer {
                Text(explanation, style = MaterialTheme.typography.bodyMedium, color = colors.textSecondary)
            }
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                if (suspension) NeuButton(
                    onClick = { uriHandler.openUri(SupportLinks.url(appeal = true, source = supportUrl)) },
                    modifier = Modifier.fillMaxWidth(), accent = true,
                ) {
                    Text("Appeal suspension", style = MaterialTheme.typography.labelLarge, color = colors.onAccent)
                }
                NeuButton(onClick = onDismiss, modifier = Modifier.fillMaxWidth(), accent = !suspension) {
                    Text("Got it", style = MaterialTheme.typography.labelLarge, color = if (suspension) colors.textPrimary else colors.onAccent)
                }
            }
        }
    }
}
