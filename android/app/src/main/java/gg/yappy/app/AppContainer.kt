package gg.yappy.app

import android.content.Context
import gg.yappy.app.data.ApiClient
import gg.yappy.app.data.AttachmentUploader
import gg.yappy.app.data.CallCoordinator
import gg.yappy.app.data.CallEngine
import gg.yappy.app.data.CallWatcher
import gg.yappy.app.data.DeepLink
import gg.yappy.app.data.DiskCache
import gg.yappy.app.data.Endpoints
import gg.yappy.app.data.FullUser
import gg.yappy.app.data.GatewayClient
import gg.yappy.app.data.HeaderSeedCache
import gg.yappy.app.data.PushRegistrar
import gg.yappy.app.data.SessionStore
import gg.yappy.app.data.YappyRepository
import gg.yappy.app.ui.chat.MediaFactory
import gg.yappy.app.ui.chat.VoiceNotePlayer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.plus
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/**
 * Manual dependency container.
 *
 * Hilt would be the default choice, but it costs a KSP round in every build for
 * a graph this shallow — one HTTP client, one repository, one socket. A single
 * container created in `Application` and read through a CompositionLocal is
 * less machinery and no less testable: swap the container, swap the world.
 */
class AppContainer(context: Context) {

    /** The application context, for anything that outlives a screen. */
    val appContext = context.applicationContext

    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    val session = SessionStore(appContext)

    private val _signedIn = MutableStateFlow<Boolean?>(null)

    /** null while the stored token is still being read — used to hold the splash. */
    val signedIn: StateFlow<Boolean?> = _signedIn.asStateFlow()

    /** Primary and backup domains, shared by the API client and the gateway so
     *  they fail over together. */
    private val endpoints = Endpoints(
        apiUrls = listOf(BuildConfig.API_URL, BuildConfig.API_URL_ALT),
        gatewayUrls = listOf(BuildConfig.GATEWAY_URL, BuildConfig.GATEWAY_URL_ALT),
    )

    val api = ApiClient(
        session = session,
        endpoints = endpoints,
        onSignedOut = {
            // Refresh was *rejected* — not merely unreachable, which the client
            // now tells apart. Tear down local state so the UI cannot keep
            // issuing requests that will all 401.
            session.clear()
            gateway.disconnect()
            DiskCache.clear()
            headerSeeds.clear()
            _me.value = null
            _signedIn.value = false
        },
    )

    private val _pendingLink = MutableStateFlow<DeepLink?>(null)

    /**
     * A link waiting to be acted on.
     *
     * It lives here rather than in the navigation graph because a link often
     * arrives before there is anywhere to send it: tapping an invite while
     * signed out starts the app at the sign-in screen, and the invite should
     * still be there afterwards rather than having been dropped on the way.
     */
    val pendingLink: StateFlow<DeepLink?> = _pendingLink.asStateFlow()

    fun offerLink(link: DeepLink?) {
        if (link != null) _pendingLink.value = link
    }

    /** Called once the link has been shown; without this it reopens on every
     *  recomposition of the host. */
    fun consumeLink() {
        _pendingLink.value = null
    }

    val repo = YappyRepository(api)

    val uploader = AttachmentUploader(appContext, repo, api.http)

    /** Header text and avatars left behind by list screens, for first paint. */
    val headerSeeds = HeaderSeedCache()

    /**
     * A conversation was just read on this device.
     *
     * The server echoes the same fact back as `conversation.state_update`, but
     * that round trip is exactly the beat in which the person is already
     * looking at the list again — so the chat announces it locally too and the
     * badge clears in the same frame the back-swipe lands. Buffered, because
     * nothing may be collecting at the moment of emission.
     */
    val conversationRead = MutableSharedFlow<String>(extraBufferCapacity = 8)

    /**
     * What each screen showed when it was last on screen.
     *
     * Compose state lives with the navigation entry, so backing out of a space
     * and walking back in starts from nothing: a spinner, then the header, then
     * the channels — three paints for a screen the person watched fully drawn
     * two seconds ago. Screens seed their state from here and write back what
     * they fetched, so a re-open paints last-known-good in the first frame and
     * the refetch lands as an invisible correction instead of a flash.
     *
     * Session-scoped and bounded. This is deliberately not the disk: it exists
     * to make navigation seamless, not to survive restarts, and keeping it in
     * memory means never showing another account's rooms after a sign-out.
     */
    val screenSnapshots = ScreenSnapshots()

    class ScreenSnapshots {
        private val entries = object : LinkedHashMap<String, Any>(32, 0.75f, true) {
            override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Any>): Boolean = size > 64
        }

        @Suppress("UNCHECKED_CAST")
        fun <T> get(key: String): T? = entries[key] as? T

        fun put(key: String, value: Any) {
            entries[key] = value
        }

