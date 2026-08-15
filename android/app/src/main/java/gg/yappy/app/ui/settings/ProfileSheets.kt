package gg.yappy.app.ui.settings

import android.content.Intent
import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Block
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import gg.yappy.app.LocalContainer
import gg.yappy.app.data.FullUser
import gg.yappy.app.ui.components.Avatar
import gg.yappy.app.ui.components.NeuButton
import gg.yappy.app.ui.components.NeuTextField
import gg.yappy.app.ui.components.SectionLabel
import gg.yappy.app.ui.components.softClickable
import gg.yappy.app.ui.theme.Neu
import gg.yappy.app.ui.theme.neuColors
import kotlinx.coroutines.launch

/**
 * Flair presets. A fixed palette rather than a colour wheel: every option here
 * is one the design language already speaks, so any choice looks like yappy —
 * and a bounded set makes the row a single glance instead of a project.
 */
private val FLAIR_PRESETS: List<List<String>> = listOf(
    listOf("#8B7CFF", "#00CEC9"),
    listOf("#FF9F43", "#FF6B81"),
    listOf("#00CEC9", "#6BCB77"),
    listOf("#FCCE09", "#FF9F43"),
    listOf("#FF6B81", "#8B7CFF"),
    listOf("#4FC3F7", "#8B7CFF"),
)

private fun parseHex(hex: String): Color? =
    runCatching { Color(android.graphics.Color.parseColor(hex)) }.getOrNull()

/** The two stops as Compose colours, or null when absent/garbled. */
fun flairColors(gradient: List<String>?): Pair<Color, Color>? {
    val stops = gradient?.mapNotNull(::parseHex) ?: return null
    if (stops.size < 2) return null
    return stops[0] to stops[1]
}

