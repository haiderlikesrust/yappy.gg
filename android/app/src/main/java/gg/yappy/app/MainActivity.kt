package gg.yappy.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import gg.yappy.app.ui.YappyRoot
import gg.yappy.app.ui.theme.ThemePreference
import gg.yappy.app.ui.theme.YappyTheme
import gg.yappy.app.ui.theme.neuColors
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        val container = (application as YappyApplication).container

        lifecycleScope.launch { container.bootstrap() }

        // The socket lives with the foreground. Holding it open in the
        // background drains battery for events push already covers, and Android
        // will kill it anyway once the process is cached.
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                if (container.session.currentAccess() != null) container.gateway.connect()
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

            CompositionLocalProvider(LocalContainer provides container) {
                YappyTheme(preference) {
                    Box(Modifier.fillMaxSize().background(neuColors.surface)) {
                        YappyRoot()
                    }
                }
            }
        }
    }
}
