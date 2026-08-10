package gg.yappy.app.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import gg.yappy.app.data.MessageButton
import gg.yappy.app.data.MessageComponentRow
import gg.yappy.app.ui.components.softClickable
import gg.yappy.app.ui.theme.neuColors

/**
 * Buttons a bot attached to its message.
 *
 * Flat, like embeds and unlike the app's chrome: this is content, and giving
 * it the raised treatment used for real controls would blur the line between
 * "the app is offering this" and "someone in the conversation is". The colour
 * carries the affordance instead.
 *
 * A press is optimistic in appearance only — the row shows a spinner and stops
 * accepting input until the server answers, because the outcome (approving a
 * sign-in) is not something to guess at and then correct.
 */
@Composable
fun ComponentRows(
    rows: List<MessageComponentRow>,
    myUserId: String?,
    pressing: String?,
    onPress: (MessageButton) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = neuColors

    Column(modifier.widthIn(max = 300.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        rows.forEach { row ->
            /**
             * Side by side only when the labels genuinely fit.
             *
             * The row is capped at 300dp with equal-width cells, so a pair gets
             * about 122dp of text each and a trio about 72dp. A bot picks its
             * own labels and cannot know that, which is how "Only people I
             * follow" reached the screen as "Only people I" — not a truncated
             * answer but a different one.
             *
             * Deciding on the longest label rather than measuring keeps this
             * predictable and identical on both platforms. Stacking is not the
             * consolation prize either: a full-width button is the bigger tap
             * target, and the side-by-side form survives only because it reads
             * better when it actually fits.
             */
            val budget = if (row.components.size >= 3) 8 else 14
            val sideBySide = row.components.size > 1 && row.components.all { it.label.length <= budget }

            if (sideBySide) {
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    row.components.forEach { button ->
                        ActionButton(
                            button = button,
                            myUserId = myUserId,
                            pressing = pressing,
                            onPress = onPress,
                            modifier = Modifier.weight(1f),
                        )
                    }
                }
            } else {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    row.components.forEach { button ->
                        ActionButton(
                            button = button,
                            myUserId = myUserId,
                            pressing = pressing,
                            onPress = onPress,
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun ActionButton(
    button: MessageButton,
    myUserId: String?,
    pressing: String?,
    onPress: (MessageButton) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = neuColors

    // A button addressed to someone else is shown, not hidden: seeing that a
    // prompt exists but is not yours is clearer than a card whose buttons
    // vanished.
    val forSomeoneElse = button.onlyUserId != null && button.onlyUserId != myUserId
    val busy = pressing == button.customId
    val enabled = !button.disabled && !forSomeoneElse && pressing == null

    val fill = when {
        button.disabled || forSomeoneElse -> colors.veil
        // Palette tokens, not the hexes they happened to equal: each theme owns
        // its own green and red.
        button.style == "success" -> colors.success
        button.style == "danger" -> colors.danger
        button.style == "primary" -> colors.accent
        else -> colors.veil
    }
    val label = when {
        button.disabled || forSomeoneElse -> colors.textTertiary
        button.style == "secondary" -> colors.textPrimary
        else -> Color.White
    }

    Box(
        modifier
            .clip(RoundedCornerShape(10.dp))
            .background(fill)
            .then(if (enabled) Modifier.softClickable { onPress(button) } else Modifier)
            .padding(horizontal = 14.dp, vertical = 10.dp),
        contentAlignment = Alignment.Center,
    ) {
        if (busy) {
            CircularProgressIndicator(
                modifier = Modifier.size(16.dp),
                strokeWidth = 2.dp,
                color = label,
            )
        } else {
            // Two lines then ellipsis remains the last resort, but the layout
            // above should mean it is never reached: a label long enough to
            // wrap twice is exactly the case that now gets the full width.
            Text(
                button.label,
                style = MaterialTheme.typography.labelLarge.copy(fontWeight = FontWeight.SemiBold),
                color = label,
                textAlign = TextAlign.Center,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}
