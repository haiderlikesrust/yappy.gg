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
    outgoing = Color(0xFF6C5CE7),
    onOutgoing = Color(0xFFFFFFFF),
    incoming = Color(0xFFF8F7FD),
    // Identical to the surface: the light theme keeps the single-surface rule.
    surfaceRaised = Color(0xFFEBE9F4),
    surfaceRecessed = Color(0xFFEBE9F4),
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
    outgoing = Color(0xFF6C5CE7),
    onOutgoing = Color(0xFFFFFFFF),
    incoming = Color(0xFF2D2940),
    // Small steps on purpose. Enough that a field has an edge without looking
    // at it directly; not so much that the sheet turns into stacked panels.
    surfaceRaised = Color(0xFF2A2638),
    surfaceRecessed = Color(0xFF1B1926),
    isDark = true,
)
