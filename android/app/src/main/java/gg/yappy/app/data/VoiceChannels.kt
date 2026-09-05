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
    private val repo: YappyRepository,
    private val engine: CallEngine,
    private val scope: CoroutineScope,
) {
    data class Session(val channelId: String, val spaceId: String, val title: String, val muted: Boolean = false)

    private val _session = MutableStateFlow<Session?>(null)
    val session: StateFlow<Session?> = _session.asStateFlow()

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
        } catch (t: Throwable) {
            _session.value = null
            runCatching { repo.leaveVoice(channelId) }
        }
    }

    suspend fun leave() {
        val s = _session.value ?: return
        _session.value = null
        engine.close(ownerOf(s.channelId))
        runCatching { repo.leaveVoice(s.channelId) }
    }

    private fun ownerOf(channelId: String) = "voice:$channelId"

    suspend fun setMuted(muted: Boolean) {
        val s = _session.value ?: return
        _session.value = s.copy(muted = muted)
        engine.setMicEnabled(!muted)
    }
}
