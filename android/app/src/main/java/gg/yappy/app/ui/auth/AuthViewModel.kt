package gg.yappy.app.ui.auth

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import gg.yappy.app.AppContainer
import gg.yappy.app.BuildConfig
import gg.yappy.app.data.ApiException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

enum class AuthStep { Phone, Code, Profile }

data class AuthState(
    val step: AuthStep = AuthStep.Phone,
    val phone: String = "",
    val code: String = "",
    val username: String = "",
    val displayName: String = "",
    val usernameAvailable: Boolean? = null,
    val loading: Boolean = false,
    val error: String? = null,
    val resendIn: Int = 0,
    val done: Boolean = false,
)

class AuthViewModel(private val container: AppContainer) : ViewModel() {

    private val _state = MutableStateFlow(AuthState())
    val state: StateFlow<AuthState> = _state.asStateFlow()

    private var usernameCheck: Job? = null
    private var resendTimer: Job? = null

    fun setPhone(value: String) {
        // Keep only the leading + and digits, so paste-from-contacts works
        // regardless of how the number was formatted there.
        val cleaned = buildString {
            value.forEachIndexed { index, c ->
                if (c.isDigit()) append(c)
                if (c == '+' && index == 0) append(c)
            }
        }
        _state.update { it.copy(phone = cleaned.take(16), error = null) }
    }

    fun setCode(value: String) {
        _state.update { it.copy(code = value.filter(Char::isDigit).take(6), error = null) }
    }

    fun setDisplayName(value: String) = _state.update { it.copy(displayName = value.take(64)) }

    fun setUsername(value: String) {
        val cleaned = value.lowercase().filter { it.isLetterOrDigit() || it == '_' || it == '.' }.take(32)
        _state.update { it.copy(username = cleaned, usernameAvailable = null, error = null) }

        // Debounced: firing a request per keystroke would both hammer the
        // endpoint and race its own responses out of order.
        usernameCheck?.cancel()
        if (cleaned.length < 3) return
        usernameCheck = viewModelScope.launch {
            delay(400)
            val available = runCatching { container.repo.usernameAvailable(cleaned).available }.getOrNull()
            _state.update { if (it.username == cleaned) it.copy(usernameAvailable = available) else it }
        }
    }

    fun back() = _state.update { it.copy(step = AuthStep.Phone, code = "", error = null) }

    fun requestCode() {
        val phone = normalisedPhone() ?: return
        _state.update { it.copy(loading = true, error = null) }

        viewModelScope.launch {
            try {
                container.repo.requestOtp(phone)
                _state.update { it.copy(loading = false, step = AuthStep.Code, resendIn = 30) }
                startResendTimer()
            } catch (e: ApiException) {
                _state.update { it.copy(loading = false, error = friendly(e)) }
            }
        }
    }

    fun verify() {
        val phone = normalisedPhone() ?: return
        val code = _state.value.code
        _state.update { it.copy(loading = true, error = null) }

        viewModelScope.launch {
            try {
                val tokens = container.repo.verifyOtp(phone, code, BuildConfig.VERSION_NAME)
                container.session.saveTokens(tokens.accessToken, tokens.refreshToken)
                tokens.user?.let { container.session.saveIdentity(it.id, tokens.deviceId) }

                if (tokens.needsOnboarding) {
                    _state.update {
                        it.copy(
                            loading = false,
                            step = AuthStep.Profile,
                            displayName = tokens.user?.displayName.orEmpty(),
                        )
                    }
                } else {
                    _state.update { it.copy(loading = false, done = true) }
                }
            } catch (e: ApiException) {
                _state.update { it.copy(loading = false, error = friendly(e)) }
            }
        }
    }

    fun completeProfile() {
        val s = _state.value
        _state.update { it.copy(loading = true, error = null) }

        viewModelScope.launch {
            try {
                container.repo.completeProfile(s.username, s.displayName.trim())
                _state.update { it.copy(loading = false, done = true) }
            } catch (e: ApiException) {
                _state.update {
                    it.copy(
                        loading = false,
                        error = friendly(e),
                        usernameAvailable = if (e.code == "already_exists") false else it.usernameAvailable,
                    )
                }
            }
        }
    }

    private fun startResendTimer() {
        resendTimer?.cancel()
        resendTimer = viewModelScope.launch {
            while (_state.value.resendIn > 0) {
                delay(1_000)
                _state.update { it.copy(resendIn = (it.resendIn - 1).coerceAtLeast(0)) }
            }
        }
    }

    /** The API only accepts E.164, so assume a country code if none was typed. */
    private fun normalisedPhone(): String? {
        val raw = _state.value.phone
        val digits = raw.filter(Char::isDigit)
        if (digits.length < 7) {
            _state.update { it.copy(error = "That number looks too short") }
            return null
        }
        return if (raw.startsWith("+")) "+$digits" else "+$digits"
    }

    /**
     * Server error codes → copy a person can act on. The raw messages are
     * accurate but written for developers.
     */
    private fun friendly(e: ApiException): String = when (e.code) {
        "rate_limited" -> "Too many attempts. Try again in ${e.retryAfter ?: 60}s."
        "unauthenticated" -> e.message
        "already_exists" -> "That username is taken."
        "validation_failed" -> "Check the details and try again."
        "network_error" -> "Can't reach yappy. Check your connection."
        else -> e.message
    }

    companion object {
        fun factory(container: AppContainer) = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T =
                AuthViewModel(container) as T
        }
    }
}
