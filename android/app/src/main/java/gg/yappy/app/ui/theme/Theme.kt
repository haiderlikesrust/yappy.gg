package gg.yappy.app.ui.theme

import android.app.Activity
import android.content.res.Configuration
import android.content.res.Resources
import android.graphics.Color as AndroidColor
import android.graphics.drawable.ColorDrawable
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.dp
import androidx.core.view.WindowCompat

val LocalNeuColors = staticCompositionLocalOf { LightNeuColors }

/** Shorthand: `Neu.colors` reads better at call sites than the CompositionLocal. */
val neuColors: NeuColors
    @Composable get() = LocalNeuColors.current

enum class ThemePreference {
    System, Light, Dark;

    companion object {
        /** The stored preference string, as [gg.yappy.app.data.SessionStore.theme] spells it. */
        fun from(name: String): ThemePreference = when (name) {
            "dark" -> Dark
            "system" -> System
            else -> Light
        }
    }
}

/**
 * Whether [themeName] resolves to the dark palette on this device — the same
 * decision [YappyTheme] makes, but answerable before Compose exists.
 */
fun resolveDark(themeName: String, resources: Resources): Boolean = when (ThemePreference.from(themeName)) {
    ThemePreference.Dark -> true
    ThemePreference.Light -> false
    ThemePreference.System ->
        resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES
}

/**
 * Transparent bars whose icons follow the *account's* theme, not the phone's.
 *
 * `enableEdgeToEdge()` with no arguments reads system night mode to pick icon
 * colour, and yappy's theme is a preference: a dark handset running the light
 * sheet got white status-bar icons over lavender. Both `light` and `dark`
 * here are the explicit forms, which ignore night mode entirely.
 */
fun systemBarStyle(dark: Boolean): SystemBarStyle =
    if (dark) {
        SystemBarStyle.dark(AndroidColor.TRANSPARENT)
    } else {
        SystemBarStyle.light(AndroidColor.TRANSPARENT, AndroidColor.TRANSPARENT)
    }

/**
 * Paint the window in the account's theme before Compose exists, and set the
 * bars to match. Returns whether that theme is dark, so the caller can seed
 * its first composition with the same answer and never flash the other one.
 *
 * The XML windowBackground follows the system's day/night, but the theme is
 * an account preference — set the app to Dark on a light-mode phone and every
 * cold start flashed a light window until the first composition. Shared by the
 * main activity and the bubble, which used to skip it and flash blue-grey.
 */
fun ComponentActivity.paintWindowForTheme(themeName: String): Boolean {
    val dark = resolveDark(themeName, resources)
    window.setBackgroundDrawable(
        ColorDrawable((if (dark) DarkNeuColors.surface else LightNeuColors.surface).toArgb()),
    )
    applySystemBars(dark)
    return dark
}

/**
 * The one writer of system-bar appearance.
 *
 * Both halves in a single call — the activity-level style through
 * `enableEdgeToEdge`, and the live controller flags — so the pre-Compose
 * paint, the theme's SideEffect and the splash hand-over can never set the
 * bars two different ways. Explicit styles throughout, because the no-argument
 * `enableEdgeToEdge()` reads system night mode and the theme is an account
 * preference: whoever writes last must write the account's answer.
 */
fun ComponentActivity.applySystemBars(dark: Boolean) {
    enableEdgeToEdge(statusBarStyle = systemBarStyle(dark), navigationBarStyle = systemBarStyle(dark))
    val controller = WindowCompat.getInsetsController(window, window.decorView)
    controller.isAppearanceLightStatusBars = !dark
    controller.isAppearanceLightNavigationBars = !dark
}

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
            val activity = view.context as Activity
            // Edge-to-edge with transparent bars: the neumorphic sheet should run
            // under the status bar, otherwise it reads as a card on a backdrop.
            WindowCompat.setDecorFitsSystemWindows(activity.window, false)
            // The activity painted the bars for the stored theme before Compose
            // existed; this is the live half, for the moment the preference
            // changes in Settings. The same writer as that paint and as the
            // splash hand-over, so no two paths can disagree — the explicit
            // style is authoritative, whatever night mode says.
            (activity as? ComponentActivity)?.applySystemBars(dark)
        }
    }

    CompositionLocalProvider(LocalNeuColors provides colors) {
        MaterialTheme(
            colorScheme = material,
            typography = YappyTypography,
            /*
             * Menus draw with `shapes.extraSmall`, and Material's default is
             * a 4dp corner — which made every dropdown the one sharp-edged
             * rectangle in an app where even the code blocks are rounded.
             * The colour mapping above already dressed them; the corners
             * were the tell that the panel was foreign.
             */
            shapes = MaterialTheme.shapes.copy(
                extraSmall = RoundedCornerShape(14.dp),
            ),
            content = content,
        )
    }
}
