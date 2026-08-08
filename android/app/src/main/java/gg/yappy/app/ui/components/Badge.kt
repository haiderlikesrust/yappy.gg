package gg.yappy.app.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import gg.yappy.app.data.Affiliation
import gg.yappy.app.data.PublicUser
import gg.yappy.app.ui.theme.LocalNeuColors
import gg.yappy.app.ui.theme.PlaceShape
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

/**
 * Identity marks.
 *
 * Two different claims, drawn differently on purpose:
 *
 *   badge       — the platform vouching for an account. A scalloped seal.
 *   affiliation — a *group* vouching for a person. The group's own logo, in the
 *                 squircle that means "place" everywhere else in the app.
 *
 * Keeping them visually distinct matters more than it might seem: conflating
 * "yappy says this is really them" with "this org says they work here" is how
 * badge systems end up meaning nothing. The seal is ours to give; the squircle
 * is someone else's, and it looks borrowed.
 *
 * Marks are drawn, not iconography from a set — at 14dp a Material icon reads
 * as a smudge, and a seal built from circles stays legible down to 12dp.
 */

const val BADGE_VERIFIED = "verified"
const val BADGE_PARTNER = "partner"
const val BADGE_STAFF = "staff"

/** Human-readable, for profile screens and long-press explanations. */
fun badgeLabel(badge: String?): String? = when (badge) {
    BADGE_VERIFIED -> "Verified"
    BADGE_PARTNER -> "yappy partner"
    BADGE_STAFF -> "yappy staff"
    else -> null
}

fun badgeDescription(badge: String?): String? = when (badge) {
    BADGE_VERIFIED -> "yappy confirmed this account is who it says it is."
    BADGE_PARTNER -> "Part of the yappy partner programme."
    BADGE_STAFF -> "Works on yappy."
    else -> null
}

/**
 * Draws the seal: a disc ringed by overlapping lobes. Filling overlapping
 * circles unions them for free, which is far less code than solving for a
 * scalloped outline and holds its shape at any size.
 */
private fun DrawScope.drawSeal(brush: Brush, lobes: Int = 9) {
    val r = size.minDimension / 2f
    val centre = Offset(size.width / 2f, size.height / 2f)
    val coreRadius = r * 0.72f
    val lobeRadius = r * 0.30f
    val ring = r * 0.70f

    drawCircle(brush = brush, radius = coreRadius, center = centre)
    for (i in 0 until lobes) {
        val angle = (2.0 * PI * i / lobes) - PI / 2.0
        drawCircle(
            brush = brush,
            radius = lobeRadius,
            center = Offset(
                centre.x + (cos(angle) * ring).toFloat(),
                centre.y + (sin(angle) * ring).toFloat(),
            ),
        )
    }
}

private fun DrawScope.drawCheck(color: Color) {
    val w = size.width
    val path = Path().apply {
        moveTo(w * 0.31f, w * 0.51f)
        lineTo(w * 0.44f, w * 0.64f)
        lineTo(w * 0.70f, w * 0.37f)
    }
    drawPath(
        path = path,
        color = color,
        style = Stroke(width = w * 0.11f, cap = StrokeCap.Round, join = StrokeJoin.Round),
    )
}

/**
 * One badge. Renders nothing for an unknown or absent kind, so call sites can
 * pass a raw wire string without branching — and a badge kind added by a newer
 * server simply does not appear on an older build, rather than crashing it.
 */
@Composable
fun BadgeMark(badge: String?, modifier: Modifier = Modifier, size: Dp = 15.dp) {
    val colors = LocalNeuColors.current
    if (badgeLabel(badge) == null) return

    // Partner gets the gradient because it is the rarer, "earned" mark; a flat
    // fill would make it read as a second verified.
    val brush = when (badge) {
        BADGE_PARTNER -> Brush.linearGradient(listOf(colors.accent, Color(0xFFFF6BD6)))
        BADGE_STAFF -> Brush.linearGradient(listOf(colors.warning, colors.warning))
        else -> Brush.linearGradient(listOf(colors.accent, colors.accent))
    }
    val glyph = if (colors.isDark) Color(0xFF14121F) else Color.White

    Box(
        modifier = modifier.size(size).drawBehind {
            drawSeal(brush)
            if (badge != BADGE_STAFF) drawCheck(glyph)
        },
        contentAlignment = Alignment.Center,
    ) {
        // Staff carries the wordmark initial instead of a check — the mark says
        // "this is us", not "this is verified", and the two should not be
        // distinguishable by colour alone.
        if (badge == BADGE_STAFF) {
            Text(
                "y",
                style = MaterialTheme.typography.labelSmall.copy(
                    fontSize = (size.value * 0.62f).sp,
                    fontWeight = FontWeight.Bold,
                    lineHeight = (size.value * 0.62f).sp,
                ),
                color = glyph,
            )
        }
    }
}

/**
 * The affiliated group's logo. A squircle, because in this app a squircle is
 * always a place — the shape is doing the explaining.
 */
@Composable
fun AffiliateMark(affiliation: Affiliation?, modifier: Modifier = Modifier, size: Dp = 15.dp) {
    if (affiliation == null) return
    Avatar(
        url = affiliation.avatarUrl,
        name = affiliation.title,
        id = affiliation.id,
        modifier = modifier.clip(PlaceShape),
        size = size,
        shape = PlaceShape,
    )
}

/**
 * Everything that goes after a name, in a fixed order: affiliation first (whose
 * it is), then the badge (what they are). Emits nothing at all when there is
 * nothing to show, so it can be dropped into any row without disturbing layout.
 */
@Composable
fun IdentityMarks(
    user: PublicUser,
    modifier: Modifier = Modifier,
    size: Dp = 15.dp,
) {
    if (user.badge == null && user.affiliation == null) return
    Row(
        modifier = modifier,
        horizontalArrangement = Arrangement.spacedBy(3.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        AffiliateMark(user.affiliation, size = size)
        BadgeMark(user.badge, size = size)
    }
}
