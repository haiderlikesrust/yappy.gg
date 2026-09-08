package gg.yappy.app.ui.components

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.VolumeOff
import androidx.compose.material.icons.automirrored.rounded.VolumeUp
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Mic
import androidx.compose.material.icons.rounded.MicOff
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
import androidx.compose.runtime.collectAsState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import gg.yappy.app.LocalContainer
import gg.yappy.app.data.MediaState
import gg.yappy.app.ui.theme.neuColors
import kotlinx.coroutines.launch

/**
 * You are in a voice channel, wherever you have wandered off to.
 *
 * The bar used to live inside the space screen, which is the one place you do
 * not need to be told: a session you can see the channel list of is a session
 * you already know about. Walk into a chat and every trace of it was gone —
 * no indication the microphone was open, and no way back short of
 * remembering which space it was. Voice is the feature you are meant to leave
 * running while you do something else, so its bar belongs where the something
 * else happens.
 *
 * In the shell beside the connection strip rather than drawn per screen: one
 * instance, above everything, pushing the content down instead of floating
 * over it — a session is a state the whole app is in, not an overlay on the
 * screen that happens to be up.
 */
@Composable
fun VoiceBar(onOpenSpace: (String) -> Unit) {
    val container = LocalContainer.current
    val colors = neuColors
    val scope = rememberCoroutineScope()

    val session by container.voiceChannels.session.collectAsState()
    val media by container.voiceChannels.media.collectAsState()
    val speakerOn by container.voiceChannels.speakerOn.collectAsState()

    AnimatedVisibility(
        visible = session != null,
        enter = expandVertically() + fadeIn(),
        exit = shrinkVertically() + fadeOut(),
    ) {
        // Held through the exit animation, so leaving does not blank the text
        // for the 200ms the bar spends collapsing.
        var last by remember { mutableStateOf(session) }
        LaunchedEffect(session) { if (session != null) last = session }
        val shown = session ?: last ?: return@AnimatedVisibility

        val failed = media.state == MediaState.Failed
        Row(
            Modifier
                .fillMaxWidth()
                // The connection strip's colour is the app's; this one is the
                // state's — green for a live microphone, and the danger tint
                // when the room has dropped out from under it.
                .background(if (failed) colors.danger.copy(alpha = 0.16f) else colors.accentSoft)
                .softClickable { onOpenSpace(shown.spaceId) }
                .padding(horizontal = 14.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                if (shown.muted) Icons.Rounded.MicOff else Icons.Rounded.Mic,
                null,
                tint = if (failed) colors.danger else colors.success,
                modifier = Modifier.size(17.dp),
            )
            Spacer(Modifier.width(10.dp))
            Text(
                buildString {
                    append(shown.title)
                    when {
                        failed -> append(" · connection failed")
                        media.state == MediaState.Connecting -> append(" · connecting…")
                        media.state == MediaState.Reconnecting -> append(" · reconnecting…")
                        shown.muted -> append(" · muted")
                    }
                },
                style = MaterialTheme.typography.labelLarge,
                color = colors.textPrimary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .weight(1f)
                    // Announced when it changes rather than only when focused:
                    // dropping out of a room is something to be told, not
                    // something to go looking for.
                    .semantics { liveRegion = LiveRegionMode.Polite },
            )

            QuietIconButton(
                icon = if (speakerOn) Icons.AutoMirrored.Rounded.VolumeUp else Icons.AutoMirrored.Rounded.VolumeOff,
                label = if (speakerOn) "Earpiece" else "Speaker",
                onClick = { container.voiceChannels.setSpeaker(!speakerOn) },
            )

            QuietIconButton(
                icon = if (shown.muted) Icons.Rounded.MicOff else Icons.Rounded.Mic,
                label = if (shown.muted) "Unmute" else "Mute",
                onClick = { scope.launch { container.voiceChannels.setMuted(!shown.muted) } },
            )

            QuietIconButton(
                icon = Icons.Rounded.Close,
                label = "Leave voice",
                onClick = { scope.launch { container.voiceChannels.leave() } },
            )
        }
    }
}
