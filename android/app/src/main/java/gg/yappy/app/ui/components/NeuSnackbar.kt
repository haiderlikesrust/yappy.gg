package gg.yappy.app.ui.components

import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import gg.yappy.app.ui.theme.Neu
import gg.yappy.app.ui.theme.NeuState
import gg.yappy.app.ui.theme.neuColors

/**
 * The app's snackbar host, and the local that finds it.
 *
 * "Archived · Undo", "Couldn't send · Retry", "Blocked @name · Undo": an
 * action that can be taken back should say so at the moment it happens, in
 * the place Android users already look for it, rather than being final on
 * release or hidden behind a foot link. The shell installs a host at the
 * bottom of the window and screens reach it through [LocalSnackbar], so a
 * message posted there survives the screen that posted it — archive from
 * home, navigate away, the Undo is still there. A bubble has no shell, so
 * BubbleActivity installs the equivalent host as a floor for anything its
 * one ChatScreen composes outside the chat's own provider. Nothing reads it
 * today — the forum branch that returns early into ForumScreen draws its
 * post error inside its own sheet — but the local's default throws, so the
 * floor stays.
 *
 * Chat and thread are the exception: they provide their own [LocalSnackbar]
 * with a host drawn at the foot of the timeline, above the composer, so a
 * Retry never covers Send. Anything posted there dies with the screen, and
 * the chat commits or restores its pending work on that basis rather than
 * on a timer (see ChatScreen).
 *
 *   val snackbar = LocalSnackbar.current
 *   scope.launch {
 *       val result = snackbar.showSnackbar("Archived", actionLabel = "Undo", duration = SnackbarDuration.Short)
 *       if (result == SnackbarResult.ActionPerformed) vm.unarchive(id)
 *   }
 *
 * The shell pads the host for the navigation bar and the keyboard; the host
 * itself only knows how to draw a message.
 */
val LocalSnackbar = staticCompositionLocalOf<SnackbarHostState> { error("NeuSnackbarHost not installed") }

/**
 * How much of the bottom edge the shell's snackbar is using right now.
 *
 * Measured by the shell, not assumed: a screen with a floating button lifts
 * it by this much while a message is up, the way Material's scaffold moves
 * its FAB, so "Undo" is never drawn under the button that opens a new chat.
 * Zero while nothing is showing, which is what an absent shell provides too.
 */
val LocalSnackbarClearance = compositionLocalOf<Dp> { 0.dp }

/**
 * A snackbar in the sheet's own material: a raised pill, body in the primary
 * ink, the action in accent. Not Material's inverse-surface slab — a black
 * bar sliding over a lavender sheet is the one moment the app would stop
 * looking like itself — and not mention-yellow for the action either, since
 * yellow means "you were called" everywhere else.
 *
 * Material's [SnackbarHost] is kept underneath for what it does well: the
 * queue, the timing, the live-region announcement and the swipe-away.
 */
@Composable
fun NeuSnackbarHost(hostState: SnackbarHostState, modifier: Modifier = Modifier) {
    val colors = neuColors
    SnackbarHost(hostState = hostState, modifier = modifier) { data ->
        NeuSurface(
            modifier = Modifier
                .padding(horizontal = 16.dp, vertical = 8.dp)
                .widthIn(max = 560.dp)
                .fillMaxWidth(),
            shape = RoundedCornerShape(Neu.CornerMedium),
            state = NeuState.Raised,
            elevation = 8.dp,
            fill = colors.surfaceRaised,
            contentPadding = 0.dp,
        ) {
            Row(
                Modifier.padding(start = 18.dp, end = 6.dp, top = 4.dp, bottom = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    data.visuals.message,
                    style = MaterialTheme.typography.bodyMedium,
                    color = colors.textPrimary,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier
                        .weight(1f)
                        .padding(vertical = 10.dp),
                )
                val action = data.visuals.actionLabel
                if (action != null) {
                    Text(
                        action,
                        style = MaterialTheme.typography.labelLarge,
                        color = colors.accent,
                        maxLines = 1,
                        modifier = Modifier
                            .padding(start = 8.dp)
                            .minimumInteractiveComponentSize()
                            .clip(RoundedCornerShape(Neu.CornerPill))
                            .softClickable { data.performAction() }
                            .padding(horizontal = 12.dp, vertical = 8.dp),
                    )
                }
                if (data.visuals.withDismissAction) {
                    Icon(
                        Icons.Rounded.Close,
                        contentDescription = "Dismiss",
                        tint = colors.textSecondary,
                        modifier = Modifier
                            .minimumInteractiveComponentSize()
                            .clip(CircleShape)
                            .softClickable { data.dismiss() }
                            .padding(8.dp)
                            .size(18.dp),
                    )
                }
            }
        }
    }
}
