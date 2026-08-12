package gg.yappy.app.ui.conversations

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Archive
import androidx.compose.material.icons.rounded.PushPin
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
 * Drag a conversation right to pin it, left to archive it.
 *
 * Same mechanics as the timeline's SwipeToReply, and deliberately so — pull,
 * feel the tick when it will fire, let go — because a gesture the thumb
 * already knows from one screen should not behave differently on another.
 * Horizontal-only detection keeps it safe inside the scrolling list, and the
 * long-press menu keeps both actions, exactly as the message sheet kept Reply:
 * this is the shortcut, not the only route.
 *
 * Both directions snap back rather than staying dismissed. Pin visibly
 * reorders the row and archive removes it, so the row's own movement is the
 * confirmation — a hole where the row used to be would say less.
 */
@Composable
fun SwipeRow(
    pinned: Boolean,
    onPin: () -> Unit,
    onArchive: () -> Unit,
    content: @Composable () -> Unit,
) {
    val colors = neuColors
    val haptics = LocalHapticFeedback.current
    val density = LocalDensity.current

    val trigger = with(density) { 64.dp.toPx() }
    val limit = with(density) { 84.dp.toPx() }

    var offset by remember { mutableFloatStateOf(0f) }
    var armed by remember { mutableStateOf(false) }

    val slide by animateFloatAsState(offset, spring(dampingRatio = 0.8f), label = "row-swipe")

    Box {
        val progress = min(abs(slide) / trigger, 1f)
        if (progress > 0.01f) {
            val rightward = slide > 0
            Box(
                Modifier
                    .align(if (rightward) Alignment.CenterStart else Alignment.CenterEnd)
                    .padding(horizontal = 18.dp)
                    .size(34.dp)
                    .scale(0.6f + 0.4f * progress)
                    .alpha(progress)
                    .clip(CircleShape)
                    .background(colors.veil),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    if (rightward) Icons.Rounded.PushPin else Icons.Rounded.Archive,
                    // The rightward action is a toggle and the icon cannot say
                    // which way it will go; the content description can.
                    contentDescription = if (rightward) {
                        if (pinned) "Unpin" else "Pin"
                    } else {
                        "Archive"
                    },
                    tint = if (abs(slide) >= trigger) colors.accent else colors.textTertiary,
                    modifier = Modifier.size(17.dp),
                )
            }
        }

        Box(
            Modifier
                .offset { IntOffset(slide.roundToInt(), 0) }
                .pointerInput(pinned) {
                    detectHorizontalDragGestures(
                        onDragEnd = {
                            if (armed) {
                                if (offset > 0) onPin() else onArchive()
                            }
                            armed = false
                            offset = 0f
                        },
                        onDragCancel = {
                            armed = false
                            offset = 0f
                        },
                    ) { _, delta ->
                        val next = offset + delta
                        // Resistance past the trigger in both directions.
                        offset = when {
                            abs(next) <= trigger -> next
                            next > 0 -> min(trigger + (next - trigger) * 0.3f, limit)
                            else -> -min(trigger + (-next - trigger) * 0.3f, limit)
                        }

                        if (abs(offset) >= trigger && !armed) {
                            armed = true
                            haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                        } else if (abs(offset) < trigger && armed) {
                            armed = false
                        }
                    }
                },
        ) {
            content()
        }
    }
}
