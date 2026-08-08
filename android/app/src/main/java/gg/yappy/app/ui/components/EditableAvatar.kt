package gg.yappy.app.ui.components

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.PhotoCamera
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import gg.yappy.app.ui.theme.neuColors

/**
 * An avatar you can change.
 *
 * The camera pip sits *on* the picture rather than beside it as a separate
 * "Edit photo" row: on every phone app in existence, tapping your own face is
 * how you change it, and a row nobody looks for is a feature nobody finds.
 *
 * Shape is passed through rather than assumed, so this works for a person
 * (circle) and a group (squircle) without a second component — the app's shape
 * language stays intact in the one place people are most likely to notice it.
 */
@Composable
fun EditableAvatar(
    url: String?,
    name: String?,
    id: String,
    onPicked: (Uri) -> Unit,
    modifier: Modifier = Modifier,
    size: Dp = 96.dp,
    shape: Shape = CircleShape,
    busy: Boolean = false,
    enabled: Boolean = true,
) {
    val colors = neuColors
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri != null) onPicked(uri)
    }

    Box(modifier.size(size), contentAlignment = Alignment.BottomEnd) {
        Box(
            Modifier
                .size(size)
                .clip(shape)
                .then(
                    if (enabled && !busy) {
                        Modifier.softClickable {
                            picker.launch(
                                PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly),
                            )
                        }
                    } else Modifier,
                ),
            contentAlignment = Alignment.Center,
        ) {
            Avatar(url, name, id, size = size, shape = shape)
            // The spinner covers the picture rather than replacing it, so the
            // old image stays visible until the new one is actually live.
            if (busy) {
                Box(
                    Modifier.size(size).background(colors.surface.copy(alpha = 0.6f)),
                    contentAlignment = Alignment.Center,
                ) {
                    CircularProgressIndicator(color = colors.accent, strokeWidth = 2.dp)
                }
            }
        }

        if (enabled && !busy) {
            Box(
                Modifier
                    .size(size * 0.30f)
                    .clip(CircleShape)
                    .background(colors.accent),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    Icons.Rounded.PhotoCamera,
                    "Change picture",
                    tint = colors.onAccent,
                    modifier = Modifier.size(size * 0.17f),
                )
            }
        }
    }
}
