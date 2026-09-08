package gg.yappy.app.data

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.launch
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * The voice-channel session — Discord's drop-in rooms, on the same
 * [CallEngine] that carries calls.
 *
 * At most one session, app-wide: joining a second channel leaves the first,
 * and a session refuses to start while the engine is busy with an actual
 * call. The backend owns the roster (voice.state snapshots over the
 * gateway); this owns the local seat.
 */
class VoiceChannels internal constructor(
    private val joinRoom: suspend (String, Boolean) -> VoiceJoinEnvelope,
    private val leaveRoom: suspend (String) -> Unit,
    private val updateRoom: suspend (String, Boolean) -> Unit,
    private val engine: VoiceMedia,
    private val scope: CoroutineScope,
    private val startService: () -> Unit,
    private val stopService: () -> Unit,
    private val micAllowed: () -> Boolean,
) {
    constructor(context: android.content.Context, repo: YappyRepository, engine: CallEngine, scope: CoroutineScope) : this(
        repo::joinVoice, { repo.leaveVoice(it) }, { id, muted -> repo.updateVoiceState(id, muted) }, engine, scope,
        { VoiceService.start(context) }, { VoiceService.stop(context) },
        { androidx.core.content.ContextCompat.checkSelfPermission(context, android.Manifest.permission.RECORD_AUDIO) == android.content.pm.PackageManager.PERMISSION_GRANTED },
    )

    data class Session(val channelId: String, val spaceId: String, val title: String, val muted: Boolean = false, val connected: Boolean = false, val generation: Long = 0)
    data class Failure(val session: Session, val message: String)
    private val _failure = MutableStateFlow<Failure?>(null)
    val failure = _failure.asStateFlow()
    fun dismissFailure() { _failure.value = null }
    suspend fun retry() { _failure.value?.session?.let { join(it.channelId, it.spaceId, it.title, !it.muted) } }

    private val _session = MutableStateFlow<Session?>(null)
    val session: StateFlow<Session?> = _session.asStateFlow()
    private val gate = VoiceSessionGate()
    private var joiningJob: Job? = null
    private val rosterMutex = Mutex()

    init {
        scope.launch {
            engine.media.collect { media ->
                val current = _session.value ?: return@collect
                if (current.connected && (media.state in setOf(MediaState.Failed, MediaState.Disconnected) ||
                    (media.owner != null && media.owner != ownerOf(current.channelId)))) {
                    val failure = Failure(current, "Voice disconnected. Tap Retry to rejoin.")
                    leave()
                    _failure.value = failure
                }
            }
        }
    }

    /**
     * Loudspeaker or earpiece.
     *
     * Held here rather than read back from the engine, which has no getter and
     * whose AudioManager can be changed by the system underneath us. It is
     * what the bar and the notification both draw, so it has to be one value
     * both can see — and the engine forces the loudspeaker on every connect,
     * so a fresh session starts true.
     */
    private val _speakerOn = MutableStateFlow(true)
    val speakerOn: StateFlow<Boolean> = _speakerOn.asStateFlow()

    /** The engine's connection state, for the connected bar. */
    val media get() = engine.media

    suspend fun join(channelId: String, spaceId: String, title: String, publishAudio: Boolean = true) {
        if (_session.value?.channelId == channelId) return

        val engineBusy = engine.media.value.state in
            setOf(MediaState.Connecting, MediaState.Connected, MediaState.Reconnecting)
        if (_session.value == null && engineBusy) {
            _failure.value = Failure(Session(channelId, spaceId, title), "Finish your call before joining voice.")
            return
        }

        val ticket = gate.invalidate()
        joiningJob?.cancel()
        _failure.value = null
        gate.serialized {
            if (!gate.isCurrent(ticket)) return@serialized
            leaveCurrent()
            if (!gate.isCurrent(ticket)) return@serialized
            _session.value = Session(channelId, spaceId, title, muted = !publishAudio || !micAllowed(), generation = ticket)
            _speakerOn.value = true
            var connected = false
            try {
              // Start while the user's join action is still in the foreground.
              // The notification says Connecting until media is ready.
              startService()
              withTimeout(30_000) {
                  joiningJob = currentCoroutineContext()[Job]
                  val res = joinRoom(channelId, _session.value?.muted ?: true)
                  if (!gate.isCurrent(ticket)) return@withTimeout
                  engine.connect(
                      scope,
                      CallEngine.resolveUrl(res.url),
                      res.token,
                      // Connect silently, then apply the latest mute choice. A
                      // tap during the handshake must never briefly open the mic.
                      publishAudio = false,
                      // Namespaced: a channel id and a call id come from different
                      // tables, and the engine's owner check compares strings.
                      owner = ownerOf(channelId),
                  )
                  if (!gate.isCurrent(ticket)) return@withTimeout
                  if (engine.media.value.state != MediaState.Connected) error("Couldn't connect to voice. Tap Retry to try again.")
                  // A mute tap made during connection must survive the engine's
                  // initial microphone setup.
                  engine.setMicEnabled(!(_session.value?.muted ?: true))
                  if (!gate.isCurrent(ticket)) return@withTimeout
                  // The engine forces the loudspeaker on every connect; say so, or
                  // the bar and the notification would offer to turn on what is
                  // already on.
                  engine.setSpeakerphone(_speakerOn.value)
                  // Replace the connecting notification with the connected state.
                  _session.value = _session.value?.copy(connected = true, muted = !engine.media.value.micEnabled)
                  startService()
                  connected = true
                  scope.launch { syncMuted() }
              }
            } catch (t: Throwable) {
              if (t is CancellationException && t !is TimeoutCancellationException) throw t
              if (gate.isCurrent(ticket)) _session.value?.let {
                  val message = when {
                      t is TimeoutCancellationException -> "Voice took too long to connect. Tap Retry."
                      t is ApiException && t.status == 403 -> "You don't have permission to join this voice room."
                      t is ApiException && t.status == 429 -> "Too many join attempts. Wait a moment and retry."
                      else -> "Couldn't connect to voice. Check your connection and retry."
                  }
                  _failure.value = Failure(it, message)
              }
            } finally {
              joiningJob = null
              if (!connected) withContext(NonCancellable) { leaveCurrent() }
            }
        }
    }

    suspend fun leave() {
        gate.invalidate()
        joiningJob?.cancel()
        _failure.value = null
        // Stop audio immediately, even if the join HTTP request is pending.
        _session.value?.let { engine.close(ownerOf(it.channelId)) }
        stopService()
        gate.serialized { leaveCurrent() }
    }

    private suspend fun leaveCurrent() {
        val s = _session.value ?: return
        _session.value = null
        stopService()
        engine.close(ownerOf(s.channelId))
        runCatching { withTimeout(5_000) { leaveRoom(s.channelId) } }
    }

    private fun ownerOf(channelId: String) = "voice:$channelId"

    suspend fun setMuted(muted: Boolean) {
        val s = _session.value ?: return
        if (!muted && !micAllowed()) {
            _failure.value = Failure(s, "Allow microphone access in Android Settings to speak. You can still listen.")
            return
        }
        _session.value = s.copy(muted = muted)
        if (s.connected) {
            engine.setMicEnabled(!muted)
            if (_session.value?.channelId != s.channelId) return
            _session.value = _session.value?.copy(muted = !engine.media.value.micEnabled)
            if (engine.media.value.micEnabled == muted) _failure.value = Failure(s, "Couldn't change the microphone. Try again.")
        }
        // Same id, new content: the shade has to agree with the bar, and it is
        // the surface someone muting from a pocket is looking at.
        if (s.connected) { startService(); syncMuted() }
    }

    private suspend fun syncMuted() = rosterMutex.withLock {
        val current = _session.value?.takeIf { it.connected } ?: return@withLock
        // The microphone is already changed. A stale/offline roster must not
        // undo a mute or delay local audio controls.
        runCatching { withTimeout(5_000) { updateRoom(current.channelId, current.muted) } }
    }

    fun setSpeaker(on: Boolean) {
        if (_session.value == null) return
        _speakerOn.value = on
        if (_session.value?.connected == true) {
            engine.setSpeakerphone(on)
            startService()
        }
    }
}
