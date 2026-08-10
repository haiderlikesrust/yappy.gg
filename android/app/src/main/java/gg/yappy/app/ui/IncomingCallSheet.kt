package gg.yappy.app.ui

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
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
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Call
import androidx.compose.material.icons.rounded.CallEnd
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import gg.yappy.app.data.IncomingCall
import gg.yappy.app.ui.components.Avatar
import gg.yappy.app.ui.components.NeuIconButton
import gg.yappy.app.ui.components.softClickable
import gg.yappy.app.ui.theme.neuColors

/**
 * The ring, drawn in-app.
 *
 * [gg.yappy.app.data.CallCoordinator]'s notification is what rings a locked or
 * backgrounded phone — the OS owns that screen and it is the only thing that
 * works when the process is not running. This is the foreground case, where a
 * heads-up banner sliding over a chat is a much smaller thing than the call it
 * is announcing. Both resolve the same call, and answering either one stops the
 * other.
 */
@Composable
fun IncomingCallSheet(
    call: IncomingCall,
    onAnswer: () -> Unit,
    onDecline: () -> Unit,
) {
    val colors = neuColors

    // The avatar breathes while it rings. Motion is what distinguishes "this is
    // happening right now" from a card that merely says a call came in.
    val pulse by rememberInfiniteTransition(label = "ring").animateFloat(
        initialValue = 1f,
        targetValue = 1.08f,
        animationSpec = infiniteRepeatable(tween(900), RepeatMode.Reverse),
        label = "ring-pulse",
    )

    Box(Modifier.fillMaxSize().background(colors.surface)) {
        Column(
            Modifier.fillMaxSize().systemBarsPadding().padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.SpaceBetween,
        ) {
            Spacer(Modifier.height(1.dp))

            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Box(Modifier.scale(pulse)) {
                    Avatar(null, call.callerName, call.callId, size = 120.dp)
                }
                Spacer(Modifier.height(22.dp))
                Text(
                    call.callerName,
                    style = MaterialTheme.typography.headlineSmall,
                    color = colors.textPrimary,
                    textAlign = TextAlign.Center,
                )
                Spacer(Modifier.height(6.dp))
                Text(
                    if (call.video) "Incoming video call" else "Incoming voice call",
                    style = MaterialTheme.typography.bodyMedium,
                    color = colors.textTertiary,
                )
            }

            Row(
                Modifier.fillMaxWidth().padding(bottom = 32.dp),
                horizontalArrangement = Arrangement.SpaceEvenly,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                NeuIconButton(
                    Icons.Rounded.CallEnd,
                    "Decline",
                    onClick = onDecline,
                    fillColor = colors.danger,
                    tint = colors.onAccent,
                    size = 68.dp,
                    iconSize = 28.dp,
                )
                NeuIconButton(
                    Icons.Rounded.Call,
                    "Answer",
                    onClick = onAnswer,
                    fillColor = colors.success,
                    tint = colors.onAccent,
                    size = 68.dp,
                    iconSize = 28.dp,
                )
            }
        }
    }
}

/** One in-app notification's worth of information. */
data class InAppBanner(
    val id: String,
    val conversationId: String,
    val title: String,
    val body: String,
    val avatarUrl: String?,
    val avatarSeed: String,
)

/**
 * The banner itself: a floating card at the top, shaped like the app rather
 * than like the system's — this is yappy speaking inside its own walls.
 */
@Composable
fun InAppBannerView(banner: InAppBanner, onTap: () -> Unit) {
    val colors = neuColors

    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 6.dp)
            .clip(androidx.compose.foundation.shape.RoundedCornerShape(18.dp))
            .background(colors.surfaceRaised)
            .softClickable(onClick = onTap)
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Avatar(banner.avatarUrl, banner.title, banner.avatarSeed, size = 40.dp)
        Spacer(Modifier.size(12.dp))
        Column(Modifier.weight(1f)) {
            Text(
                banner.title,
                style = MaterialTheme.typography.titleSmall,
                color = colors.textPrimary,
                maxLines = 1,
            )
            Text(
                banner.body,
                style = MaterialTheme.typography.bodyMedium,
                color = colors.textSecondary,
                maxLines = 2,
            )
        }
    }
}
