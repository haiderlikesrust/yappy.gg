package gg.yappy.app.data

import android.content.Context
import android.media.AudioManager
import io.livekit.android.LiveKit
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import io.livekit.android.room.Room
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * The media half of a call.
 *
 * Everything about *who may join* — permission, ringing, the roster, the call
 * record — is the backend's job and already worked without this. What was
 * missing is the part that carries sound: a LiveKit room, joined with the
 * scoped token the API mints per participant.
 *
 * The SDK is deliberately sealed inside this class. The screen sees a state
 * flow and four verbs, so swapping SFUs later is one file, and the UI cannot
 * accidentally depend on LiveKit types.
 */
enum class MediaState { Idle, Connecting, Connected, Reconnecting, Failed, Disconnected }

data class CallMedia(
    val state: MediaState = MediaState.Idle,
    /** LiveKit identities are our user ids — the backend mints them that way. */
    val speaking: Set<String> = emptySet(),
    val remoteCount: Int = 0,
    val micEnabled: Boolean = true,
    val error: String? = null,
)

class CallEngine(context: Context) {

    private val appContext = context.applicationContext
    private val audio = appContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager

    private val _media = MutableStateFlow(CallMedia())
    val media: StateFlow<CallMedia> = _media.asStateFlow()

    private var room: Room? = null
    private var eventJob: Job? = null

    /**
     * @param url The SFU's websocket URL as the *server* sees it. Rewritten for
     *   the emulator by [resolveUrl] — the backend has no idea it is talking to
     *   a client whose "localhost" is a different machine.
     */
    suspend fun connect(scope: CoroutineScope, url: String, token: String, publishAudio: Boolean = true) {
        if (room != null) return
        _media.update { it.copy(state = MediaState.Connecting, error = null) }

        val created = LiveKit.create(appContext = appContext)
        room = created

        eventJob = scope.launch {
            created.events.collect { event ->
                when (event) {
                    is RoomEvent.Connected ->
                        _media.update { it.copy(state = MediaState.Connected, error = null) }

                    is RoomEvent.Reconnecting ->
                        _media.update { it.copy(state = MediaState.Reconnecting) }

                    is RoomEvent.Reconnected ->
                        _media.update { it.copy(state = MediaState.Connected) }

                    is RoomEvent.Disconnected ->
                        _media.update { it.copy(state = MediaState.Disconnected) }

                    // Drives the "who is talking" ring on the participant tiles.
                    is RoomEvent.ActiveSpeakersChanged ->
                        _media.update { current ->
                            current.copy(
                                speaking = event.speakers.mapNotNull { it.identity?.value }.toSet(),
                            )
                        }

                    is RoomEvent.ParticipantConnected, is RoomEvent.ParticipantDisconnected ->
                        _media.update { it.copy(remoteCount = created.remoteParticipants.size) }

                    else -> Unit
                }
            }
        }

        try {
            created.connect(url, token)
            if (publishAudio) created.localParticipant.setMicrophoneEnabled(true)
            _media.update {
                it.copy(
                    state = MediaState.Connected,
                    micEnabled = publishAudio,
                    remoteCount = created.remoteParticipants.size,
                )
            }
            // Calls belong on the loudspeaker by default; a voice call held to
            // the ear is a phone-app affordance we do not have proximity
            // handling for yet.
            setSpeakerphone(true)
        } catch (e: Throwable) {
            _media.update { it.copy(state = MediaState.Failed, error = e.message ?: "Could not connect") }
        }
    }

    suspend fun setMicEnabled(enabled: Boolean) {
        _media.update { it.copy(micEnabled = enabled) }
        runCatching { room?.localParticipant?.setMicrophoneEnabled(enabled) }
    }

    fun setSpeakerphone(on: Boolean) {
        runCatching {
            audio.mode = AudioManager.MODE_IN_COMMUNICATION
            @Suppress("DEPRECATION")
            audio.isSpeakerphoneOn = on
        }
    }

    /** Idempotent: the screen's disposal and an explicit hang-up both call it. */
    fun close() {
        eventJob?.cancel()
        eventJob = null
        runCatching { room?.disconnect() }
        runCatching { room?.release() }
        room = null
        runCatching {
            @Suppress("DEPRECATION")
            audio.isSpeakerphoneOn = false
            audio.mode = AudioManager.MODE_NORMAL
        }
        _media.update { CallMedia(state = MediaState.Disconnected) }
    }

    companion object {
        /**
         * The API returns the SFU URL from its own environment, where
         * "localhost" means the host machine. On an emulator that name resolves
         * to the emulator itself, so a dev URL has to be rewritten the same way
         * the API base URL already is.
         */
        fun resolveUrl(url: String): String =
            url.replace("localhost", "10.0.2.2").replace("127.0.0.1", "10.0.2.2")
    }
}
