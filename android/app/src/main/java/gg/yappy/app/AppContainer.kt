package gg.yappy.app

import android.content.Context
import gg.yappy.app.data.ApiClient
import gg.yappy.app.data.AttachmentUploader
import gg.yappy.app.data.GatewayClient
import gg.yappy.app.data.SessionStore
import gg.yappy.app.data.YappyRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.plus
import kotlinx.coroutines.Dispatchers

/**
 * Manual dependency container.
 *
 * Hilt would be the default choice, but it costs a KSP round in every build for
 * a graph this shallow — one HTTP client, one repository, one socket. A single
 * container created in `Application` and read through a CompositionLocal is
 * less machinery and no less testable: swap the container, swap the world.
 */
class AppContainer(context: Context) {

    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    val session = SessionStore(context.applicationContext)

    private val _signedIn = MutableStateFlow<Boolean?>(null)

    /** null while the stored token is still being read — used to hold the splash. */
    val signedIn: StateFlow<Boolean?> = _signedIn.asStateFlow()

    val api = ApiClient(
        session = session,
        onSignedOut = {
            // Refresh failed for good. Tear down local state so the UI cannot
            // keep issuing requests that will all 401.
            session.clear()
            gateway.disconnect()
            _signedIn.value = false
        },
    )

    val repo = YappyRepository(api)

    val uploader = AttachmentUploader(context.applicationContext, repo, api.http)

    val gateway: GatewayClient by lazy {
        GatewayClient(
            scope = scope,
            repo = repo,
            session = session,
            httpFactory = { api.http },
        )
    }

    suspend fun bootstrap() {
        _signedIn.value = session.currentAccess() != null
    }

    fun onAuthenticated() {
        _signedIn.value = true
        gateway.connect()
    }

    suspend fun signOut() {
        runCatching { repo.logout() }
        gateway.disconnect()
        session.clear()
        _signedIn.value = false
    }
}
