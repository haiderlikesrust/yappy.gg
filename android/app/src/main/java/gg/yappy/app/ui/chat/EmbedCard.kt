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
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
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
 */
@Composable
fun EmbedCard(embed: Embed, onOpenUrl: (String) -> Unit, modifier: Modifier = Modifier) {
    val colors = neuColors
    val accent = flairColor(embed.color) ?: colors.accent

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
