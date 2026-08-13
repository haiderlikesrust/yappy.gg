package gg.yappy.app

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.drawable.ColorDrawable
import android.os.Build
import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import gg.yappy.app.data.DeepLink
import gg.yappy.app.data.clearMessageNotifications
import gg.yappy.app.ui.YappyRoot
import gg.yappy.app.ui.settings.AppLockGate
import gg.yappy.app.ui.settings.LocalAppLock
import gg.yappy.app.ui.theme.ThemePreference
import gg.yappy.app.ui.util.ClockStyle
import gg.yappy.app.ui.util.ScreenshotWatcher
import gg.yappy.app.ui.theme.YappyTheme
import gg.yappy.app.ui.theme.neuColors
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking

/**
 * `FragmentActivity` rather than `ComponentActivity`: `BiometricPrompt` hosts
 * itself in a fragment and will not attach to anything else. It is a superclass
 * of `ComponentActivity`, so `setContent` and the result APIs are unaffected.
 */
class MainActivity : FragmentActivity() {

    private lateinit var lock: AppLockGate

    /**
     * Asked once, after sign-in rather than at first launch.
     *
     * A prompt on the very first screen, before the person has seen a single
     * message, is the one most reliably denied — and on Android 13+ two
     * dismissals make the decision permanent with no way back except Settings.
     */
    private val notificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) {
                lifecycleScope.launch {
                    (application as YappyApplication).container.push.register()
                }
            }
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        /**
         * Before super.onCreate, per the SplashScreen contract.
         *
         * The exit is the half of a splash that decides how it feels: the
         * default is a hard cut, one frame the mark and the next the app. The
         * mark lifts away instead — scales up and fades over a fifth of a
         * second — so the splash hands over rather than disappears.
         */
        val splash = installSplashScreen()
        splash.setOnExitAnimationListener { provider ->
            val icon = provider.iconView
            icon.animate()
                .scaleX(1.6f).scaleY(1.6f)
                .alpha(0f)
                .setDuration(200L)
                .withEndAction { provider.remove() }
                .start()
        }
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        val container = (application as YappyApplication).container
        lock = AppLockGate(container.session, container.scope)

        /**
         * Paint the window in the *account's* theme before Compose exists.
         *
         * The XML windowBackground follows the system's day/night, but yappy's
         * theme is an account preference — set the app to Dark on a light-mode
         * phone and every cold start flashed a white window until the first
         * composition. One synchronous preference read closes that gap. (The
         * pre-process splash frame still follows the system; Android offers no
         * hook earlier than this.)
         */
        runBlocking {
            val dark = when (container.session.theme.first()) {
                "dark" -> true
                "light" -> false
                else ->
                    resources.configuration.uiMode and
                        Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES
            }
            window.setBackgroundDrawable(
                ColorDrawable(if (dark) 0xFF232030.toInt() else 0xFFEBE9F4.toInt())
            )
        }

        lifecycleScope.launch {
            container.bootstrap()
            // Seeded after bootstrap has read the stored flag, so the very
            // first frame is already covered when the lock is on.
            lock.syncFromStore()
        }

        // The link that started us, if any. Held in the container rather than
        // handled here, because at this point we may not even know yet whether
        // anyone is signed in.
        container.offerLink(DeepLink.parse(intent?.data))
        offerShare(intent)

        // The socket lives with the foreground. Holding it open in the
        // background drains battery for events push already covers, and Android
        // will kill it anyway once the process is cached.
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                if (container.session.currentAccess() != null) {
                    container.gateway.connect()
                    askForNotifications()
                    // Whatever arrived while away has been read now — or is
                    // about to be. A stale stack of them is just clutter.
                    clearMessageNotifications(this@MainActivity)
                }
                try {
                    kotlinx.coroutines.awaitCancellation()
                } finally {
                    container.gateway.disconnect()
                }
            }
        }

        setContent {
            // Light is the fallback, matching the stored default. Reading it
            // as "system" here would flash the dark theme on every cold start
            // for anyone whose handset is dark.
            val themeName by container.session.theme.collectAsState(initial = "light")
            val preference = when (themeName) {
                "dark" -> ThemePreference.Dark
                "system" -> ThemePreference.System
                else -> ThemePreference.Light
            }

            CompositionLocalProvider(
                LocalContainer provides container,
                LocalAppLock provides lock,
            ) {
                YappyTheme(preference) {
                    Box(Modifier.fillMaxSize().background(neuColors.surface)) {
                        YappyRoot()
                    }
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        // Cheap, and it catches the only path that matters: leaving to change
        // the 12/24-hour setting in system settings and coming back.
        ClockStyle.refresh(this)
        // Only while we are the app on screen — a capture of somebody else's
        // app is not ours to report.
        ScreenshotWatcher.start(this)
    }

    override fun onPause() {
        super.onPause()
        ScreenshotWatcher.stop(this)
    }

    override fun onStop() {
        super.onStop()
        lock.lockIfEnabled()
    }

    private fun askForNotifications() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        val granted = ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        if (granted) return
        runCatching { notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS) }
    }

    /**
     * A second link, arriving while the app is already running.
     *
     * The activity is `singleTask`, so Android reuses this instance instead of
     * creating another; without this the second invite someone taps would do
     * nothing at all. `setIntent` keeps `getIntent()` honest for anything that
     * reads it later.
     */
    /**
     * A share-sheet pick. The OS names the conversation via EXTRA_SHORTCUT_ID
     * (that is the whole contract of a share target); anything ACTION_SEND
     * without one was shared at the app generally, and there is no UI for
     * "pick a chat to receive this" yet, so it is deliberately dropped rather
     * than guessed at.
     */
    private fun offerShare(intent: Intent?) {
        if (intent?.action != Intent.ACTION_SEND) return
        val container = (application as YappyApplication).container
        val conversationId = intent.getStringExtra(Intent.EXTRA_SHORTCUT_ID) ?: return

        val uri = androidx.core.content.IntentCompat.getParcelableExtra(
            intent,
            Intent.EXTRA_STREAM,
            android.net.Uri::class.java,
        )
        val text = intent.getStringExtra(Intent.EXTRA_TEXT)
        if (uri == null && text.isNullOrBlank()) return

        container.offerShare(AppContainer.PendingShare(conversationId, text, uri))
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        (application as YappyApplication).container.offerLink(DeepLink.parse(intent.data))
        offerShare(intent)
    }
}
