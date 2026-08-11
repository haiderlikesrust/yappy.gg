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
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.TextUnit
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
const val BADGE_YAPPER = "yapper"
const val BADGE_BETA = "beta"
const val BADGE_DEVELOPER = "developer"

/** Human-readable, for profile screens and long-press explanations. */
fun badgeLabel(badge: String?): String? = when (badge) {
    BADGE_VERIFIED -> "Verified"
    BADGE_PARTNER -> "yappy partner"
    BADGE_STAFF -> "yappy staff"
    BADGE_YAPPER -> "OG yapper"
    BADGE_BETA -> "Beta tester"
    BADGE_DEVELOPER -> "Bot developer"
    else -> null
}

fun badgeDescription(badge: String?): String? = when (badge) {
    BADGE_VERIFIED -> "yappy confirmed this account is who it says it is."
    BADGE_PARTNER -> "Part of the yappy partner programme."
    BADGE_STAFF -> "Works on yappy."
    BADGE_YAPPER -> "Here early, when yappy was small."
    BADGE_BETA -> "Tests builds before anybody else has to."
    BADGE_DEVELOPER -> "Has built a bot on the platform."
    else -> null
}

/**
 * The glyph inside the seal, and the colour of it.
 *
 * Every mark is the same scalloped seal so they read as one family, and the
 * letter is what tells them apart at 14dp — a second shape would not survive
 * being that small. Staff and yapper share the wordmark because both mean "this
 * account is part of yappy"; the colour is what separates working here from
 * having been here first.
 */
private fun badgeGlyph(badge: String?): String? = when (badge) {
    BADGE_STAFF, BADGE_YAPPER -> "y"
    BADGE_BETA -> "β"
    BADGE_DEVELOPER -> "<>"
    else -> null // verified and partner carry the check
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
        // Warm gold, and only for this one. "Was here first" is the only mark
        // the platform hands out for something that cannot be earned again.
        BADGE_YAPPER -> Brush.linearGradient(listOf(Color(0xFFF7B733), Color(0xFFFC4A1A)))
        BADGE_BETA -> Brush.linearGradient(listOf(colors.success, colors.success))
        BADGE_DEVELOPER -> Brush.linearGradient(listOf(Color(0xFF00B4D8), Color(0xFF0077B6)))
        else -> Brush.linearGradient(listOf(colors.accent, colors.accent))
    }
    val glyphColor = if (colors.isDark) Color(0xFF14121F) else Color.White
    val letter = badgeGlyph(badge)

    Box(
        modifier = modifier.size(size).drawBehind {
            drawSeal(brush)
            // Only the marks with no letter of their own take the check.
            if (letter == null) drawCheck(glyphColor)
        },
        contentAlignment = Alignment.Center,
    ) {
        // A letter rather than a check — these say "this is what they are", not
        // "this is verified", and the two should not be distinguishable by
        // colour alone.
        if (letter != null) {
            Text(
                letter,
                style = MaterialTheme.typography.labelSmall.copy(
                    // "<>" is two glyphs in the space one usually takes.
                    fontSize = (size.value * if (letter.length > 1) 0.42f else 0.62f).sp,
                    fontWeight = FontWeight.Bold,
                    lineHeight = (size.value * 0.62f).sp,
                ),
                color = glyphColor,
            )
        }
    }
}

/**
 * Every badge somebody holds, in the order the platform ranks them.
 *
 * Capped at three. Past that a name row turns into a trophy cabinet and the
 * name itself stops being the thing you read — and the ones that matter most
 * are first, so what gets dropped is what mattered least.
 */
@Composable
fun BadgeMarks(
    badges: List<String>,
    modifier: Modifier = Modifier,
    size: Dp = 15.dp,
    max: Int = 3,
) {
    val ordered = BADGE_PRECEDENCE.filter { badges.contains(it) }.take(max)
    if (ordered.isEmpty()) return
    Row(
        modifier = modifier,
        horizontalArrangement = Arrangement.spacedBy(3.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        ordered.forEach { BadgeMark(it, size = size) }
    }
}

/**
 * What somebody actually holds, whichever field the server filled in.
 *
 * A build talking to a server that predates the array sees only `badge`, and a
 * user cached before the field existed decodes with an empty one. Reading both
 * is what stops a badge disappearing during the deploy in between.
 */
fun heldBadges(user: gg.yappy.app.data.FullUser): List<String> =
    if (user.badges.isNotEmpty()) user.badges else listOfNotNull(user.badge)

/** Mirrors `BADGE_PRECEDENCE` on the server: which mark speaks first. */
private val BADGE_PRECEDENCE = listOf(
    BADGE_STAFF,
    BADGE_PARTNER,
    BADGE_VERIFIED,
    BADGE_YAPPER,
    BADGE_DEVELOPER,
    BADGE_BETA,
)

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
 * "BOT", next to a name.
 *
 * Knowing a message came from software is not a nicety — it is the difference
 * between advice and an advertisement. It lived only on the chat bubble, so a
 * bot was indistinguishable from a person everywhere else: in the chat list, in
 * a member list, on its own profile. Anywhere a name is drawn, this is part of
 * the name.
 */
@Composable
fun BotTag(modifier: Modifier = Modifier, size: Dp = 15.dp) {
    val colors = LocalNeuColors.current
    // Tracks the marks it sits beside rather than a fixed size, so it neither
    // towers over a 13dp badge nor vanishes beside a 20dp one.
    val scaled = with(LocalDensity.current) { (size * 0.62f).toSp() }
    val fontSize = if (scaled.value < 8f) 8.sp else scaled

    Box(
        modifier
            .clip(RoundedCornerShape(4.dp))
            .background(colors.accent)
            .padding(horizontal = 4.dp, vertical = 1.dp),
    ) {
        Text(
            "BOT",
            fontSize = fontSize,
            fontWeight = FontWeight.Bold,
            color = colors.onAccent,
            maxLines = 1,
        )
    }
}

/**
 * Everything that goes after a name, in a fixed order: affiliation first (whose
 * it is), then the badge (what they are), then BOT (what it is). Emits nothing
 * at all when there is nothing to show, so it can be dropped into any row
 * without disturbing layout.
 */
@Composable
fun IdentityMarks(
    user: PublicUser,
    modifier: Modifier = Modifier,
    size: Dp = 15.dp,
    /** The chat bubble draws its own, beside the sender name it assembles. */
    showsBot: Boolean = true,
) {
    val bot = showsBot && user.isBot
    if (user.badge == null && user.badges.isEmpty() && user.affiliation == null && !bot) return
    Row(
        modifier = modifier,
        horizontalArrangement = Arrangement.spacedBy(3.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        AffiliateMark(user.affiliation, size = size)
        // Every mark they hold, falling back to the single field — which is
        // what a server that predates the array sends, and what a user cached
        // before it existed still has.
        if (user.badges.isNotEmpty()) BadgeMarks(user.badges, size = size)
        else BadgeMark(user.badge, size = size)
        if (bot) BotTag(size = size)
    }
}
