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

/** Sign in to an existing account, or make a new one. */
enum class AuthMode { SignIn, Register }

data class AuthState(
    val mode: AuthMode = AuthMode.SignIn,
    val email: String = "",
    val password: String = "",
    val username: String = "",
    val displayName: String = "",
    val usernameAvailable: Boolean? = null,
    val showPassword: Boolean = false,
    val loading: Boolean = false,
    val error: String? = null,
    val done: Boolean = false,
) {
    val emailLooksValid: Boolean
        get() = email.contains('@') && email.substringAfterLast('@').contains('.')

    /**
     * Whether the button should be live.
     *
     * Registration additionally waits on the username check having come back
     * negative-free. `null` (still checking, or too short to check) does not
     * block — the server is the authority and rejects a taken name anyway.
     */
    val canSubmit: Boolean
        get() = !loading && emailLooksValid && password.length >= MIN_PASSWORD &&
            (mode == AuthMode.SignIn || (username.length >= 3 && usernameAvailable != false))

    companion object {
        /** Matches the server's rule; duplicated so the UI can say so early. */
        const val MIN_PASSWORD = 8
    }
}

class AuthViewModel(private val container: AppContainer) : ViewModel() {

    private val _state = MutableStateFlow(AuthState())
    val state: StateFlow<AuthState> = _state.asStateFlow()

    private var usernameCheck: Job? = null

    fun setMode(mode: AuthMode) = _state.update {
        it.copy(mode = mode, error = null, usernameAvailable = null)
    }

    fun setEmail(value: String) = _state.update {
        // Trimmed and lowered here as well as on the server: a keyboard that
        // capitalises the first letter would otherwise make the address the
        // person typed look different from the one they registered.
        it.copy(email = value.trim().lowercase().take(254), error = null)
    }

    fun setPassword(value: String) = _state.update { it.copy(password = value.take(200), error = null) }

    fun toggleShowPassword() = _state.update { it.copy(showPassword = !it.showPassword) }

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

    fun submit() {
        val s = _state.value
        if (!s.canSubmit) return
        _state.update { it.copy(loading = true, error = null) }

        viewModelScope.launch {
            try {
                val tokens = if (s.mode == AuthMode.Register) {
                    container.repo.register(
                        email = s.email,
                        password = s.password,
                        username = s.username,
                        displayName = s.displayName.trim().ifBlank { s.username },
                        appVersion = BuildConfig.VERSION_NAME,
                    )
                } else {
                    container.repo.login(s.email, s.password, BuildConfig.VERSION_NAME)
                }

                container.session.saveTokens(tokens.accessToken, tokens.refreshToken)
                tokens.user?.let { container.session.saveIdentity(it.id, tokens.deviceId) }

                // The password is held only as long as the request needs it.
                // Leaving it in state means it survives in a process dump and
                // in any state snapshot the framework takes.
                _state.update { it.copy(loading = false, password = "", done = true) }
            } catch (e: ApiException) {
                _state.update {
                    it.copy(
                        loading = false,
                        error = friendly(e),
                        usernameAvailable =
                            if (e.code == "already_exists" && it.mode == AuthMode.Register) false
                            else it.usernameAvailable,
                    )
                }
            }
        }
    }

    /**
     * Finish a Google sign-in: the UI already holds the ID token; the server
     * decides whether it is a returning account or a brand-new one. Same
     * completion path as submit(), because the response is the same shape.
     */
    fun socialSignIn(idToken: String) {
        _state.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            try {
                val tokens = container.repo.socialSignIn("google", idToken, BuildConfig.VERSION_NAME)
                container.session.saveTokens(tokens.accessToken, tokens.refreshToken)
                tokens.user?.let { container.session.saveIdentity(it.id, tokens.deviceId) }
                _state.update { it.copy(loading = false, password = "", done = true) }
            } catch (e: ApiException) {
                _state.update { it.copy(loading = false, error = friendly(e)) }
            }
        }
    }

    /** The Credential Manager failed outside our control (or was dismissed). */
    fun socialFailed(message: String?) {
        _state.update { it.copy(loading = false, error = message) }
    }

    /**
     * Server error codes → copy a person can act on. The raw messages are
     * accurate but written for developers.
     *
     * "Email or password is incorrect" is passed through deliberately vague:
     * saying which one was wrong tells anyone who asks whether an address has
     * an account here.
     */
    private fun friendly(e: ApiException): String = when (e.code) {
        "rate_limited" -> "Too many attempts. Try again in ${e.retryAfter ?: 60}s."
        "unauthenticated" -> e.message
        "already_exists" -> e.message
        "validation_failed" -> e.message.ifBlank { "Check the details and try again." }
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
