package gg.yappy.app.ui.theme

import android.graphics.BlurMaskFilter
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Outline
import androidx.compose.ui.graphics.Paint
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.drawOutline
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp

/**
 * The neumorphic surface treatments.
 *
 * Three states, and the whole visual language is built from them:
 *
 *   Raised  — light shadow top-left, dark shadow bottom-right, drawn *outside*
 *             the shape. Reads as extruded. Used for cards, buttons at rest.
 *   Pressed — the same two shadows drawn *inside*. Reads as debossed. Used for
 *             inputs, toggles that are on, and buttons while held.
 *   Flat    — no shadows. Used inside an already-recessed container, where a
 *             second level of extrusion just looks noisy.
 *
 * Compose has no inner-shadow primitive, so `Pressed` is drawn manually: clip
 * to the shape, fill it with the shadow colour, then punch the shape back out
 * with a blurred DST_OUT pass offset in the light direction. What survives is a
 * soft band hugging one inside edge — exactly an inner shadow.
 */
enum class NeuState { Raised, Pressed, Flat }

object Neu {
    val CornerSmall = 12.dp
    val CornerMedium = 20.dp
    val CornerLarge = 28.dp
    val CornerPill = 999.dp
}

/**
 * The shape language: **squircles are places, circles are people.** A group
 * avatar is a room icon; a person's avatar is a face. Rendering them with
 * different silhouettes makes the distinction legible at a glance anywhere in
 * the app, without a label.
 */
val PlaceShape = androidx.compose.foundation.shape.RoundedCornerShape(percent = 32)

/**
 * @param elevation Both the blur radius and the offset. Keeping them locked
 *   together is what keeps every element on the sheet lit by the same imaginary
 *   lamp; letting callers set them independently is how neumorphic UIs start
 *   looking incoherent.
 */
fun Modifier.neu(
    shape: Shape,
    colors: NeuColors,
    state: NeuState = NeuState.Raised,
    elevation: Dp = 6.dp,
    fill: Color? = null,
    /**
     * Softens both shadows. The default is deliberately well below 1f: at full
     * strength every element competes for attention and a busy screen reads as
     * a wall of pillows. Shadows should be a whisper — pass a higher value only
     * for something that genuinely needs to dominate (nothing currently does).
     *
     * Lower in the dark theme, because the same RGB step is a far larger
     * *relative* change against a dark surface: the highlight is +37% luminance
     * on #232030 but only +8.5% on #EBE9F4. At one shared value the dark theme
     * grows visible halos, and where several controls sit in a row — the
     * composer — those halos merge into a slab that looks like a container
     * nobody drew. Not lower still: below about 0.4 the sculpt disappears and
     * chrome goes flat. The rest of the separation comes from the per-state
     * fills, not from turning this down further.
     */
    intensity: Float = if (colors.isDark) 0.42f else 0.55f,
): Modifier = this.drawBehind {
    val outline = shape.createOutline(size, layoutDirection, this)
    // Per-state fill, so the dark theme can separate a control from the sheet
    // tonally instead of asking the shadows to do it alone. In the light theme
    // all three are the same colour and this is a no-op.
    val surface = fill ?: when (state) {
        NeuState.Raised -> colors.surfaceRaised
        NeuState.Pressed -> colors.surfaceRecessed
        NeuState.Flat -> colors.surface
    }
    // Offset trails the blur: a wide, faint, close shadow reads as ambient
    // light; a tight, offset one reads as an object held above the page.
    val offset = elevation.toPx() * 0.8f
    val blur = (elevation.toPx() * 2.1f).coerceAtLeast(0.1f)

    /**
     * The dark theme is flat. Not quieter neumorphism — none.
     *
     * The emboss depends on a highlight the surface has headroom for, and
     * violet-charcoal has almost none: every intensity tried either ringed
     * raised controls with a glowing lip or left crescents that read as smudges
     * ("weird depth"). Meanwhile the per-state fills already separate raised
     * from recessed on their own. So dark keeps the fills and drops the
     * sculpt entirely — the same conclusion every mainstream dark chat UI
     * arrived at — and the light theme keeps the full soft treatment, where
     * the sheet actually supports it.
     */
    when (state) {
        NeuState.Raised -> {
            if (!colors.isDark) {
                drawOuterShadow(outline, colors.dark, blur, offset, offset, intensity)
                drawOuterShadow(outline, colors.light, blur, -offset, -offset, intensity)
            }
            drawOutline(outline, surface)
        }

        NeuState.Pressed -> {
            drawOutline(outline, surface)
            if (!colors.isDark) {
                // Dark inside the top-left, light inside the bottom-right: the
                // exact inverse of Raised, which sells the "pushed in" reading.
                drawInnerShadow(outline, colors.dark, blur, offset, offset, intensity)
                drawInnerShadow(outline, colors.light, blur, -offset, -offset, intensity)
            }
        }

        NeuState.Flat -> drawOutline(outline, surface)
    }
}

