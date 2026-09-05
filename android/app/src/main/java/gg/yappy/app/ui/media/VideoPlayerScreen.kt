package gg.yappy.app.ui.media

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.view.WindowManager
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import gg.yappy.app.ui.chat.InlineVideo
import gg.yappy.app.ui.chat.MediaFactory
import gg.yappy.app.ui.components.softClickable

/**
 * Full-screen video playback.
 *
 * The player comes from [MediaFactory] rather than a bare `ExoPlayer.Builder`
 * so the request carries the bearer token — message attachments are private,
 * and a plain URI just shows a black frame over a 401.
 *
 * This is composed as an overlay inside the chat rather than as its own
 * destination, which means the *window* is still the chat's. So the things a
 * player is expected to do to a window — hide the bars, keep the display awake,
 * answer Back — all have to be done here and undone on the way out, or the
 * chat underneath inherits a dark immersive window with no status bar.
 */
@Composable
fun VideoPlayerScreen(
    url: String,
    mediaFactory: MediaFactory,
    onDismiss: () -> Unit,
) {
    // Back closes the player, not the chat. Without this the whole chat route
    // pops out from under a video that is still playing.
    BackHandler(onBack = onDismiss)

    val view = LocalView.current
    DisposableEffect(view) {
        val window = view.context.findActivity()?.window
        val controller = window?.let { WindowCompat.getInsetsController(it, view) }
        // Remembered rather than assumed: the theme sets light or dark bar
        // icons from the account's palette, and the player must hand back
        // whatever it found, not a guess about what the theme would choose.
        val lightStatus = controller?.isAppearanceLightStatusBars ?: true
        val lightNav = controller?.isAppearanceLightNavigationBars ?: true

        // A video should not be cut off by the screen timeout halfway through,
        // and a player on a black page should own the whole display; the bars
        // come back on a swipe and go again on their own.
        window?.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        controller?.apply {
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            isAppearanceLightStatusBars = false
            isAppearanceLightNavigationBars = false
            hide(WindowInsetsCompat.Type.systemBars())
        }

        onDispose {
            window?.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            controller?.apply {
                show(WindowInsetsCompat.Type.systemBars())
                isAppearanceLightStatusBars = lightStatus
                isAppearanceLightNavigationBars = lightNav
            }
        }
    }

    Box(Modifier.fillMaxSize().background(Color.Black)) {
        InlineVideo(
            url = url,
            mediaFactory = mediaFactory,
            modifier = Modifier.fillMaxSize(),
            autoPlay = true,
            // A full-screen player is the one place scrubbing is the point.
            showControls = true,
        )

        // The disc stays 38dp so it reads as a small, quiet control over the
        // picture, but the thing you tap is the 48dp box around it: when the
        // bars are hidden this sits in the corner where a thumb lands least
        // precisely.
        Box(
            Modifier
                .align(Alignment.TopStart)
                .statusBarsPadding()
                .padding(start = 11.dp, top = 3.dp)
                .size(48.dp)
                .semantics { role = Role.Button }
                .softClickable(onClick = onDismiss),
            contentAlignment = Alignment.Center,
        ) {
            Box(
                Modifier
                    .size(38.dp)
                    .clip(CircleShape)
                    .background(Color.Black.copy(alpha = 0.5f)),
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Rounded.Close, "Close", tint = Color.White, modifier = Modifier.size(18.dp))
            }
        }
    }
}

/**
 * The view's context is usually a theme wrapper around the activity rather
 * than the activity itself; unwrap until something owns a window.
 */
private tailrec fun Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}
