package gg.yappy.app

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.view.View
import android.view.WindowManager
import androidx.activity.compose.setContent
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
import gg.yappy.app.ui.YappyRoot
import gg.yappy.app.ui.settings.AppLockGate
import gg.yappy.app.ui.settings.LocalAppLock
import gg.yappy.app.ui.theme.ThemePreference
import gg.yappy.app.ui.util.ClockStyle
import gg.yappy.app.ui.util.ScreenshotWatcher
import gg.yappy.app.ui.theme.YappyTheme
import gg.yappy.app.ui.theme.applySystemBars
import gg.yappy.app.ui.theme.neuColors
import gg.yappy.app.ui.theme.paintWindowForTheme
import gg.yappy.app.ui.theme.resolveDark
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.delay
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
         * mark lifts away — scales up and fades over a fifth of a second — and
         * the plate behind it dissolves at the same time, so the splash hands
         * over rather than disappears. Animating only the icon left the dark
         * plate to hard-cut to the sheet underneath it.
         */
        val splash = installSplashScreen()
        splash.setOnExitAnimationListener { provider ->
            /*
             * Re-assert the account theme's bars before anything animates.
             *
             * The splash library resets them from the phone's night mode
             * right before handing over — its Impl31 applies the XML theme's
             * windowLightStatusBar just ahead of this listener — which is the
             * one moment the account theme was not the last writer: a light
             * account on a dark handset came up with white icons over
             * lavender on every cold start. Cold start only, because
             * recreation and in-app switches never go through the splash
             * exit; so one read of the stored theme here is enough. The
             * container is read through the application rather than captured,
             * because this lambda is registered before super.onCreate.
             */
            val theme = runBlocking { (application as YappyApplication).container.session.theme.first() }
            applySystemBars(resolveDark(theme, resources))

            provider.iconView.animate()
                .scaleX(1.6f).scaleY(1.6f)
                .alpha(0f)
                .setDuration(200L)
                .start()
            provider.view.animate()
                .alpha(0f)
                .setDuration(200L)
                .withEndAction { provider.remove() }
                .start()
        }
        super.onCreate(savedInstanceState)

        val container = (application as YappyApplication).container
        lock = AppLockGate(container.session, container.scope)

        /**
         * Hold the splash until we know whether anyone is signed in.
         *
         * Without this the splash lifts on the first frame, a spinner takes
         * its place while the token is read, and then the list or the sign-in
         * fades in: three states for one launch. The read is a few
         * milliseconds; the splash simply covers them. Bounded, so a
         * bootstrap that throws leaves a usable app rather than a splash that
         * never lifts.
         */
        val splashShownAt = SystemClock.elapsedRealtime()
        splash.setKeepOnScreenCondition {
            container.signedIn.value == null &&
                SystemClock.elapsedRealtime() - splashShownAt < SPLASH_HOLD_MAX_MS
        }
        // The condition above is only re-asked when the content tries to
        // draw, and a screen waiting on bootstrap has nothing to redraw for —
        // so the time bound was never consulted, and a slow or hung bootstrap
        // held the splash exactly as long as it liked (six seconds on a first
        // launch after install, while the profile compiled). One nudge at the
        // deadline makes the next frame happen, and with it the question.
        lifecycleScope.launch {
            delay(SPLASH_HOLD_MAX_MS)
            findViewById<View>(android.R.id.content)?.invalidate()
        }

        /**
         * Paint the window in the *account's* theme before Compose exists, and
         * set the system-bar icons to match. One synchronous preference read;
         * the same value seeds the first composition below so the two can
         * never disagree. (The pre-process splash frame still follows the
         * system; Android offers no hook earlier than this.)
         */
        val initialTheme = runBlocking { container.session.theme.first() }
        paintWindowForTheme(initialTheme)

        lifecycleScope.launch {
            container.bootstrap()
            // Seeded after bootstrap has read the stored flag, so the very
            // first frame is already covered when the lock is on.
            lock.syncFromStore()
        }

        /**
         * With the lock on, the Recents thumbnail must not show the chat.
         *
         * The lock engages in onStop, which is *after* the system has taken
         * its task snapshot — so the screen the lock exists to hide was the
         * one sitting in the app switcher. Android 13 has a switch for
         * exactly this; below it the only lever is FLAG_SECURE, which also
         * blocks screenshots. Accepted on those devices: someone who turned
         * the lock on asked for privacy, and a blank thumbnail is the point.
         */
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.CREATED) {
                lock.enabled.collect { enabled ->
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                        setRecentsScreenshotEnabled(!enabled)
                    } else if (enabled) {
                        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
                    } else {
                        window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
                    }
                }
            }
        }

        // The link or share that started us, if any. Held in the container
        // rather than handled here, because at this point we may not even know
        // yet whether anyone is signed in.
        //
        // First creation only: a rotation, fold or theme flip recreates the
        // activity with the same intent, and re-offering it replayed the link
        // through NavController.open — cutting the restored stack back to the
        // chat and dropping the thread reply rememberSaveable had just carried
        // across — or re-offered an already-sent share, reopening its confirm
        // sheet. A task relaunched from Recents re-delivers the root intent
        // with no saved state, so that is excluded by its flag as well. A
        // genuinely new link arrives in onNewIntent, which stays unconditional.
        if (savedInstanceState == null &&
            (intent?.flags ?: 0) and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY == 0
        ) {
            container.offerLink(DeepLink.parse(intent?.data))
            offerShare(intent)
        }

        // The socket lives with the foreground. Holding it open in the
        // background drains battery for events push already covers, and Android
        // will kill it anyway once the process is cached.
        //
        // Notifications are no longer swept here. Opening the app used to
        // cancel every message notification at once, including the ones for
        // chats nobody had looked at — the only reminder of a message never
        // seen. Each is now dismissed by the chat that opens it (ChatScreen),
        // and all of them together only on sign-out (AppContainer.signOut).
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                if (container.session.currentAccess() != null) {
                    container.gateway.connect()
                    askForNotifications()
                }
                try {
                    kotlinx.coroutines.awaitCancellation()
                } finally {
                    container.gateway.disconnect()
                }
            }
        }

        setContent {
            // Seeded with the value the window was just painted from, so the
            // first composition is already in the right theme — reading a
            // default here flashed it for anyone whose preference differed.
            val themeName by container.session.theme.collectAsState(initial = initialTheme)
            val preference = ThemePreference.from(themeName)

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

    /**
     * A second link, arriving while the app is already running.
     *
     * The activity is `singleTask`, so Android reuses this instance instead of
     * creating another; without this the second invite someone taps would do
     * nothing at all. `setIntent` keeps `getIntent()` honest for anything that
     * reads it later.
     */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        (application as YappyApplication).container.offerLink(DeepLink.parse(intent.data))
        offerShare(intent)
    }

    private companion object {
        const val SPLASH_HOLD_MAX_MS = 3_000L
    }
}
