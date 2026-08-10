package gg.yappy.app.ui.theme

import android.app.Activity
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat

val LocalNeuColors = staticCompositionLocalOf { LightNeuColors }

/** Shorthand: `Neu.colors` reads better at call sites than the CompositionLocal. */
val neuColors: NeuColors
    @Composable get() = LocalNeuColors.current

enum class ThemePreference { System, Light, Dark }

@Composable
fun YappyTheme(
    preference: ThemePreference = ThemePreference.System,
    content: @Composable () -> Unit,
) {
    val dark = when (preference) {
        ThemePreference.System -> isSystemInDarkTheme()
        ThemePreference.Light -> false
        ThemePreference.Dark -> true
    }

    val colors = if (dark) DarkNeuColors else LightNeuColors

    // Material 3 is still underneath for text selection, ripples and the few
    // Material components used directly, so its scheme is kept consistent with
    // the neumorphic palette rather than left at the default purple.
    /**
     * The container family matters as much as the headline slots. DropdownMenu
     * draws `surfaceContainer`, the Material time picker draws
     * `surfaceContainerHighest` and `primaryContainer`, sheets fall back to
     * `surfaceContainerLow` — and none of those were mapped, so every one of
     * them rendered Material's baseline grey-black instead of the violet
     * charcoal: foreign panels floating on a branded sheet. `surfaceTint` is
     * pinned to the surface so tonal elevation cannot smear accent over any of
     * it.
     */
    val material = if (dark) {
        darkColorScheme(
            primary = colors.accent,
            onPrimary = colors.onAccent,
            primaryContainer = colors.accentSoft,
            onPrimaryContainer = colors.textPrimary,
            background = colors.surface,
            onBackground = colors.textPrimary,
            surface = colors.surface,
            onSurface = colors.textPrimary,
            surfaceVariant = colors.surfaceRaised,
            onSurfaceVariant = colors.textSecondary,
            surfaceTint = colors.surface,
            surfaceContainerLowest = colors.surfaceRecessed,
            surfaceContainerLow = colors.surface,
            surfaceContainer = colors.surfaceRaised,
            surfaceContainerHigh = colors.incoming,
            surfaceContainerHighest = colors.accentSoft,
            outline = colors.textTertiary,
            outlineVariant = colors.light,
            error = colors.danger,
        )
    } else {
        lightColorScheme(
            primary = colors.accent,
            onPrimary = colors.onAccent,
            primaryContainer = colors.accentSoft,
            onPrimaryContainer = colors.textPrimary,
            background = colors.surface,
            onBackground = colors.textPrimary,
            surface = colors.surface,
            onSurface = colors.textPrimary,
            surfaceVariant = colors.surface,
            onSurfaceVariant = colors.textSecondary,
            surfaceTint = colors.surface,
            surfaceContainerLowest = colors.surface,
            surfaceContainerLow = colors.surface,
            surfaceContainer = colors.surface,
            surfaceContainerHigh = colors.incoming,
            surfaceContainerHighest = colors.incoming,
            outline = colors.textTertiary,
            outlineVariant = colors.dark,
            error = colors.danger,
        )
    }

    val view = LocalView.current
    if (!view.isInEditMode) {
        SideEffect {
            val window = (view.context as Activity).window
            // Edge-to-edge with transparent bars: the neumorphic sheet should run
            // under the status bar, otherwise it reads as a card on a backdrop.
            WindowCompat.setDecorFitsSystemWindows(window, false)
            val controller = WindowCompat.getInsetsController(window, view)
            controller.isAppearanceLightStatusBars = !dark
            controller.isAppearanceLightNavigationBars = !dark
        }
    }

    CompositionLocalProvider(LocalNeuColors provides colors) {
        MaterialTheme(
            colorScheme = material,
            typography = YappyTypography,
            content = content,
        )
    }
}
