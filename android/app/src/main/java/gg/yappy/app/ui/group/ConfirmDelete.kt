package gg.yappy.app.ui.group

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Delete
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import gg.yappy.app.ui.components.NeuIconButton
import gg.yappy.app.ui.theme.neuColors
import kotlinx.coroutines.delay

/**
 * A delete that asks once.
 *
 * Roles, webhooks and invite links used to go on a single tap of an 11sp
 * "remove" — a target smaller than a fingertip, for an action with no undo.
 * This is the same two-tap the Convert-to-space button uses: the first tap
 * arms it (the disc fills danger red and ticks), the second does it, and a
 * few seconds of silence disarm it, because the first tap is more often
 * curiosity than intent.
 *
 * Quiet at rest on purpose: a red bin on every row would make a settings
 * card read as a list of threats.
 */
@Composable
fun ConfirmDeleteButton(
    /** What the second tap does, as a verb phrase: "remove this role". */
    action: String,
    onConfirmed: () -> Unit,
    modifier: Modifier = Modifier,
    size: Dp = 46.dp,
    enabled: Boolean = true,
) {
    val colors = neuColors
    val haptics = LocalHapticFeedback.current
    // Saveable so a rotation mid-confirm does not silently disarm — the
    // second tap after it would then re-arm instead of deleting.
    var armed by rememberSaveable { mutableStateOf(false) }
    LaunchedEffect(armed) {
        if (armed) {
            delay(3_000)
            armed = false
        }
    }
    NeuIconButton(
        icon = Icons.Rounded.Delete,
        contentDescription = if (armed) "Tap again to $action" else action.replaceFirstChar { it.uppercase() },
        onClick = {
            if (!armed) {
                armed = true
                haptics.performHapticFeedback(HapticFeedbackType.LongPress)
            } else {
                armed = false
                onConfirmed()
            }
        },
        modifier = modifier,
        size = size,
        iconSize = (size.value * 0.42f).dp,
        tint = if (armed) colors.onAccent else colors.textTertiary,
        fillColor = if (armed) colors.danger else null,
        enabled = enabled,
    )
}
