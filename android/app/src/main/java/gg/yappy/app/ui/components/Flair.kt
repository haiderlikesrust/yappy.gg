package gg.yappy.app.ui.components

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawOutline
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import gg.yappy.app.data.ConversationAppearance

/**
 * Group flair rendering.
 *
 * A group's flair is its owner's one visual sentence about the place, so it has
 * to be *visible* (the whole point is the conversation list) without breaking
 * the design system. The rule: flair may add colour and motion *around* an
 * element — the ring, a glow, a tinted title — but never restyles the element
 * itself. That is what keeps a flaired row and a plain row siblings instead of
 * strangers.
 */

fun flairColor(hex: String?): Color? = hex?.let {
    runCatching { Color(android.graphics.Color.parseColor(it)) }.getOrNull()
}

/**
 * Paints whatever the element draws (text, icons) with [brush] via an SrcIn
 * blend — the portable way to get gradient text without depending on
 * TextStyle's brush support. The 0.99 alpha forces an offscreen layer, which
 * the blend needs to composite against.
 */
fun Modifier.gradientFill(brush: Brush): Modifier = this
    .graphicsLayer(alpha = 0.99f)
    .drawWithContent {
        drawContent()
        drawRect(brush = brush, blendMode = BlendMode.SrcIn)
    }

/** The two ring stops: explicit gradient, else accent doubled, else null. */
fun ConversationAppearance.ringColors(): List<Color>? {
    val fromGradient = gradient?.mapNotNull { flairColor(it) }?.takeIf { it.size >= 2 }
    if (fromGradient != null) return fromGradient
    val solid = flairColor(accent) ?: return null
    return listOf(solid, solid.copy(alpha = 0.55f))
}

/** Colour a flaired title should take: the accent, else the first gradient stop. */
fun ConversationAppearance.titleColor(): Color? =
    flairColor(accent) ?: gradient?.firstOrNull()?.let { flairColor(it) }

/**
 * An [Avatar] wrapped in its group's flair: a gradient ring, optionally glowing
 * or shimmering. Falls back to a plain avatar when there is nothing to show, so
 * call sites do not need to branch.
 */
@Composable
fun FlairAvatar(
    appearance: ConversationAppearance?,
    url: String?,
    name: String?,
    id: String,
    modifier: Modifier = Modifier,
    size: Dp = 48.dp,
    presence: String? = null,
    /** Squircle for groups, circle for people — see [gg.yappy.app.ui.theme.PlaceShape]. */
    shape: androidx.compose.ui.graphics.Shape = androidx.compose.foundation.shape.CircleShape,
) {
    val ring = appearance?.ringColors()
    if (ring == null) {
        Avatar(url, name, id, modifier, size, presence, shape)
        return
    }

    // Shimmer rotates the gradient around the ring; a static ring is angle 0.
    // One infinite transition per avatar is fine — the list shows tens, not
    // thousands, and Compose elides the animation when nothing reads it.
    val angle = if (appearance.effect == "shimmer") {
        val transition = rememberInfiniteTransition(label = "flair-shimmer")
        val value by transition.animateFloat(
            initialValue = 0f,
            targetValue = 360f,
            animationSpec = infiniteRepeatable(tween(2600, easing = LinearEasing)),
            label = "flair-angle",
        )
        value
    } else 0f

    val stroke = 2.5.dp
    val gap = 2.5.dp
    val glow = appearance.effect == "glow"

    // The ring is drawn *inside* the declared size and the avatar shrinks to
    // fit, so flaired and plain rows keep identical layout metrics.
    Box(
        modifier = modifier
            .size(size)
            .drawBehind {
                val radius = this.size.minDimension / 2f
                if (glow) {
                    drawCircle(
                        brush = Brush.radialGradient(
                            colors = listOf(ring.first().copy(alpha = 0.40f), Color.Transparent),
                            center = Offset(this.size.width / 2f, this.size.height / 2f),
                            radius = radius * 1.35f,
                        ),
                        radius = radius * 1.35f,
                    )
                }
                // The ring follows the avatar's silhouette — a circle for a
                // person, a squircle for a place. Inset by half the stroke so
                // the ring stays inside the declared bounds.
                val strokePx = stroke.toPx()
                val ringSize = androidx.compose.ui.geometry.Size(
                    this.size.width - strokePx,
                    this.size.height - strokePx,
                )
                rotate(angle) {
                    translate(strokePx / 2f, strokePx / 2f) {
                        drawOutline(
                            outline = shape.createOutline(ringSize, layoutDirection, this),
                            brush = Brush.sweepGradient(ring + ring.first()),
                            style = Stroke(width = strokePx),
                        )
                    }
                }
            }
            .padding(stroke + gap),
        contentAlignment = Alignment.Center,
    ) {
        Avatar(url, name, id, size = size - (stroke + gap) * 2, presence = presence, shape = shape)
    }
}
