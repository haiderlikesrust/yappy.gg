package gg.yappy.app.ui.profile

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.background
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.draw.clip
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.Message
import androidx.compose.material.icons.rounded.Block
import androidx.compose.material.icons.rounded.Call
import androidx.compose.material.icons.rounded.Flag
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
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
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import gg.yappy.app.LocalContainer
import gg.yappy.app.data.FullUser
import gg.yappy.app.ui.components.AffiliateMark
import gg.yappy.app.ui.components.Avatar
import gg.yappy.app.ui.components.BadgeMark
import gg.yappy.app.ui.components.badgeDescription
import gg.yappy.app.ui.components.NeuIconButton
import gg.yappy.app.ui.components.NeuSurface
import gg.yappy.app.ui.components.PresenceDot
import gg.yappy.app.ui.components.softClickable
import gg.yappy.app.ui.theme.Neu
import gg.yappy.app.ui.theme.neuColors
import gg.yappy.app.ui.util.relativeTime
import kotlinx.coroutines.launch

@Composable
fun ProfileScreen(userId: String, onBack: () -> Unit, onOpenChat: (String) -> Unit) {
    val container = LocalContainer.current
    val colors = neuColors
    val scope = rememberCoroutineScope()

    var user by remember { mutableStateOf<FullUser?>(null) }
    var busy by remember { mutableStateOf(false) }
    var blocked by remember { mutableStateOf(false) }

    LaunchedEffect(userId) {
        user = runCatching { container.repo.user(userId).user }.getOrNull()
    }

    Column(
        Modifier
            .fillMaxSize()
            .statusBarsPadding()
            .verticalScroll(rememberScrollState()),
    ) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp)) {
            NeuIconButton(Icons.AutoMirrored.Rounded.ArrowBack, "Back", onBack, size = 42.dp, iconSize = 19.dp)
        }

        if (user == null) {
            Box(Modifier.fillMaxSize().height(300.dp), Alignment.Center) {
                CircularProgressIndicator(color = colors.accent)
            }
            return@Column
        }

        val u = user!!

        Column(
            Modifier.fillMaxWidth().padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Avatar(u.avatarUrl, u.displayName, u.id, size = 112.dp)
            Spacer(Modifier.height(16.dp))

            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    u.displayName ?: "Someone",
                    style = MaterialTheme.typography.headlineMedium,
                    color = colors.textPrimary,
                )
                if (u.badge != null) {
                    Spacer(Modifier.width(8.dp))
                    BadgeMark(u.badge, size = 20.dp)
                }
            }
            u.username?.let {
                Text("@$it", style = MaterialTheme.typography.bodyLarge, color = colors.textTertiary)
            }

            // The profile is the one place with room to say what a mark means,
            // so it does — in words, not a second glyph.
            badgeDescription(u.badge)?.let {
                Spacer(Modifier.height(10.dp))
                Row(
                    Modifier
                        .clip(RoundedCornerShape(Neu.CornerPill))
                        .background(colors.accentSoft)
                        .padding(horizontal = 12.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    BadgeMark(u.badge, size = 14.dp)
                    Spacer(Modifier.width(7.dp))
                    Text(it, style = MaterialTheme.typography.labelMedium, color = colors.accent)
                }
            }

            u.affiliation?.let { af ->
                Spacer(Modifier.height(10.dp))
                Row(
                    Modifier
                        .clip(RoundedCornerShape(Neu.CornerPill))
                        .background(colors.accentSoft.copy(alpha = 0.6f))
                        .padding(horizontal = 10.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    AffiliateMark(af, size = 18.dp)
                    Spacer(Modifier.width(8.dp))
                    Text(
                        "Affiliated with ${af.title ?: "a group"}",
                        style = MaterialTheme.typography.labelMedium,
                        color = colors.textSecondary,
                    )
                }
            }

            Spacer(Modifier.height(8.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                PresenceDot(u.presence.status, size = 10.dp)
                Spacer(Modifier.width(6.dp))
                Text(
                    when {
                        u.presence.status == "online" -> "Online"
                        u.presence.lastSeenAt != null -> "Last seen ${relativeTime(u.presence.lastSeenAt)}"
                        // The backend suppresses both status and last-seen
                        // together when privacy forbids it, so there is nothing
                        // to show rather than a misleading "Offline".
                        else -> ""
                    },
                    style = MaterialTheme.typography.labelMedium,
                    color = colors.textTertiary,
                )
            }

            u.bio?.takeIf { it.isNotBlank() }?.let {
                Spacer(Modifier.height(14.dp))
                Text(
                    it,
                    style = MaterialTheme.typography.bodyLarge,
                    color = colors.textSecondary,
                    textAlign = TextAlign.Center,
                )
            }

            Spacer(Modifier.height(24.dp))

            Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                NeuIconButton(
                    Icons.AutoMirrored.Rounded.Message,
                    "Message",
                    onClick = {
                        busy = true
                        scope.launch {
                            runCatching { container.repo.createDm(u.id).conversation.id }
                                .onSuccess(onOpenChat)
                            busy = false
                        }
                    },
                    accent = true,
                    size = 56.dp,
                    iconSize = 23.dp,
                    enabled = !busy,
                )
                NeuIconButton(Icons.Rounded.Call, "Call", onClick = {}, size = 56.dp, iconSize = 23.dp)
            }
        }

        Spacer(Modifier.height(8.dp))

        NeuSurface(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp),
            shape = RoundedCornerShape(Neu.CornerMedium),
            contentPadding = 6.dp,
        ) {
            Column {
                ActionRow(
                    Icons.Rounded.Block,
                    if (blocked) "Unblock" else "Block",
                    danger = !blocked,
                ) {
                    scope.launch {
                        runCatching {
                            if (blocked) container.repo.unblock(u.id) else container.repo.block(u.id)
                        }.onSuccess { blocked = !blocked }
                    }
                }
                ActionRow(Icons.Rounded.Flag, "Report", danger = true) {
                    scope.launch {
                        runCatching { container.repo.report("user", u.id, "spam", null) }
                    }
                }
            }
        }

        Spacer(Modifier.height(40.dp))
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
            .softClickable(onClick = onClick)
            .padding(vertical = 14.dp, horizontal = 10.dp),
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