private fun DrawScope.drawOuterShadow(
    outline: Outline,
    color: Color,
    blur: Float,
    dx: Float,
    dy: Float,
    intensity: Float,
) {
    drawIntoCanvas { canvas ->
        val paint = Paint()
        val frameworkPaint = paint.asFrameworkPaint()
        frameworkPaint.isAntiAlias = true
        // Draw the shape fully transparent and let setShadowLayer render only
        // the shadow. Filling it as well would paint a hard-edged copy of the
        // shape on top of its own blur.
        frameworkPaint.color = android.graphics.Color.TRANSPARENT
        frameworkPaint.setShadowLayer(
            blur,
            dx,
            dy,
            color.copy(alpha = color.alpha * intensity).toArgb(),
        )
        canvas.drawOutline(outline, paint)
        frameworkPaint.clearShadowLayer()
    }
}

private fun DrawScope.drawInnerShadow(
    outline: Outline,
    color: Color,
    blur: Float,
    dx: Float,
    dy: Float,
    intensity: Float,
) {
    drawIntoCanvas { canvas ->
        // saveLayer so the DST_OUT punch below composites against this layer
        // rather than against everything already on screen.
        canvas.saveLayer(
            androidx.compose.ui.geometry.Rect(Offset.Zero, size),
            Paint(),
        )

        val shadowPaint = Paint().apply {
            this.color = color.copy(alpha = color.alpha * intensity)
            asFrameworkPaint().isAntiAlias = true
        }
        canvas.drawOutline(outline, shadowPaint)

        val punch = Paint()
        punch.asFrameworkPaint().apply {
            isAntiAlias = true
            this.color = android.graphics.Color.BLACK
            maskFilter = BlurMaskFilter(blur, BlurMaskFilter.Blur.NORMAL)
            xfermode = PorterDuffXfermode(PorterDuff.Mode.DST_OUT)
        }

        canvas.save()
        canvas.translate(dx, dy)
        canvas.drawOutline(outline, punch)
        canvas.restore()

        punch.asFrameworkPaint().xfermode = null
        canvas.restore()
    }
}

/**
 * Clips the shadow band to the shape so an inner shadow cannot bleed past a
 * rounded corner. Applied by the components rather than by `neu` itself,
 * because content often wants to overflow (an avatar peeking out of a card).
 */
fun Modifier.neuClip(shape: Shape): Modifier = this.drawWithContent {
    drawContent()
}

/** Convenience for the common case of a soft, slightly-recessed divider. */
fun Modifier.neuDivider(colors: NeuColors, thickness: Dp = 1.dp): Modifier = drawBehind {
    val y = size.height / 2f
    drawLine(colors.dark.copy(alpha = 0.35f), Offset(0f, y), Offset(size.width, y), thickness.toPx())
    drawLine(
        colors.light.copy(alpha = 0.7f),
        Offset(0f, y + thickness.toPx()),
        Offset(size.width, y + thickness.toPx()),
        thickness.toPx(),
    )
}

@Composable
fun rememberNeuSize(): Size = Size.Unspecified

internal fun layoutDirectionOf(rtl: Boolean) = if (rtl) LayoutDirection.Rtl else LayoutDirection.Ltr
