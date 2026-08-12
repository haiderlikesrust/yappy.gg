package gg.yappy.app.ui.chat

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import gg.yappy.app.LocalContainer
import gg.yappy.app.data.DeepLink
import gg.yappy.app.data.EmbedInvite
import gg.yappy.app.ui.components.Avatar
import gg.yappy.app.ui.components.NeuButton
import gg.yappy.app.ui.components.NeuSurface
import gg.yappy.app.ui.theme.Neu
import gg.yappy.app.ui.theme.PlaceShape
import gg.yappy.app.ui.theme.neuColors

/**
 * An invite link, drawn as the group it opens.
 *
 * What this replaces was the app reading its own website: the link went out
 * through the generic unfurler, which fetched yappy.gg as an anonymous
 * stranger and got back the only thing that page tells strangers — "Join a
 * group on yappy. You have been invited to a group on yappy." Two sentences
 * that name neither the group nor anybody in it, on a card whose only action
 * was to leave for a browser.
 *
 * The server resolves the code against the database now, so the card knows
 * which group, how many people are in it, and what it looks like. Joining
 * happens in the app: the button hands the code to the same pending-link path
 * a tapped invite uses, which opens the sheet that already knows how to join
 * and where to navigate afterwards. Nobody should have to visit a website to
 * accept an invitation to the app they are holding.
 */
@Composable
fun InviteEmbedCard(invite: EmbedInvite, modifier: Modifier = Modifier) {
    val container = LocalContainer.current
    val colors = neuColors

    val kind = when (invite.type) {
        "space" -> "Space"
        "channel" -> "Channel"
        else -> "Group"
    }
    val name = invite.title?.takeIf { it.isNotBlank() } ?: "A group on yappy"

    NeuSurface(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(Neu.CornerMedium),
        contentPadding = 14.dp,
    ) {
        Column {
            Text(
                "YOU HAVE BEEN INVITED TO JOIN",
                style = MaterialTheme.typography.labelSmall,
                color = colors.textTertiary,
                letterSpacing = 0.8.sp,
            )
            Spacer(Modifier.height(10.dp))

            Row(verticalAlignment = Alignment.CenterVertically) {
                // A squircle, not a circle. The rule the whole app follows:
                // circles are people, squircles are places, and an invite is
                // always to a place.
                Avatar(
                    url = invite.avatarUrl,
                    name = name,
                    id = invite.code,
                    size = 46.dp,
                    shape = PlaceShape,
                )
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text(
                        name,
                        style = MaterialTheme.typography.titleSmall,
                        color = colors.textPrimary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        "$kind · ${invite.memberCount} ${if (invite.memberCount == 1) "member" else "members"}",
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.textTertiary,
                    )
                }
            }

            invite.description?.takeIf { it.isNotBlank() }?.let {
                Spacer(Modifier.height(10.dp))
                Text(
                    it,
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.textSecondary,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }

            Spacer(Modifier.height(12.dp))
            NeuButton(
                onClick = { container.offerLink(DeepLink.Invite(invite.code)) },
                accent = true,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(
                    "Join",
                    style = MaterialTheme.typography.labelLarge,
                    color = colors.onAccent,
                )
            }
        }
    }
}
