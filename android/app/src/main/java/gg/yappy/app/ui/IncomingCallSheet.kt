package gg.yappy.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectVerticalDragGestures
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
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Call
import androidx.compose.material.icons.rounded.CallEnd
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import gg.yappy.app.data.IncomingCall
import gg.yappy.app.ui.components.Avatar
import gg.yappy.app.ui.components.NeuIconButton
import gg.yappy.app.ui.components.NeuSurface
import gg.yappy.app.ui.theme.Neu
import gg.yappy.app.ui.theme.NeuState
import gg.yappy.app.ui.theme.neuColors
import kotlinx.coroutines.launch

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

    // Back does nothing while it rings. The sheet sits over the whole stack,
    // so a Back that fell through would pop whatever chat is underneath — an
    // invisible navigation the caller never sees and the callee never meant.
    // A ring is answered or declined; those are the two buttons.
    BackHandler { }

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

/** Past this much upward drag the banner is gone rather than snapping back. */
private const val BANNER_DISMISS_PX = 48f

/**
 * The banner itself: a floating card at the top, shaped like the app rather
 * than like the system's — this is yappy speaking inside its own walls.
 *
 * A raised card, not a tinted row: `surfaceRaised` equals the sheet in the
 * light theme, so the old flat fill was invisible there — the banner read as
 * text floating over the header. Elevation is the only thing that can lift
 * something off a single-surface sheet, and 8dp is one notch above a card at
 * rest because this one is *arriving*.
 *
 * It behaves like the system's heads-up: a nudge when it lands, and a flick
 * upward puts it away without opening anything.
 *
 * @param onDismiss The card was swiped away. Optional so the existing caller
 *   keeps compiling; without it the swipe still slides the card off screen and
 *   the caller's own timer removes it.
 */
@Composable
fun InAppBannerView(
    banner: InAppBanner,
    onDismiss: (() -> Unit)? = null,
    onTap: () -> Unit,
) {
    val colors = neuColors
    val haptics = LocalHapticFeedback.current
    val scope = rememberCoroutineScope()

    // A heads-up should be felt as well as seen: the phone is in a hand that
    // is looking at something else. Once per message, not per recomposition.
    LaunchedEffect(banner.id) {
        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
    }

    // Upward drag, in pixels; never positive — pulling a banner *down* is not
    // a gesture that means anything here.
    val drag = remember { Animatable(0f) }

    NeuSurface(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 6.dp)
            .offset { androidx.compose.ui.unit.IntOffset(0, drag.value.toInt()) }
            .graphicsLayer {
                // Fades as it goes, so a half-flick previews the outcome.
                alpha = 1f - (-drag.value / (BANNER_DISMISS_PX * 3f)).coerceIn(0f, 0.6f)
            }
            .pointerInput(banner.id) {
                detectVerticalDragGestures(
                    onDragEnd = {
                        if (drag.value <= -BANNER_DISMISS_PX) {
                            scope.launch {
                                // Off the top, then tell the caller. In the
                                // other order the card blinks out mid-flick.
                                drag.animateTo(-size.height * 1.5f, tween(160))
                                onDismiss?.invoke()
                            }
                        } else {
                            scope.launch { drag.animateTo(0f, spring(dampingRatio = 0.7f, stiffness = 900f)) }
                        }
                    },
                    onDragCancel = {
                        scope.launch { drag.animateTo(0f, spring(dampingRatio = 0.7f, stiffness = 900f)) }
                    },
                ) { change, dy ->
                    change.consume()
                    scope.launch { drag.snapTo((drag.value + dy).coerceAtMost(0f)) }
                }
            }
            .semantics(mergeDescendants = true) {
                role = Role.Button
                // Announced when it lands, without stealing focus from where
                // the reader was: that is what "polite" means.
                liveRegion = LiveRegionMode.Polite
            },
        shape = RoundedCornerShape(Neu.CornerMedium),
        state = NeuState.Raised,
        elevation = 8.dp,
        contentPadding = 0.dp,
        onClick = onTap,
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 14.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Avatar(banner.avatarUrl, banner.title, banner.avatarSeed, size = 40.dp, shape = CircleShape)
            Spacer(Modifier.size(12.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    banner.title,
                    style = MaterialTheme.typography.titleSmall,
                    color = colors.textPrimary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    banner.body,
                    style = MaterialTheme.typography.bodyMedium,
                    color = colors.textSecondary,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}
