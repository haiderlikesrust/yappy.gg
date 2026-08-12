package gg.yappy.app.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Campaign
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import gg.yappy.app.data.Embed
import gg.yappy.app.ui.components.flairColor
import gg.yappy.app.ui.components.softClickable
import gg.yappy.app.ui.theme.neuColors

/**
 * A rich card, Discord-shaped.
 *
 * Flat, like every other piece of *content* in this app — the accent bar down
 * the left edge does the work a shadow would do elsewhere, and it is the one
 * place an author-chosen colour is allowed to land.
 *
 * Deliberately not clickable as a whole: a card whose every pixel is a link is
 * how people get phished. Only the title opens the URL.
 *
 * @param trusted whether the *sender* is a badged first-party bot.
 *
 *   The gate on [Embed.kind], and it is not paranoia for its own sake. `kind`
 *   changes how the card is treated, not merely how it looks: an announcement
 *   drops the eight-line cap, and that cap is what stops an untrusted bot
 *   filling somebody's screen. Rendering on the field alone would let any app
 *   author mint something that looks like a notice from us. The server already
 *   strips `kind` from non-badged senders; this is the second, independent
 *   check, so a bug in either one is not enough on its own.
 */
@Composable
fun EmbedCard(
    embed: Embed,
    onOpenUrl: (String) -> Unit,
    modifier: Modifier = Modifier,
    trusted: Boolean = false,
) {
    val colors = neuColors
    val accent = flairColor(embed.color) ?: colors.accent
    val announcement = trusted && embed.kind == "announcement"

    if (announcement) {
        AnnouncementCard(embed, accent, modifier)
        return
    }

    Row(
        modifier
            .widthIn(max = 300.dp)
            // Intrinsic min height lets the accent bar match the content's
            // height; without it `fillMaxHeight` inside a Row has nothing to
            // measure against and the bar collapses.
            .height(IntrinsicSize.Min)
            .clip(RoundedCornerShape(12.dp))
            .background(colors.incoming),
    ) {
        Box(Modifier.width(4.dp).fillMaxHeight().background(accent))
        Column(Modifier.padding(horizontal = 12.dp, vertical = 10.dp)) {

            embed.author?.let { author ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    author.iconUrl?.let {
                        AsyncImage(
                            model = it,
                            contentDescription = null,
                            modifier = Modifier.size(18.dp).clip(CircleShape),
                        )
                        Spacer(Modifier.width(6.dp))
                    }
                    Text(
                        author.name,
                        style = MaterialTheme.typography.labelMedium,
                        color = colors.textSecondary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                Spacer(Modifier.height(4.dp))
            }

            embed.provider?.takeIf { embed.author == null }?.let {
                Text(it, style = MaterialTheme.typography.labelSmall, color = colors.textTertiary)
                Spacer(Modifier.height(3.dp))
            }

            embed.title?.let { title ->
                Text(
                    title,
                    style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.SemiBold),
                    color = if (embed.url != null) accent else colors.textPrimary,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    modifier = if (embed.url != null) {
                        Modifier.softClickable { onOpenUrl(embed.url) }
                    } else {
                        Modifier
                    },
                )
                Spacer(Modifier.height(4.dp))
            }

            embed.description?.let {
                Text(
                    it,
                    style = MaterialTheme.typography.bodyMedium,
                    color = colors.textSecondary,
                    maxLines = 8,
                    overflow = TextOverflow.Ellipsis,
                )
            }

            if (embed.fields.isNotEmpty()) {
                Spacer(Modifier.height(8.dp))
                // Inline fields sit two-up; block fields take the full width.
                // Chunking rather than a grid keeps the order authors expect.
                val rows = mutableListOf<List<gg.yappy.app.data.EmbedField>>()
                var run = mutableListOf<gg.yappy.app.data.EmbedField>()
                for (field in embed.fields) {
                    if (field.inline) {
                        run.add(field)
                        if (run.size == 2) { rows.add(run); run = mutableListOf() }
                    } else {
                        if (run.isNotEmpty()) { rows.add(run); run = mutableListOf() }
                        rows.add(listOf(field))
                    }
                }
                if (run.isNotEmpty()) rows.add(run)

                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    rows.forEach { rowFields ->
                        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            rowFields.forEach { field ->
                                Column(Modifier.weight(1f)) {
                                    Text(
                                        field.name,
                                        style = MaterialTheme.typography.labelSmall.copy(
                                            fontWeight = FontWeight.SemiBold,
                                        ),
                                        color = colors.textPrimary,
                                    )
                                    Text(
                                        field.value,
                                        style = MaterialTheme.typography.bodyMedium,
                                        color = colors.textSecondary,
                                    )
                                }
                            }
                            if (rowFields.size == 1 && rowFields[0].inline) {
                                Spacer(Modifier.weight(1f))
                            }
                        }
                    }
                }
            }

            embed.image?.let {
                Spacer(Modifier.height(8.dp))
                AsyncImage(
                    model = it.url,
                    contentDescription = embed.title,
                    contentScale = ContentScale.Crop,
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(150.dp)
                        .clip(RoundedCornerShape(8.dp)),
                )
            }

            embed.footer?.let { footer ->
                Spacer(Modifier.height(8.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    footer.iconUrl?.let {
                        AsyncImage(
                            model = it,
                            contentDescription = null,
                            modifier = Modifier.size(14.dp).clip(CircleShape),
                        )
                        Spacer(Modifier.width(5.dp))
                    }
                    Text(
                        footer.text,
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.textTertiary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}

/**
 * A staff announcement.
 *
 * Reads as a notice rather than a bot card, and the differences are deliberate
 * rather than decorative:
 *
 *  - **A header band instead of a 4dp left bar.** The bar is the visual grammar
 *    of "some bot said something". This is the app talking, and it should not
 *    be scannable past.
 *  - **No line cap on the body.** The eight-line cap exists to stop an
 *    untrusted bot filling the screen; a staff notice is not untrusted, and
 *    truncating the one message everybody is meant to read was the bug that
 *    started this. Only reachable when [EmbedCard.trusted] is true.
 *  - **A timestamp.** "Posted 2:37 AM" is what a service notice wants, and it
 *    beats a hand-typed date in the footer that nobody remembers to update.
 */
@Composable
private fun AnnouncementCard(embed: Embed, accent: Color, modifier: Modifier = Modifier) {
    val colors = neuColors

    Column(
        modifier
            .widthIn(max = 320.dp)
            .clip(RoundedCornerShape(14.dp))
            .background(colors.incoming),
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .background(accent.copy(alpha = 0.16f))
                .padding(horizontal = 12.dp, vertical = 7.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // The same megaphone the space screen uses for announcement
            // channels — one symbol for one concept. An icon over the emoji
            // because it takes the accent tint; the emoji drew itself in its
            // own colours whatever the card's accent said.
            Icon(
                Icons.Rounded.Campaign,
                contentDescription = null,
                tint = accent,
                modifier = Modifier.size(16.dp),
            )
            Spacer(Modifier.width(7.dp))
            Text(
                embed.author?.name ?: "Announcement",
                style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.SemiBold),
                color = accent,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Spacer(Modifier.weight(1f))
            embed.timestamp?.let {
                Text(
                    shortTime(it),
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.textTertiary,
                    maxLines = 1,
                )
            }
        }

        Column(Modifier.padding(horizontal = 14.dp, vertical = 12.dp)) {
            embed.title?.let {
                Text(
                    it,
                    style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.SemiBold),
                    color = colors.textPrimary,
                )
                Spacer(Modifier.height(6.dp))
            }

            embed.description?.let {
                // No maxLines. See the note above: this is the whole point.
                Text(
                    it,
                    style = MaterialTheme.typography.bodyMedium,
                    color = colors.textSecondary,
                )
            }

            embed.footer?.let {
                Spacer(Modifier.height(10.dp))
                Text(
                    it.text,
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.textTertiary,
                )
            }
        }
    }
}

/** "2:37 AM" from an ISO timestamp, or nothing if it will not parse. */
private fun shortTime(iso: String): String =
    runCatching {
        java.time.format.DateTimeFormatter
            .ofPattern("h:mm a")
            .withZone(java.time.ZoneId.systemDefault())
            .format(java.time.Instant.parse(iso))
    }.getOrDefault("")
