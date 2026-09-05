package gg.yappy.app.ui.components

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.pulltorefresh.PullToRefreshState
import androidx.compose.material3.pulltorefresh.pullToRefreshIndicator
import androidx.compose.material3.pulltorefresh.rememberPullToRefreshState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.unit.dp
import gg.yappy.app.ui.theme.NeuState
import gg.yappy.app.ui.theme.neu
import gg.yappy.app.ui.theme.neuColors

/**
 * Pull to refresh, in the house style.
 *
 * Every list screen already refetches on gateway events and on a timer, but
 * none of them let the person *ask* — and on Android a list that does not
 * pull is a list that feels cached. Material's box does the gesture work; the
 * indicator is ours: a raised disc pressed out of the sheet holding the mark,
 * which winds as the pull deepens and spins while the fetch is out. The
 * default Material spinner would be the one stock-blue thing on the page.
 *
 * The one indicator for every screen that pulls — the places, home and
 * explore — so a pull feels the same wherever it starts.
 *
 * [underStatusBar] says whether the box itself reaches under the status bar.
 * A place does (its hero draws behind the clock), so the disc steps down
 * clear of it; home, explore and the forum pad the bar above the box, and
 * for them the same step put the disc a status-bar too low, hanging in the
 * middle of the first row.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RefreshBox(
    refreshing: Boolean,
    onRefresh: () -> Unit,
    modifier: Modifier = Modifier,
    underStatusBar: Boolean = true,
    content: @Composable BoxScope.() -> Unit,
) {
    val state = rememberPullToRefreshState()
    val haptics = LocalHapticFeedback.current

    // One tick as the pull arms — the moment letting go would do something.
    // Read through derivedStateOf so the effect keys on the crossing, not on
    // every pixel of the drag.
    val armed by remember(state) { derivedStateOf { state.distanceFraction >= 1f } }
    LaunchedEffect(armed) {
        if (armed && !refreshing) haptics.performHapticFeedback(HapticFeedbackType.LongPress)
    }

    PullToRefreshBox(
        isRefreshing = refreshing,
        onRefresh = onRefresh,
        state = state,
        modifier = modifier,
        indicator = {
            RefreshDisc(
                state = state,
                refreshing = refreshing,
                modifier = Modifier
                    .align(Alignment.TopCenter)
                    .then(if (underStatusBar) Modifier.statusBarsPadding() else Modifier),
            )
        },
        content = content,
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun RefreshDisc(state: PullToRefreshState, refreshing: Boolean, modifier: Modifier) {
    val colors = neuColors
    // The transition only exists while a fetch is out, the same way PixelPet
    // only animates a pet with something to animate.
    val spin = if (refreshing) {
        rememberInfiniteTransition(label = "refresh").animateFloat(
            initialValue = 0f,
            targetValue = 360f,
            animationSpec = infiniteRepeatable(tween(900, easing = LinearEasing)),
            label = "refresh-spin",
        ).value
    } else {
        0f
    }
    Box(
        modifier
            // Material positions and clips the indicator; the container it
            // would paint is switched off so the neu disc is the only surface.
            .pullToRefreshIndicator(
                state = state,
                isRefreshing = refreshing,
                containerColor = Color.Transparent,
                elevation = 0.dp,
            )
            .size(40.dp)
            .neu(CircleShape, colors, NeuState.Raised, 5.dp)
            .clip(CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        LogoMark(
            height = 18.dp,
            tint = colors.accent,
            modifier = Modifier.graphicsLayer {
                rotationZ = if (refreshing) spin else state.distanceFraction.coerceIn(0f, 1.5f) * 180f
            },
        )
    }
}
