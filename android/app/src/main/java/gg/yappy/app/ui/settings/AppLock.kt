package gg.yappy.app.ui.settings

import android.content.Context
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Fingerprint
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.fragment.app.FragmentActivity
import gg.yappy.app.data.SessionStore
import gg.yappy.app.ui.components.LogoMark
import gg.yappy.app.ui.components.NeuButton
import gg.yappy.app.ui.theme.neuColors
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

val LocalAppLock = staticCompositionLocalOf<AppLockGate> {
    error("AppLockGate not provided")
}

/**
 * Biometric unlock in front of the app.
 *
 * Deliberately a *screen* lock and not an encryption boundary: the messages are
 * already on the device and the tokens are already in DataStore, so what this
 * buys is privacy from someone holding your unlocked phone, not protection from
 * someone imaging its storage. Saying so plainly in the subtitle is better than
 * implying a guarantee it cannot make.
 */
class AppLockGate(
    private val store: SessionStore,
    private val scope: CoroutineScope,
) {

    private val _locked = MutableStateFlow(false)

    /** True when the lock screen should be covering everything. */
    val locked: StateFlow<Boolean> = _locked.asStateFlow()

    private val _failed = MutableStateFlow(false)

    /** Set when the last attempt failed, so the screen can offer a retry rather
     *  than sitting there looking broken. */
    val failed: StateFlow<Boolean> = _failed.asStateFlow()

    private val _enabled = MutableStateFlow(false)
    val enabled: StateFlow<Boolean> = _enabled.asStateFlow()

    /** Guards against the double prompt you get when the activity resumes twice
     *  — which it does when the biometric sheet itself pauses and restores it. */
    @Volatile
    private var authenticating = false

    /**
     * Called once the stored flag has been read.
     *
     * Locked from that first frame when the setting is on. Starting unlocked
     * and locking later shows the conversation list for a frame, which is
     * exactly the thing the lock exists to prevent — so [SessionStore.bootstrap]
     * runs before the first composition and this only publishes what it found.
     */
    fun syncFromStore() {
        _enabled.value = store.appLock
        if (store.appLock) _locked.value = true
    }

    fun setEnabled(on: Boolean) {
        _enabled.value = on
        // Turning it on must not lock you out of the screen you just used to
        // turn it on; it takes effect the next time the app is backgrounded.
        if (!on) _locked.value = false
        scope.launch { store.setAppLock(on) }
    }

    fun lockIfEnabled() {
        if (!store.appLock) return
        _locked.value = true
        _failed.value = false
    }

    /**
     * Prompt.
     *
     * `DEVICE_CREDENTIAL` alongside the biometric classes on purpose: it falls
     * back to the PIN or pattern on its own, so a failed or unavailable
     * fingerprint still has a way through rather than stranding someone behind
     * a sensor that has stopped recognising them.
     */
    fun unlock(activity: FragmentActivity) {
        if (!_locked.value || authenticating) return
        authenticating = true

        val prompt = BiometricPrompt(
            activity,
            ContextCompatExecutor(activity),
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    authenticating = false
                    _locked.value = false
                    _failed.value = false
                }

                override fun onAuthenticationError(code: Int, message: CharSequence) {
                    authenticating = false
                    // A cancel is not a failure — the person chose to back out,
                    // and telling them "that didn't work" would be a lie.
                    _failed.value = code != BiometricPrompt.ERROR_USER_CANCELED &&
                        code != BiometricPrompt.ERROR_NEGATIVE_BUTTON &&
                        code != BiometricPrompt.ERROR_CANCELED
                }

                override fun onAuthenticationFailed() {
                    // Not terminal: the sensor will keep listening. Only the
                    // error callback ends the attempt.
                    _failed.value = true
                }
            },
        )

        runCatching {
            prompt.authenticate(
                BiometricPrompt.PromptInfo.Builder()
                    .setTitle("Unlock yappy")
                    .setSubtitle("Use your fingerprint, face or screen lock")
                    .setAllowedAuthenticators(ALLOWED)
                    .build(),
            )
        }.onFailure {
            authenticating = false
            _failed.value = true
        }
    }

    companion object {
        private const val ALLOWED = BiometricManager.Authenticators.BIOMETRIC_WEAK or
            BiometricManager.Authenticators.DEVICE_CREDENTIAL

        /**
         * Whether this device can do it at all. A device with no screen lock
         * set cannot, and offering the switch there would strand someone in a
         * lock they cannot open.
         */
        fun available(context: Context): Boolean =
            BiometricManager.from(context).canAuthenticate(ALLOWED) ==
                BiometricManager.BIOMETRIC_SUCCESS
    }
}

/** The prompt wants an Executor; the main one is what the callbacks expect. */
private class ContextCompatExecutor(private val context: Context) : java.util.concurrent.Executor {
    private val handler = android.os.Handler(android.os.Looper.getMainLooper())
    override fun execute(command: Runnable) {
        handler.post(command)
    }
}

/** The cover shown while locked. */
@Composable
fun AppLockScreen(failed: Boolean, onUnlock: () -> Unit) {
    val colors = neuColors

    Box(
        Modifier.fillMaxSize().background(colors.surface),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            Modifier.padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            LogoMark(height = 40.dp)

            Text(
                "yappy is locked",
                style = MaterialTheme.typography.titleMedium,
                color = colors.textPrimary,
            )

            Text(
                if (failed) "That didn't work. Try again." else "Unlock to see your chats.",
                style = MaterialTheme.typography.bodyMedium,
                color = if (failed) colors.danger else colors.textTertiary,
                textAlign = TextAlign.Center,
            )

            NeuButton(
                onClick = onUnlock,
                accent = true,
                modifier = Modifier.widthIn(max = 220.dp),
            ) {
                Icon(
                    Icons.Rounded.Fingerprint,
                    null,
                    tint = colors.onAccent,
                    modifier = Modifier.size(18.dp),
                )
                Spacer(Modifier.width(8.dp))
                Text("Unlock", style = MaterialTheme.typography.labelLarge, color = colors.onAccent)
            }

            Spacer(Modifier.height(0.dp))
        }
    }
}
