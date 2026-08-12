package gg.yappy.app

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import gg.yappy.app.ui.chat.ChatScreen
import gg.yappy.app.ui.theme.ThemePreference
import gg.yappy.app.ui.theme.YappyTheme
import gg.yappy.app.ui.theme.neuColors

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
 * itself stays open; the app opens over it.
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

        setContent {
            val themeName by container.session.theme.collectAsState(initial = "light")
            val preference = when (themeName) {
                "dark" -> ThemePreference.Dark
                "system" -> ThemePreference.System
                else -> ThemePreference.Light
            }

            CompositionLocalProvider(LocalContainer provides container) {
                YappyTheme(preference) {
                    Box(Modifier.fillMaxSize().background(neuColors.surface)) {
                        ChatScreen(
                            conversationId = conversationId,
                            onBack = { finish() },
                            onOpenProfile = { breakOut("yappy://conversation/$conversationId") },
                            onOpenGroup = { breakOut("yappy://conversation/$conversationId") },
                            onOpenCall = { breakOut("yappy://call/$it") },
                            onOpenThread = { breakOut("yappy://conversation/$conversationId") },
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
