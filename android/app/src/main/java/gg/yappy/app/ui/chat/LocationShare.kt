package gg.yappy.app.ui.chat

import android.content.Intent
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.LocationOn
import androidx.compose.material.icons.rounded.Map
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import gg.yappy.app.data.LiveLocation
import gg.yappy.app.data.LocationPayload
import gg.yappy.app.ui.theme.neuColors
import gg.yappy.app.ui.components.NeuButton
import gg.yappy.app.ui.util.Locator
import gg.yappy.app.ui.util.clockTime
import java.time.Instant

/**
 * Choosing what to share.
 *
 * Two things, and the second is why this is a sheet rather than a button:
 * sending a pin is harmless and instant, while sharing live means agreeing to
 * be followed for a while. Those should not be one tap apart with no chance to
 * think about it.
 */
@Composable
fun LocationShareSheet(onShare: (Long?) -> Unit) {
    val colors = neuColors
    val context = LocalContext.current
    var granted by remember { mutableStateOf(Locator.granted(context)) }
    var working by remember { mutableStateOf(false) }

    val permission = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { result -> granted = result.values.any { it } }

    LaunchedEffect(Unit) {
        if (!granted) {
            permission.launch(
                arrayOf(
                    android.Manifest.permission.ACCESS_FINE_LOCATION,
                    android.Manifest.permission.ACCESS_COARSE_LOCATION,
                ),
            )
        }
    }

    Column(
        Modifier.fillMaxWidth().padding(22.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Text("Share location", style = MaterialTheme.typography.titleSmall, color = colors.textPrimary)

        if (!granted) {
            Text(
                "yappy needs permission to use your location.",
                style = MaterialTheme.typography.bodyMedium,
                color = colors.textSecondary,
            )
            NeuButton(onClick = {
                permission.launch(
                    arrayOf(
                        android.Manifest.permission.ACCESS_FINE_LOCATION,
                        android.Manifest.permission.ACCESS_COARSE_LOCATION,
                    ),
                )
            }) { Text("Allow location", style = MaterialTheme.typography.labelMedium) }
            return@Column
        }

        NeuButton(
            onClick = { if (!working) { working = true; onShare(null) } },
            modifier = Modifier.fillMaxWidth(),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Rounded.LocationOn, contentDescription = null, modifier = Modifier.size(18.dp))
                Text("  Send my current location", style = MaterialTheme.typography.labelMedium)
            }
        }

        Text("OR SHARE LIVE", style = MaterialTheme.typography.labelSmall, color = colors.textTertiary)
        Text(
            "Everyone here sees you move until it ends. You can stop at any time.",
            style = MaterialTheme.typography.labelSmall,
            color = colors.textTertiary,
        )

        // The same three the server allows, and the same reasoning: each is a
        // length somebody can hold in their head as "until roughly when".
        listOf("15 minutes" to 900L, "1 hour" to 3_600L, "8 hours" to 28_800L).forEach { (label, seconds) ->
            NeuButton(
                onClick = { if (!working) { working = true; onShare(seconds) } },
                modifier = Modifier.fillMaxWidth(),
            ) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Rounded.Map, contentDescription = null, modifier = Modifier.size(18.dp))
                    Text("  $label", style = MaterialTheme.typography.labelMedium)
                }
            }
        }
    }
}

/**
 * A shared place, in the timeline.
 *
 * No map drawn here, and that is a decision rather than a gap. Android has no
 * free map surface: the Google SDK needs an API key and Play Services, and
 * scraping somebody's public tile server is not something to ship. So the card
 * says what it knows and hands off to whichever maps app the phone already has
 * — which is where people end up anyway.
 */
@Composable
fun LocationCard(
    payload: LocationPayload,
    live: LiveLocation?,
    isMine: Boolean,
    onStop: () -> Unit,
) {
    val colors = neuColors
    val context = LocalContext.current

    val latitude = live?.latitude ?: payload.latitude
    val longitude = live?.longitude ?: payload.longitude

    /** Still moving: not ended, and not past its end time. */
    val isLive = live != null && live.endedAt == null &&
        runCatching { Instant.parse(live.expiresAt).isAfter(Instant.now()) }.getOrDefault(false)

    Column(
        Modifier
            .width(240.dp)
            .clip(RoundedCornerShape(18.dp))
            .background(colors.veil)
            .clickable {
                // `geo:` with a label, so the pin lands named rather than as a
                // bare coordinate somebody has to squint at.
                val label = Uri.encode(payload.name ?: "Shared location")
                val uri = Uri.parse("geo:$latitude,$longitude?q=$latitude,$longitude($label)")
                runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, uri)) }
            }
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier
                    .size(34.dp)
                    .clip(CircleShape)
                    .background(if (isLive) colors.success.copy(alpha = 0.18f) else colors.accent.copy(alpha = 0.18f)),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    Icons.Rounded.LocationOn,
                    contentDescription = null,
                    tint = if (isLive) colors.success else colors.accent,
                    modifier = Modifier.size(19.dp),
                )
            }
            Column(Modifier.padding(start = 10.dp)) {
                Text(
                    payload.name?.takeIf { it.isNotBlank() } ?: "Location",
                    style = MaterialTheme.typography.labelMedium,
                    color = colors.textPrimary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    // Five decimals is about a metre. More is noise, and fewer
                    // puts you on the wrong side of the street.
                    "%.5f, %.5f".format(latitude, longitude),
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.textTertiary,
                    maxLines = 1,
                )
            }
        }

        when {
            isLive && live != null -> {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(7.dp).clip(CircleShape).background(colors.success))
                    Text(
                        "  Live until ${clockTime(live.expiresAt)}",
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.success,
                    )
                }
                if (isMine) {
                    Text(
                        "Stop sharing",
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.danger,
                        modifier = Modifier.clickable(onClick = onStop),
                    )
                }
            }
            // A share that has finished. Saying so is what stops the last known
            // point being read as where somebody is now.
            payload.liveUntil != null -> Text(
                "Live location ended",
                style = MaterialTheme.typography.labelSmall,
                color = colors.textTertiary,
            )
            else -> Text("Tap to open in Maps", style = MaterialTheme.typography.labelSmall, color = colors.textTertiary)
        }
    }
}