/**
 * Edit the things a profile says: name, pronouns, bio, flair.
 *
 * The preview at the top is not a decoration — it renders from the *staged*
 * values through the same layout the profile header uses, so what it shows is
 * what saving produces. The same promise the banner editor makes.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EditProfileSheet(me: FullUser, onDismiss: () -> Unit) {
    val container = LocalContainer.current
    val colors = neuColors
    val scope = rememberCoroutineScope()
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    var name by remember { mutableStateOf(me.displayName.orEmpty()) }
    var pronouns by remember { mutableStateOf(me.pronouns.orEmpty()) }
    var bio by remember { mutableStateOf(me.bio.orEmpty()) }
    var flair by remember { mutableStateOf(me.flair?.gradient) }
    var busy by remember { mutableStateOf(false) }
    var saved by remember { mutableStateOf(false) }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = colors.surface,
        contentColor = colors.textPrimary,
    ) {
        Column(
            Modifier
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp)
                .padding(bottom = 28.dp),
        ) {
            Text("Edit profile", style = MaterialTheme.typography.titleMedium, color = colors.textPrimary)
            Spacer(Modifier.height(14.dp))

            // ── Live preview ─────────────────────────────────────────────────
            val stops = flairColors(flair)
            val fallback = gg.yappy.app.ui.components.colorForId(me.id)
            Box(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(Neu.CornerMedium))
                    .background(
                        Brush.verticalGradient(
                            listOf(
                                (stops?.first ?: fallback).copy(alpha = 0.85f),
                                (stops?.second ?: fallback).copy(alpha = 0.25f),
                            ),
                        ),
                    )
                    .padding(16.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(
                        Modifier
                            .clip(CircleShape)
                            .background(colors.surface)
                            .padding(3.dp),
                    ) {
                        Avatar(me.avatarUrl, name.ifBlank { me.displayName }, me.id, size = 46.dp)
                    }
                    Spacer(Modifier.width(12.dp))
                    Column {
                        Text(
                            name.ifBlank { "Your name" },
                            style = MaterialTheme.typography.titleMedium,
                            color = colors.textPrimary,
                        )
                        Text(
                            listOfNotNull(
                                me.username?.let { "@$it" },
                                pronouns.takeIf { it.isNotBlank() },
                            ).joinToString(" · "),
                            style = MaterialTheme.typography.labelMedium,
                            color = colors.textSecondary,
                        )
                    }
                }
            }

            Spacer(Modifier.height(18.dp))
            SectionLabel("Display name")
            Spacer(Modifier.height(6.dp))
            NeuTextField(
                value = name,
                onValueChange = { name = it.take(50) },
                placeholder = "Your name",
                modifier = Modifier.fillMaxWidth(),
            )

            Spacer(Modifier.height(14.dp))
            SectionLabel("Pronouns")
            Spacer(Modifier.height(6.dp))
            NeuTextField(
                value = pronouns,
                onValueChange = { pronouns = it.take(32) },
                placeholder = "e.g. they/them",
                modifier = Modifier.fillMaxWidth(),
            )

            Spacer(Modifier.height(14.dp))
            SectionLabel("Bio")
            Spacer(Modifier.height(6.dp))
            NeuTextField(
                value = bio,
                onValueChange = { bio = it.take(280) },
                placeholder = "A line about you",
                modifier = Modifier.fillMaxWidth(),
            )

            Spacer(Modifier.height(14.dp))
            SectionLabel("Flair")
            Spacer(Modifier.height(8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                // "None" returns to the derived per-id colour.
                Box(
                    Modifier
                        .size(40.dp)
                        .clip(CircleShape)
                        .background(colors.veil)
                        .border(
                            width = if (flair == null) 2.dp else 1.dp,
                            color = if (flair == null) colors.accent else colors.textTertiary.copy(alpha = 0.3f),
                            shape = CircleShape,
                        )
                        .softClickable { flair = null },
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(Icons.Rounded.Block, "No flair", tint = colors.textTertiary, modifier = Modifier.size(18.dp))
                }
                FLAIR_PRESETS.forEach { preset ->
                    val pair = flairColors(preset) ?: return@forEach
                    val selected = flair == preset
                    Box(
                        Modifier
                            .size(40.dp)
                            .clip(CircleShape)
                            .background(Brush.linearGradient(listOf(pair.first, pair.second)))
                            .border(
                                width = if (selected) 2.dp else 0.dp,
                                color = if (selected) colors.textPrimary else Color.Transparent,
                                shape = CircleShape,
                            )
                            .softClickable { flair = preset },
                        contentAlignment = Alignment.Center,
                    ) {
                        if (selected) {
                            Icon(Icons.Rounded.Check, null, tint = Color.White, modifier = Modifier.size(18.dp))
                        }
                    }
                }
            }

            Spacer(Modifier.height(22.dp))
            NeuButton(
                onClick = {
                    if (busy) return@NeuButton
                    busy = true
                    scope.launch {
                        val result = runCatching {
                            container.repo.updateProfile(
                                displayName = name.trim().takeIf { it.isNotBlank() },
                                bio = bio.trim().takeIf { it.isNotBlank() },
                                pronouns = pronouns.trim().takeIf { it.isNotBlank() },
                            )
                            container.repo.setMyFlair(flair).user
                        }.getOrNull()
                        result?.let(container::setMe)
                        busy = false
                        if (result != null) {
                            saved = true
                            onDismiss()
                        }
                    }
                },
                accent = true,
                enabled = !busy,
                modifier = Modifier.fillMaxWidth(),
            ) {
                if (busy) {
                    CircularProgressIndicator(Modifier.size(18.dp), color = colors.onAccent, strokeWidth = 2.dp)
                } else {
                    Text(
                        if (saved) "Saved" else "Save",
                        style = MaterialTheme.typography.labelLarge,
                        color = colors.onAccent,
                    )
                }
            }
        }
    }
}

/**
 * Your profile as a QR code, for the person standing next to you.
 *
 * The code carries `yappy://user/<id>` — the system camera reads it and hands
 * the app a deep link straight to the profile, where Follow lives. No web
 * round-trip, nothing to type.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ShareProfileSheet(me: FullUser, onDismiss: () -> Unit) {
    val colors = neuColors
    val context = LocalContext.current
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    val link = "yappy://user/${me.id}"
    val qr = remember(link) { qrBitmap(link, size = 720) }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = colors.surface,
        contentColor = colors.textPrimary,
    ) {
        Column(
            Modifier
                .padding(horizontal = 20.dp)
                .padding(bottom = 28.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text("Share profile", style = MaterialTheme.typography.titleMedium, color = colors.textPrimary)
            Spacer(Modifier.height(4.dp))
            Text(
                "Point a camera at this to open your profile in yappy.",
                style = MaterialTheme.typography.bodyMedium,
                color = colors.textTertiary,
            )
            Spacer(Modifier.height(18.dp))
            qr?.let {
                Box(
                    Modifier
                        .clip(RoundedCornerShape(Neu.CornerMedium))
                        // Always white behind a QR: scanners want contrast, not theming.
                        .background(Color.White)
                        .padding(14.dp),
                ) {
                    Image(it.asImageBitmap(), contentDescription = "Profile QR code", modifier = Modifier.size(240.dp))
                }
            }
            Spacer(Modifier.height(12.dp))
            Text(
                me.username?.let { "@$it" } ?: "",
                style = MaterialTheme.typography.titleSmall,
                color = colors.textSecondary,
            )
            Spacer(Modifier.height(18.dp))
            NeuButton(
                onClick = {
                    val text = buildString {
                        append("I'm ")
                        me.username?.let { append("@$it ") }
                        append("on yappy — ")
                        append(link)
                    }
                    val send = Intent(Intent.ACTION_SEND).apply {
                        type = "text/plain"
                        putExtra(Intent.EXTRA_TEXT, text)
                    }
                    context.startActivity(Intent.createChooser(send, "Share profile"))
                },
                accent = true,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("Share link", style = MaterialTheme.typography.labelLarge, color = colors.onAccent)
            }
        }
    }
}

/** Render a QR as a plain bitmap. Quiet zone handled by the padded white card. */
private fun qrBitmap(content: String, size: Int): Bitmap? = runCatching {
    val matrix = QRCodeWriter().encode(
        content,
        BarcodeFormat.QR_CODE,
        size,
        size,
        mapOf(EncodeHintType.MARGIN to 0),
    )
    val pixels = IntArray(size * size)
    for (y in 0 until size) {
        for (x in 0 until size) {
            pixels[y * size + x] = if (matrix.get(x, y)) android.graphics.Color.BLACK else android.graphics.Color.WHITE
        }
    }
    Bitmap.createBitmap(pixels, size, size, Bitmap.Config.RGB_565)
}.getOrNull()