        fun clear() = entries.clear()
    }

    private val _me = MutableStateFlow<FullUser?>(null)

    /**
     * The signed-in profile, published so every screen drawing your face or
     * reading your notification preferences moves at the same moment.
     */
    val me: StateFlow<FullUser?> = _me.asStateFlow()

    fun setMe(user: FullUser?) {
        _me.value = user
    }

    /**
     * Adopt only the *settings* from a PATCH /me/settings response.
     *
     * That endpoint's user historically came back without the joined avatar
     * and banner, and swallowing it whole via [setMe] blanked both across the
     * app every time any toggle or the text-size slider saved. The server is
     * fixed, but a response that only ever claimed to be about settings should
     * only ever be read as settings.
     */
    fun adoptSettings(user: FullUser) {
        _me.value = _me.value?.copy(
            privacy = user.privacy,
            notifications = user.notifications,
            appearance = user.appearance,
        ) ?: user
    }

    /**
     * Per-conversation notification level, as the list last saw it.
     *
     * Read by the in-app banner, which must not announce a conversation the
     * person has muted — and which has no other way to know, since the banner
     * is built from a socket event rather than from a loaded conversation.
     */
    val notificationLevels = mutableMapOf<String, String>()

    /**
     * The conversation on screen right now, so its own notifications are not
     * shown as banners over the top of the messages they describe.
     */
    @Volatile
    var foregroundConversationId: String? = null

    /**
     * Media for calls.
     *
     * Owned by the container rather than the call screen: a call answered from
     * a notification has to bring audio up before any screen exists, and a call
     * that survives the app being backgrounded outlives the composition that
     * started it.
     */
    val callEngine: CallEngine by lazy { CallEngine(appContext) }

    /**
     * Hosts whose media carries the access token.
     *
     * Message attachments are private — the API serves them only to members of
     * the conversation they were posted in. Anything not on this list (a Tenor
     * GIF, a bot's icon) must not see the header, or the session leaks to a
     * third party.
     */
    private val apiHosts: Set<String> = listOfNotNull(
        BuildConfig.API_URL.toHttpUrlOrNull()?.host,
        BuildConfig.API_URL_ALT.takeIf { it.isNotBlank() }?.toHttpUrlOrNull()?.host,
    ).toSet()

    /** One player for the whole app: starting a voice note stops the last one. */
    val voicePlayer: VoiceNotePlayer by lazy {
        VoiceNotePlayer(
            context = appContext,
            scope = scope,
            http = api.http,
            tokenProvider = { session.currentAccess() },
            apiHosts = apiHosts,
        )
    }

    /** Builds ExoPlayers that can read a private attachment. */
    val mediaFactory: MediaFactory by lazy {
        MediaFactory(
            http = api.http,
            // The synchronous mirror, not a suspending read: the data-source
            // resolver runs on ExoPlayer's loader thread with no coroutine to
            // suspend in, and blocking on DataStore there is a deadlock waiting
            // for a bad day.
            tokenProvider = { session.cachedAccess },
            apiHosts = apiHosts,
        )
    }

    val gateway: GatewayClient by lazy {
        GatewayClient(
            scope = scope,
            repo = repo,
            session = session,
            endpoints = endpoints,
            httpFactory = { api.http },
        )
    }

    val push: PushRegistrar by lazy { PushRegistrar(appContext, repo, scope) }

    /**
     * Rings driven by the socket. Started once, for the life of the process:
     * the gateway connects and disconnects with the foreground, and this simply
     * observes whatever it emits.
     */
    private val callWatcher by lazy { CallWatcher(appContext, this) }

    suspend fun bootstrap() {
        DiskCache.attach(appContext)
        session.bootstrap()
        callWatcher.start(scope)
        val signedIn = session.currentAccess() != null
        _signedIn.value = signedIn
        if (signedIn) {
            // Paint from the snapshot first; the live fetch every screen makes
            // anyway replaces it. Nothing here may fail loudly — a cache that
            // cannot be read is only a cache that misses.
            DiskCache.decode<gg.yappy.app.data.UserEnvelope>("me")?.let { _me.value = it.user }
            push.register()
            refreshMe()
        }
    }

    fun onAuthenticated() {
        _signedIn.value = true
        gateway.connect()
        scope.launch {
            push.register()
            refreshMe()
        }
    }

    /** Re-reads the profile and republishes it. Cheap, and every screen that
     *  changes it goes through [setMe] instead of holding its own copy. */
    suspend fun refreshMe() {
        runCatching { repo.me().user }.getOrNull()?.let { _me.value = it }
    }

    suspend fun signOut() {
        runCatching { push.unregister() }
        runCatching { repo.logout() }
        gateway.disconnect()
        // Any call this account was in is over as far as this device is
        // concerned, and its notification must not survive into the next
        // account's session.
        CallCoordinator.reset(appContext)
        callEngine.close()
        session.clear()
        DiskCache.clear()
        headerSeeds.clear()
        screenSnapshots.clear()
        notificationLevels.clear()
        _me.value = null
        _signedIn.value = false
    }
}
