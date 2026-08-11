package gg.yappy.app.ui.chat

import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding

import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Send
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import gg.yappy.app.ui.components.NeuIconButton
import gg.yappy.app.ui.components.NeuTextField
import gg.yappy.app.ui.theme.neuColors

/**
 * What you picked, before it is sent.
 *
 * Picking a photo used to post it immediately. Every other messenger stops here
 * first, and not for ceremony: the picker is a grid of thumbnails, the wrong
 * one is a tap away from the right one, and an image sent by accident cannot be
 * unsent for the person who already saw it. This is the half-second in which
 * that is still recoverable.
 *
 * It is also where the caption belongs. The caption used to be whatever
 * happened to be in the composer when you tapped the picker — text written
 * before you chose the picture, silently attached to it and cleared from the
 * box. Written here, it is obviously *about* this image.
 */
@Composable
fun AttachmentPreview(
    uri: Uri,
    initialCaption: String,
    onCancel: () -> Unit,
    onSend: (caption: String?) -> Unit,
) {
    val colors = neuColors
    var caption by remember { mutableStateOf(initialCaption) }

    Box(
        Modifier
            .fillMaxSize()
            // Nearly opaque rather than a dim: the point of this screen is to
            // look at the picture, and a timeline showing through it is exactly
            // the thing that made a mis-tap easy in the first place.
            .background(Color.Black.copy(alpha = 0.92f)),
    ) {
        Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().imePadding()) {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                NeuIconButton(Icons.Rounded.Close, "Cancel", onCancel, size = 42.dp, iconSize = 19.dp)
                Spacer(Modifier.width(12.dp))
                Text(
                    "Send photo",
                    style = MaterialTheme.typography.titleSmall,
                    color = Color.White,
                )
            }

            AsyncImage(
                model = uri,
                contentDescription = null,
                // Fit, not crop. A preview that crops is lying about what will
                // be sent, which defeats the point of showing it.
                contentScale = ContentScale.Fit,
                modifier = Modifier.fillMaxWidth().weight(1f).padding(horizontal = 12.dp),
            )

            Row(
                Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                NeuTextField(
                    value = caption,
                    onValueChange = { caption = it },
                    placeholder = "Add a caption",
                    singleLine = false,
                    maxLines = 4,
                    modifier = Modifier.weight(1f),
                )
                NeuIconButton(
                    Icons.Rounded.Send,
                    "Send",
                    { onSend(caption.trim().takeIf { it.isNotEmpty() }) },
                    size = 52.dp,
                    iconSize = 21.dp,
                    accent = true,
                )
            }
        }
    }
}
