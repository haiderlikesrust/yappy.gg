package gg.yappy.app.data

import kotlinx.coroutines.CoroutineScope
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
class VoiceChannels(
    private val appContext: android.content.Context,
    private val repo: YappyRepository,
    private val engine: CallEngine,
    private val scope: CoroutineScope,
) {
    data class Session(val channelId: String, val spaceId: String, val title: String, val muted: Boolean = false)

    private val _session = MutableStateFlow<Session?>(null)
    val session: StateFlow<Session?> = _session.asStateFlow()

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
        if (_session.value == null && engineBusy) return // an actual call owns the engine

        leave()
        _session.value = Session(channelId, spaceId, title, muted = !publishAudio)
        try {
            val res = repo.joinVoice(channelId)
            engine.connect(
                scope,
                CallEngine.resolveUrl(res.url),
                res.token,
                publishAudio = publishAudio,
                // Namespaced: a channel id and a call id come from different
                // tables, and the engine's owner check compares strings.
                owner = ownerOf(channelId),
            )
            // The engine forces the loudspeaker on every connect; say so, or
            // the bar and the notification would offer to turn on what is
            // already on.
            _speakerOn.value = true
            // Only once the room is actually up. A service started for a
            // session that then failed to connect is a notification for a
            // hangout nobody is in.
            VoiceService.start(appContext)
        } catch (t: Throwable) {
            _session.value = null
            runCatching { repo.leaveVoice(channelId) }
        }
    }

    suspend fun leave() {
        val s = _session.value ?: return
        _session.value = null
        VoiceService.stop(appContext)
        engine.close(ownerOf(s.channelId))
        runCatching { repo.leaveVoice(s.channelId) }
    }

    private fun ownerOf(channelId: String) = "voice:$channelId"

    suspend fun setMuted(muted: Boolean) {
        val s = _session.value ?: return
        _session.value = s.copy(muted = muted)
        engine.setMicEnabled(!muted)
        // Same id, new content: the shade has to agree with the bar, and it is
        // the surface someone muting from a pocket is looking at.
        VoiceService.start(appContext)
    }

    fun setSpeaker(on: Boolean) {
        if (_session.value == null) return
        _speakerOn.value = on
        engine.setSpeakerphone(on)
        VoiceService.start(appContext)
    }
}
