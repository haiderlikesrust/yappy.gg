package gg.yappy.app.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import gg.yappy.app.data.CatchUp
import gg.yappy.app.ui.components.Avatar
import gg.yappy.app.ui.theme.Neu
import gg.yappy.app.ui.theme.neuColors

/**
 * What happened while you were away, at the top of the chat.
 *
 * Deliberately not a summary of what was *said*. A generated paragraph about a
 * conversation is a guess that nobody in it can check, and being subtly wrong
 * about what your friends said is worse than saying nothing. Everything here is
 * a fact: how many, who, and what they posted.
 *
 * It answers one question — is there anything in here for me — and then gets
 * out of the way. Which is why it can be dismissed, and why it removes itself
 * once the reader reaches the bottom and has genuinely caught up.
 */
@Composable
fun CatchUpCard(
    catchUp: CatchUp,
    onDismiss: () -> Unit,
    onOpenMessage: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = neuColors

    Column(
        modifier
            .fillMaxWidth()
            .padding(horizontal = 14.dp, vertical = 8.dp)
            .clip(RoundedCornerShape(Neu.CornerMedium))
            .background(colors.veil)
            .padding(14.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(
                    "While you were away",
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                    color = colors.textPrimary,
                )
                Text(
                    buildString {
                        // "500+" rather than a number that is quietly a floor.
                        append(catchUp.newMessages)
                        if (catchUp.capped) append("+")
                        append(if (catchUp.newMessages == 1) " message" else " messages")
                        if (catchUp.participants.isNotEmpty()) {
                            append(" from ")
                            append(catchUp.participants.size)
                            append(if (catchUp.participants.size == 1) " person" else " people")
                        }
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.textTertiary,
                )
            }
            Icon(
                Icons.Rounded.Close,
                contentDescription = "Dismiss",
                tint = colors.textTertiary,
                modifier = Modifier
                    .size(20.dp)
                    .clickable(onClick = onDismiss),
            )
        }

        // Who was talking, loudest first — the server already ordered them.
        if (catchUp.participants.isNotEmpty()) {
            Spacer(Modifier.height(12.dp))
            LazyRow(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                items(catchUp.participants, key = { it.user.id }) { entry ->
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Avatar(
                            url = entry.user.avatarUrl,
                            name = entry.user.displayName ?: entry.user.username.orEmpty(),
                            id = entry.user.id,
                            size = 34.dp,
                        )
                        Spacer(Modifier.height(4.dp))
                        Text(
                            entry.count.toString(),
                            style = MaterialTheme.typography.labelSmall,
                            color = colors.textTertiary,
                        )
                    }
                }
            }
        }

        // Pictures, because "did I miss anything" usually means "did anybody
        // post anything I want to see".
        if (catchUp.media.isNotEmpty()) {
            Spacer(Modifier.height(12.dp))
            LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                items(catchUp.media, key = { it.id }) { picture ->
                    AsyncImage(
                        model = picture.thumbnailUrl ?: picture.url,
                        contentDescription = null,
                        contentScale = ContentScale.Crop,
                        modifier = Modifier
                            .size(58.dp)
                            .clip(RoundedCornerShape(10.dp))
                            .background(colors.surfaceRaised),
                    )
                }
            }
        }

        // Mentions last and loudest: of everything here, being named is the one
        // thing somebody actually has to act on.
        if (catchUp.mentions.isNotEmpty()) {
            Spacer(Modifier.height(12.dp))
            for (mention in catchUp.mentions.take(3)) {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .padding(vertical = 3.dp)
                        .clip(RoundedCornerShape(9.dp))
                        .clickable { onOpenMessage(mention.id) }
                        .background(colors.accent.copy(alpha = 0.10f))
                        .padding(horizontal = 9.dp, vertical = 7.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(
                        Modifier
                            .size(4.dp)
                            .clip(CircleShape)
                            .background(colors.accent),
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(
                        buildString {
                            append(mention.sender?.displayName ?: mention.sender?.username ?: "Someone")
                            append(" mentioned you")
                        },
                        style = MaterialTheme.typography.labelMedium,
                        color = colors.accent,
                        fontWeight = FontWeight.Medium,
                    )
                }
            }
        }
    }
}

