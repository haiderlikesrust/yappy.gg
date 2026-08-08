package gg.yappy.app.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.ExperimentalTextApi
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.unit.sp
import gg.yappy.app.R

/**
 * Type scale.
 *
 * Two voices, on purpose:
 *  - **Space Grotesk** for everything that names things — the wordmark,
 *    headlines, titles, buttons. This is where the app sounds like itself.
 *  - The system sans for body text, where reading speed beats personality.
 * One distinctive face used everywhere becomes noise; used only for display
 * it stays a signature. Slightly heavier weights than Material's defaults
 * across the board: on a low-contrast neumorphic sheet, Regular 14sp body
 * text starts to disappear. Medium is the floor below 16sp.
 */
@OptIn(ExperimentalTextApi::class)
private val Grotesk = FontFamily(
    Font(
        R.font.space_grotesk,
        weight = FontWeight.Medium,
        variationSettings = FontVariation.Settings(FontVariation.weight(500)),
    ),
    Font(
        R.font.space_grotesk,
        weight = FontWeight.SemiBold,
        variationSettings = FontVariation.Settings(FontVariation.weight(600)),
    ),
    Font(
        R.font.space_grotesk,
        weight = FontWeight.Bold,
        variationSettings = FontVariation.Settings(FontVariation.weight(700)),
    ),
)
private val trim = LineHeightStyle(
    alignment = LineHeightStyle.Alignment.Center,
    trim = LineHeightStyle.Trim.None,
)

val YappyTypography = Typography(
    displaySmall = TextStyle(
        fontFamily = Grotesk,
        fontWeight = FontWeight.Bold,
        fontSize = 32.sp,
        lineHeight = 40.sp,
        letterSpacing = (-0.5).sp,
        lineHeightStyle = trim,
    ),
    headlineMedium = TextStyle(
        fontFamily = Grotesk,
        fontWeight = FontWeight.Bold,
        fontSize = 26.sp,
        lineHeight = 34.sp,
        letterSpacing = (-0.3).sp,
        lineHeightStyle = trim,
    ),
    headlineSmall = TextStyle(
        fontFamily = Grotesk,
        fontWeight = FontWeight.SemiBold,
        fontSize = 21.sp,
        lineHeight = 28.sp,
        lineHeightStyle = trim,
    ),
    titleMedium = TextStyle(
        fontFamily = Grotesk,
        fontWeight = FontWeight.SemiBold,
        fontSize = 17.sp,
        lineHeight = 24.sp,
        lineHeightStyle = trim,
    ),
    titleSmall = TextStyle(
        fontFamily = Grotesk,
        fontWeight = FontWeight.Medium,
        fontSize = 15.sp,
        lineHeight = 20.sp,
        lineHeightStyle = trim,
    ),
    bodyLarge = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Normal,
        fontSize = 16.sp,
        lineHeight = 23.sp,
        lineHeightStyle = trim,
    ),
    bodyMedium = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Normal,
        fontSize = 14.sp,
        lineHeight = 20.sp,
        lineHeightStyle = trim,
    ),
    labelLarge = TextStyle(
        fontFamily = Grotesk,
        fontWeight = FontWeight.SemiBold,
        fontSize = 15.sp,
        lineHeight = 20.sp,
        letterSpacing = 0.1.sp,
        lineHeightStyle = trim,
    ),
    labelMedium = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Medium,
        fontSize = 13.sp,
        lineHeight = 17.sp,
        letterSpacing = 0.2.sp,
        lineHeightStyle = trim,
    ),
    labelSmall = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Medium,
        fontSize = 11.sp,
        lineHeight = 15.sp,
        letterSpacing = 0.3.sp,
        lineHeightStyle = trim,
    ),
)
