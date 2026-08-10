package gg.yappy.app.ui.media

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import gg.yappy.app.ui.chat.InlineVideo
import gg.yappy.app.ui.chat.MediaFactory
import gg.yappy.app.ui.components.softClickable

/**
 * Full-screen video playback.
 *
 * The player comes from [MediaFactory] rather than a bare `ExoPlayer.Builder`
 * so the request carries the bearer token — message attachments are private,
 * and a plain URI just shows a black frame over a 401.
 */
@Composable
fun VideoPlayerScreen(
    url: String,
    mediaFactory: MediaFactory,
    onDismiss: () -> Unit,
) {
    Box(Modifier.fillMaxSize().background(Color.Black)) {
        InlineVideo(
            url = url,
            mediaFactory = mediaFactory,
            modifier = Modifier.fillMaxSize(),
            autoPlay = true,
            // A full-screen player is the one place scrubbing is the point.
            showControls = true,
        )

        Box(
            Modifier
                .align(Alignment.TopStart)
                .padding(start = 16.dp, top = 8.dp)
                .size(38.dp)
                .clip(CircleShape)
                .background(Color.Black.copy(alpha = 0.5f))
                .softClickable(onClick = onDismiss),
            contentAlignment = Alignment.Center,
        ) {
            Icon(Icons.Rounded.Close, "Close", tint = Color.White, modifier = Modifier.size(18.dp))
        }
    }
}
