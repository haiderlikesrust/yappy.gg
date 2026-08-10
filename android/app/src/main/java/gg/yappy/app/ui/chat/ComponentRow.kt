package gg.yappy.app.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
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
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                row.components.forEach { button ->
                    // A button addressed to someone else is shown, not hidden:
                    // seeing that a prompt exists but is not yours is clearer
                    // than a card whose buttons vanished.
                    val forSomeoneElse = button.onlyUserId != null && button.onlyUserId != myUserId
                    val busy = pressing == button.customId
                    val enabled = !button.disabled && !forSomeoneElse && pressing == null

                    val fill = when {
                        button.disabled || forSomeoneElse -> colors.veil
                        // Palette tokens, not the hexes they happened to equal:
                        // each theme owns its own green and red.
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
                        Modifier
                            .weight(1f)
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
                            // Two lines, then ellipsis. A bot chooses its own
                            // labels and cannot know how wide two-up buttons
                            // are on a given phone; silently clipping mid-word
                            // turns "Only people I follow" into "Only people
                            // I", which reads as a different answer.
                            Text(
                                button.label,
                                style = MaterialTheme.typography.labelLarge.copy(
                                    fontWeight = FontWeight.SemiBold,
                                ),
                                color = label,
                                textAlign = TextAlign.Center,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                }
            }
        }
    }
}
