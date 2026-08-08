package gg.yappy.app.ui.components

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import gg.yappy.app.R
import gg.yappy.app.ui.theme.neuColors

/**
 * The yappy mark.
 *
 * Stored as a white silhouette with an alpha channel — no colour of its own —
 * so a single asset serves the light theme, the dark theme, the gradient
 * lockup and the launcher icon. Tinting one file beats shipping four that can
 * drift apart.
 *
 * Sized by height rather than a square box: the mark is noticeably wider than
 * it is tall, and forcing it square would either letterbox it or crop the
 * tongue.
 */
@Composable
fun LogoMark(
    modifier: Modifier = Modifier,
    height: Dp = 24.dp,
    tint: Color? = null,
) {
    val colors = neuColors
    Image(
        painter = painterResource(R.drawable.logo_mark),
        contentDescription = "yappy",
        contentScale = ContentScale.Fit,
        colorFilter = ColorFilter.tint(tint ?: colors.textPrimary),
        modifier = modifier.height(height),
    )
}

/**
 * The mark painted with the brand gradient, for the two places that are about
 * the product itself: the sign-in screen and the home header.
 */
@Composable
fun LogoMarkGradient(
    modifier: Modifier = Modifier,
    height: Dp = 24.dp,
) {
    val colors = neuColors
    Box(
        modifier.gradientFill(Brush.linearGradient(listOf(colors.accent, Color(0xFF00CEC9)))),
    ) {
        LogoMark(height = height, tint = Color.White)
    }
}
