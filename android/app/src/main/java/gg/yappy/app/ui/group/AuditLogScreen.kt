package gg.yappy.app.ui.group

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import gg.yappy.app.LocalContainer
import gg.yappy.app.data.AuditEntry
import gg.yappy.app.ui.components.Avatar
import gg.yappy.app.ui.components.NeuIconButton
import gg.yappy.app.ui.components.softClickable
import gg.yappy.app.ui.theme.Neu
import gg.yappy.app.ui.theme.neuColors
import gg.yappy.app.ui.util.relativeTime
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * Who changed what, newest first.
 *
 * A full screen rather than a sheet: a log is something you scroll and search
 * back through, and a sheet is for a glance. It reads
 * `GET /conversations/:id/audit` and composes the sentences here from
 * `action` + `metadata` — the server records facts, the client owns phrasing.
 * Metadata carries labels snapshotted at write time, so a renamed or deleted
 * role still reads as what it was called when the thing happened.
 */
@Composable
fun AuditLogScreen(conversationId: String, onBack: () -> Unit) {
    val container = LocalContainer.current
    val colors = neuColors
    val scope = rememberCoroutineScope()

    var entries by remember { mutableStateOf<List<AuditEntry>?>(null) }
    var cursor by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }

    LaunchedEffect(conversationId) {
        runCatching { container.repo.audit(conversationId) }
            .onSuccess {
                entries = it.entries
                cursor = it.nextCursor
            }
            .onFailure { entries = emptyList() }
    }

    Column(
        Modifier
            .fillMaxSize()
            .background(colors.surface)
            .statusBarsPadding(),
    ) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            NeuIconButton(Icons.AutoMirrored.Rounded.ArrowBack, "Back", onBack)
            Spacer(Modifier.width(12.dp))
            Text(
                "Audit log",
                style = MaterialTheme.typography.headlineSmall,
                color = colors.textPrimary,
            )
        }

        // The real bar height plus a design gap, so the "Older" foot clears
        // a 3-button bar instead of sitting under it.
        val navBottom = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
        when {
            entries == null -> Box(
                Modifier.fillMaxSize().navigationBarsPadding(),
                contentAlignment = Alignment.Center,
            ) {
                CircularProgressIndicator(color = colors.accent)
            }

            entries!!.isEmpty() -> Text(
                "Nothing yet. Admin actions — roles, channels, kicks, bans, invites — " +
                    "land here as they happen.",
                style = MaterialTheme.typography.bodyMedium,
                color = colors.textTertiary,
                modifier = Modifier.padding(24.dp),
            )

            else -> LazyColumn(
                Modifier.fillMaxSize(),
                contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 6.dp, bottom = navBottom + 24.dp),
            ) {
                items(entries!!, key = { it.id }) { entry ->
                    Row(
                        Modifier.fillMaxWidth().padding(vertical = 8.dp),
                        verticalAlignment = Alignment.Top,
                    ) {
                        Avatar(
                            url = null,
                            name = entry.actor?.displayName ?: entry.actor?.username,
                            id = entry.actor?.id ?: entry.id,
                            size = 28.dp,
                        )
                        Spacer(Modifier.width(10.dp))
                        Text(
                            buildAnnotatedString {
                                withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) {
                                    append(entry.actor?.displayName ?: entry.actor?.username ?: "someone")
                                }
                                append(" ")
                                append(auditSentence(entry))
                            },
                            style = MaterialTheme.typography.bodyMedium,
                            color = colors.textSecondary,
                            modifier = Modifier.weight(1f),
                        )
                        Spacer(Modifier.width(8.dp))
                        Text(
                            relativeTime(entry.createdAt),
                            style = MaterialTheme.typography.labelSmall,
                            color = colors.textTertiary,
                        )
                    }
                }
                cursor?.let {
                    item(key = "older") {
                        Text(
                            if (busy) "Loading…" else "Older",
                            style = MaterialTheme.typography.labelLarge,
                            color = colors.accent,
                            modifier = Modifier
                                .clip(RoundedCornerShape(Neu.CornerSmall))
                                .softClickable(enabled = !busy) {
                                    busy = true
                                    scope.launch {
                                        runCatching { container.repo.audit(conversationId, before = cursor) }
                                            .onSuccess { page ->
                                                entries = entries.orEmpty() + page.entries
                                                cursor = page.nextCursor
                                            }
                                        busy = false
                                    }
                                }
                                .padding(10.dp),
                        )
                    }
                }
            }
        }
    }
}

/** One entry, as a sentence. The actor's name is rendered separately. */
private fun auditSentence(entry: AuditEntry): String {
    val m = entry.metadata
    fun meta(key: String): String =
        (m?.get(key) as? JsonPrimitive)?.contentOrNull ?: ""
    fun metaList(key: String): List<String> =
        (m?.get(key) as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }.orEmpty()

    val target = entry.targetUser?.displayName ?: entry.targetUser?.username ?: "someone"
    return when (entry.action) {
        "role.create" -> "created the role ${meta("name")}"
        "role.update" ->
            if (meta("was").isNotEmpty() && meta("was") != meta("name")) {
                "renamed the role ${meta("was")} to ${meta("name")}"
            } else {
                "updated the role ${meta("name")}"
            }
        "role.delete" -> "deleted the role ${meta("name")}"
        "member.roles_set" -> {
            val roles = metaList("roles")
            if (roles.isEmpty()) "removed all of $target's roles"
            else "set $target's roles to ${roles.joinToString(", ")}"
        }
        "channel.create" -> "created #${meta("title")}"
        "channel.delete" -> "deleted #${meta("title")}"
        "channel.overwrite_set" -> "changed who can use #${meta("channel")} (${meta("role")})"
        "channel.overwrite_remove" -> "removed a role's access to #${meta("channel")}"
        "invite.create" ->
            if (meta("role").isEmpty()) "created an invite" else "created an invite that grants ${meta("role")}"
        "invite.revoke" -> "revoked an invite"
        "member.role_changed" -> "made $target a ${meta("role")}"
        "member.kicked" -> "removed $target"
        "member.banned" ->
            if (meta("reason").isEmpty()) "banned $target" else "banned $target — ${meta("reason")}"
        "member.unbanned" -> "unbanned $target"
        "member.muted" -> "muted $target"
        "member.unmuted" -> "unmuted $target"
        "conversation.update" -> {
            val where = meta("channel").takeIf { it.isNotEmpty() }?.let { " on #$it" } ?: ""
            "changed settings$where: ${metaList("changed").joinToString(", ").ifEmpty { "nothing" }}"
        }
        // A build older than the action that produced the row: name it rather
        // than hide it — an audit log that omits what it does not understand
        // is an audit log with holes.
        else -> entry.action
    }
}
