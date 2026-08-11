package gg.yappy.app.ui.chat

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.Reply
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import gg.yappy.app.ui.theme.neuColors
import kotlin.math.abs
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Drag a message to the right to reply to it.
 *
 * iOS has had this since the timeline was built and Android only ever had the
 * long-press sheet, which is two taps and a decision for the single most common
 * thing anyone does with a message. The sheet keeps its Reply — this is the
 * shortcut, not the only route.
 *
 * It follows the convention everyone already has in their fingers: pull, feel
 * the tick when it will fire, let go.
 *
 * Horizontal only, which is what makes it safe inside a scrolling list.
 * `detectHorizontalDragGestures` claims a pointer once it has moved further
 * across than down, so a vertical drag reaches the timeline untouched and
 * scrolling wins ties — a list that occasionally swallows a scroll is far more
 * annoying than one that occasionally misses a swipe.
 */
@Composable
fun SwipeToReply(
    enabled: Boolean,
    onReply: () -> Unit,
    content: @Composable () -> Unit,
) {
    val colors = neuColors
    val haptics = LocalHapticFeedback.current
    val density = LocalDensity.current

    /** Far enough to be deliberate, close enough to reach with a thumb. */
    val trigger = with(density) { 56.dp.toPx() }
    val limit = with(density) { 76.dp.toPx() }

    var offset by remember { mutableFloatStateOf(0f) }
    /**
     * Past the point where letting go replies. Tracked so the tick fires once
     * on the way in rather than on every frame of the drag.
     */
    var armed by remember { mutableStateOf(false) }

    val slide by animateFloatAsState(offset, spring(dampingRatio = 0.8f), label = "swipe")

    Box(contentAlignment = Alignment.CenterStart) {
        // Behind the bubble, uncovered as it slides off — so the gesture
        // explains itself the first time rather than having to be discovered.
        val progress = min(slide / trigger, 1f)
        if (progress > 0.01f) {
            Box(
                Modifier
                    .size(32.dp)
                    .scale(0.6f + 0.4f * progress)
                    .alpha(progress)
                    .clip(CircleShape)
                    .background(colors.veil),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    Icons.AutoMirrored.Rounded.Reply,
                    contentDescription = null,
                    tint = if (slide >= trigger) colors.accent else colors.textTertiary,
                    modifier = Modifier.size(17.dp),
                )
            }
        }

        Box(
            Modifier
                .offset { IntOffset(slide.roundToInt(), 0) }
                .pointerInput(enabled) {
                    if (!enabled) return@pointerInput
                    detectHorizontalDragGestures(
                        onDragEnd = {
                            if (armed) onReply()
                            armed = false
                            offset = 0f
                        },
                        onDragCancel = {
                            armed = false
                            offset = 0f
                        },
                    ) { _, delta ->
                        val next = offset + delta
                        // Rightwards only. A left drag is not a reply, and
                        // letting the bubble follow it would suggest it is.
                        if (next <= 0f) {
                            offset = 0f
                            armed = false
                            return@detectHorizontalDragGestures
                        }

                        // Resistance past the trigger, so the bubble says it has
                        // gone as far as it usefully can.
                        offset = if (next <= trigger) {
                            next
                        } else {
                            min(trigger + (next - trigger) * 0.3f, limit)
                        }

                        if (offset >= trigger && !armed) {
                            armed = true
                            haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                        } else if (offset < trigger && armed) {
                            armed = false
                        }
                    }
                },
        ) {
            content()
        }
    }
}
