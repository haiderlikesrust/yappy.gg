package gg.yappy.app

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.material3.SnackbarHostState
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import gg.yappy.app.ui.chat.ChatScreen
import gg.yappy.app.ui.components.LocalSnackbar
import gg.yappy.app.ui.components.NeuSnackbarHost
import gg.yappy.app.ui.theme.ThemePreference
import gg.yappy.app.ui.theme.YappyTheme
import gg.yappy.app.ui.theme.neuColors
import gg.yappy.app.ui.theme.paintWindowForTheme
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking

/**
 * One conversation in a chat bubble — the floating head a notification can
 * expand into without leaving whatever app is underneath.
 *
 * A separate activity because a bubble is an embedded window and the manifest
 * has to say so (`allowEmbedded`, `resizeableActivity`); MainActivity is the
 * whole app with navigation, and hoisting it into a 300dp float would bubble
 * the entire interface. This hosts exactly one [ChatScreen].
 *
 * Every navigation the chat can ask for — a profile, the group page, a call, a
 * thread — deliberately breaks out to the full app: a bubble is for reading
 * and replying, and anything deeper deserves the real screen. The bubble
 * itself stays open; the app opens over it. Each breaks out to the thing that
 * was tapped, not to the conversation: landing on the chat you were already
 * reading, one tap short of where you asked to go, read as the tap doing
 * nothing.
 */
class BubbleActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val conversationId = intent?.data?.lastPathSegment
        if (conversationId.isNullOrBlank()) {
            finish()
            return
        }

        val container = (application as YappyApplication).container

        // The same pre-Compose paint MainActivity does. A bubble expands in
        // one frame, so the XML window colour was the whole first impression
        // — and it followed the phone's night mode, not the account's theme.
        val initialTheme = runBlocking { container.session.theme.first() }
        paintWindowForTheme(initialTheme)

        setContent {
            val themeName by container.session.theme.collectAsState(initial = initialTheme)
            val preference = ThemePreference.from(themeName)

            // A bubble has no shell: MainActivity's YappyRoot installs the app's
            // snackbar host around its navigation, and nothing here does. The
            // chat itself no longer needs it — ChatScreen provides its own
            // LocalSnackbar with a host above the composer, and the forum
            // branch that returns early before that provider reports inside
            // its own sheet now — but the local's default *throws*, so this
            // stays as the floor for anything composed outside the chat's
            // provider. Cheap insurance against a crash on first composition.
            val snackbar = remember { SnackbarHostState() }
            CompositionLocalProvider(
                LocalContainer provides container,
                LocalSnackbar provides snackbar,
            ) {
                YappyTheme(preference) {
                    Box(Modifier.fillMaxSize().background(neuColors.surface)) {
                        ChatScreen(
                            conversationId = conversationId,
                            onBack = { finish() },
                            onOpenProfile = { breakOut("yappy://user/$it") },
                            onOpenGroup = { breakOut("yappy://group/$it") },
                            onOpenCall = { breakOut("yappy://call/$it") },
                            onOpenThread = { breakOut("yappy://thread/$conversationId/$it") },
                            // The notification this bubble hangs off must stay:
                            // Android removes a bubble whose notification is
                            // cancelled, and opening the bubble already hides it.
                            dismissesNotification = false,
                        )
                        NeuSnackbarHost(
                            hostState = snackbar,
                            modifier = Modifier
                                .align(Alignment.BottomCenter)
                                .navigationBarsPadding()
                                .imePadding(),
                        )
                    }
                }
            }
        }
    }

    private fun breakOut(uri: String) {
        startActivity(
            Intent(Intent.ACTION_VIEW, Uri.parse(uri), this, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
    }
}
