package gg.yappy.app.ui.theme

import androidx.compose.runtime.Immutable
import androidx.compose.ui.graphics.Color

/**
 * Neumorphism has one hard requirement: the surface, the light shadow and the
 * dark shadow must all derive from the *same* base colour. The illusion is that
 * every element is extruded from a single sheet of material, and it collapses
 * the moment a card sits on a different background than its shadows assume.
 *
 * So there is exactly one surface colour per theme. Elevation is expressed with
 * shadows, never with a lighter or darker fill — which is why this palette has
 * no `surfaceVariant`, `surfaceContainerHigh`, or the rest of the Material 3
 * elevation ladder.
 */
@Immutable
data class NeuColors(
    val surface: Color,
    /** Highlight, cast from the top-left. */
    val light: Color,
    /** Shadow, cast to the bottom-right. */
    val dark: Color,
    val textPrimary: Color,
    val textSecondary: Color,
    val textTertiary: Color,
    val accent: Color,
    val accentSoft: Color,
    val onAccent: Color,
    val success: Color,
    val danger: Color,
    val warning: Color,
    /**
     * "You were called." The brand yellow — the tongue-out mark's own
     * colour — not the danger red.
     *
     * Red on these violet surfaces reads as an error, and a mention is
     * not one: it is the single most ordinary reason to open the app.
     * Yellow is loud against both themes without borrowing the alarm
     * register, and it is distinctively ours. Dark ink in both themes,
     * because yellow is bright in both.
     */
    val mention: Color,
    val onMention: Color,
    /** Bubble for messages you sent. */
    val outgoing: Color,
    val onOutgoing: Color,
    /**
     * Flat fill for received bubbles and other *content* tints. Content is the
     * one deliberate exception to the single-surface rule: dozens of bubbles
     * each casting two shadows is visual noise, so bubbles are flat and only
     * the chrome (composer, buttons, cards) keeps the neumorphic treatment.
     */
    val incoming: Color,

    /**
     * Fills for extruded and recessed chrome.
     *
     * In the light theme both are the surface itself, and the shadows do all
     * the work — that is the single-surface rule above, and it holds there
     * because a shadow on a near-white sheet is a large *visible* change while
     * being a small relative one.
     *
     * The dark theme cannot honour it. Against #232030 the same shadows are a
     * ±40% relative luminance swing, so at a strength that makes an input
     * legible the raised controls grow halos, and at a strength that kills the
     * halos an input becomes an invisible rectangle. No single intensity
     * satisfies both. So in the dark theme these carry a small tonal offset
     * and the shadows only sculpt what the fill has already separated.
     */
    val surfaceRaised: Color,
    val surfaceRecessed: Color,

    /**
     * Translucent tint for small containers that sit *on* other fills — reply
     * previews inside bubbles, quote strips, chips. These were written as
     * `dark.copy(alpha = …)`, which works in the light theme and is a no-op in
     * the dark one: #14121D at 8% over #232030 moves the pixel almost nowhere,
     * so every one of those containers simply vanished. In dark the tint must
     * come from the *light* side.
     */
    val veil: Color,
    /** Separator lines, for the same reason — dark-on-dark divides nothing. */
    val hairline: Color,

    /**
     * The other end of the brand gradient — the teal the logo and the home
     * wordmark fade into. Same in both themes: it is a mark, not a surface.
     * A token so the gradient is written once, not as a hex in every header.
     */
    val brandTeal: Color,

    val isDark: Boolean,
)

/**
 * Light theme.
 *
 * The surface is a desaturated *lavender*-grey rather than a neutral or pure
 * white: neumorphism needs headroom on both sides of the base colour, and the
 * violet cast is the brand — the accent gradient reads as native to the sheet
 * instead of printed on it.
 */
val LightNeuColors = NeuColors(
    surface = Color(0xFFEBE9F4),
    light = Color(0xFFFFFFFF),
    dark = Color(0xFFACA5C8),
    textPrimary = Color(0xFF2B2739),
    textSecondary = Color(0xFF5D5876),
    textTertiary = Color(0xFF8F8AA8),
    accent = Color(0xFF6C5CE7),
    accentSoft = Color(0xFFE1DCFB),
    onAccent = Color(0xFFFFFFFF),
    success = Color(0xFF17B978),
    danger = Color(0xFFE5484D),
    warning = Color(0xFFF5A524),
    mention = Color(0xFFFFD84A),
    onMention = Color(0xFF2B2739),
    outgoing = Color(0xFF6C5CE7),
    onOutgoing = Color(0xFFFFFFFF),
    incoming = Color(0xFFF8F7FD),
    // Identical to the surface: the light theme keeps the single-surface rule.
    surfaceRaised = Color(0xFFEBE9F4),
    surfaceRecessed = Color(0xFFEBE9F4),
    // The same shadow-lavender the old alpha fills resolved to, precomputed.
    veil = Color(0x17ACA5C8),
    hairline = Color(0x2EACA5C8),
    brandTeal = Color(0xFF00CEC9),
    isDark = false,
)

/**
 * Dark theme: violet-charcoal, not anonymous near-black-blue.
 *
 * The classic mistake is a near-black surface: with nothing above it, the
 * highlight cannot read and every element looks merely embossed on one side.
 * #232030 keeps that headroom while carrying the brand's violet undertone —
 * this is the single biggest "whose app is this" signal in the dark theme.
 */
val DarkNeuColors = NeuColors(
    surface = Color(0xFF232030),
    light = Color(0xFF302C40),
    dark = Color(0xFF14121D),
    textPrimary = Color(0xFFEFEDF6),
    textSecondary = Color(0xFFACA7C2),
    textTertiary = Color(0xFF746E8E),
    accent = Color(0xFF8B7CFF),
    accentSoft = Color(0xFF35304F),
    onAccent = Color(0xFF14121F),
    success = Color(0xFF3DD68C),
    danger = Color(0xFFFF6369),
    warning = Color(0xFFFFB224),
    mention = Color(0xFFFFD84A),
    onMention = Color(0xFF2B2739),
    outgoing = Color(0xFF6C5CE7),
    onOutgoing = Color(0xFFFFFFFF),
    incoming = Color(0xFF2D2940),
    // Small steps on purpose. Enough that a field has an edge without looking
    // at it directly; not so much that the sheet turns into stacked panels.
    surfaceRaised = Color(0xFF2A2638),
    surfaceRecessed = Color(0xFF1B1926),
    // From the light side: white at 8%/10% reads on violet-charcoal exactly the
    // way shadow-lavender reads on the light sheet.
    veil = Color(0x14FFFFFF),
    hairline = Color(0x1AFFFFFF),
    brandTeal = Color(0xFF00CEC9),
    isDark = true,
)
