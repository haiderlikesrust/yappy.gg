package gg.yappy.app.data

import android.content.Context
import android.media.AudioManager
import io.livekit.android.LiveKit
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import io.livekit.android.room.Room
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.CancellationException
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
    val owner: String? = null,
)

class CallEngine(context: Context) : VoiceMedia {

    private val appContext = context.applicationContext
    private val audio = appContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager

    private val _media = MutableStateFlow(CallMedia())
    override val media: StateFlow<CallMedia> = _media.asStateFlow()

    private var room: Room? = null
    private var eventJob: Job? = null

    /**
     * Which call or voice channel the live room belongs to.
     *
     * One engine, and screens that are torn down asynchronously: answering a
     * second call builds the new room while the first call screen's ViewModel
     * is still being cleared, and that `onCleared` then closed the room the new
     * call had just joined — leaving a screen that said "Connected" over no
     * audio at all. Every verb names its owner, so a teardown arriving late is
     * dropped instead of taking the current call down with it.
     */
    private var owner: String? = null

    /**
     * @param url The SFU's websocket URL as the *server* sees it. Rewritten for
     *   the emulator by [resolveUrl] — the backend has no idea it is talking to
     *   a client whose "localhost" is a different machine.
     * @param owner The call or channel joining. A second owner takes the engine
     *   over; the same owner asking twice is the no-op it always was.
     */
    override suspend fun connect(
        scope: CoroutineScope,
        url: String,
        token: String,
        publishAudio: Boolean,
        owner: String?,
    ) {
        if (room != null) {
            if (this.owner == owner && _media.value.state in setOf(MediaState.Connecting, MediaState.Connected, MediaState.Reconnecting)) return
            // A handover. The old room goes first, or its microphone keeps
            // publishing into a call nobody is on any more.
            teardown()
        }
        this.owner = owner
        // Not a copy: the speakers and the head-count belong to the room being
        // replaced, and carrying them over shows the previous call's roster on
        // the new call's tiles until the first event lands.
        _media.value = CallMedia(state = MediaState.Connecting, micEnabled = publishAudio, owner = owner)

        val created = LiveKit.create(appContext = appContext)
        room = created

        eventJob = scope.launch {
            created.events.collect { event ->
                if (room !== created) return@collect
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
            if (room !== created) return
            if (publishAudio) created.localParticipant.setMicrophoneEnabled(true)
            if (room !== created) return
            _media.update {
                it.copy(
                    state = MediaState.Connected,
                    micEnabled = publishAudio,
                    remoteCount = created.remoteParticipants.size,
                )
            }
            // Calls belong on the loudspeaker by default — a voice channel
            // relies on this, and left alone LiveKit picks the earpiece. The
            // call screen owns the route from here: CallViewModel re-asserts
            // whatever the person chose once connect returns, so a Speaker
            // tap made while audio was still connecting survives this line.
            setSpeakerphone(true)
        } catch (e: Throwable) {
            // A cancelled/closed room must not overwrite a newer owner's
            // state or resume publishing after its screen has gone away.
            if (room === created) {
                teardown()
                _media.value = CallMedia(state = MediaState.Failed, error = e.message ?: "Could not connect", owner = owner)
            }
            if (e is CancellationException) throw e
        }
    }

    override suspend fun setMicEnabled(enabled: Boolean) {
        val current = room ?: return
        try {
            current.localParticipant.setMicrophoneEnabled(enabled)
            if (room === current) _media.update { it.copy(micEnabled = enabled, error = null) }
        } catch (e: Throwable) {
            if (e is CancellationException) throw e
            if (room === current) _media.update { it.copy(error = "Couldn't change the microphone. Try again.") }
        }
    }

    override fun setSpeakerphone(on: Boolean) {
        runCatching {
            audio.mode = AudioManager.MODE_IN_COMMUNICATION
            @Suppress("DEPRECATION")
            audio.isSpeakerphoneOn = on
        }
    }

    /**
     * Idempotent: the screen's disposal and an explicit hang-up both call it.
     *
     * @param owner Who is hanging up. A named owner only closes its own room,
     *   so a call screen cleared after the next call has taken the engine over
     *   cannot end it. Null closes whatever is live — what sign-out wants.
     */
    override fun close(owner: String?) {
        if (owner != null && this.owner != null && this.owner != owner) return
        teardown()
        _media.update { CallMedia(state = MediaState.Disconnected) }
    }

    private fun teardown() {
        eventJob?.cancel()
        eventJob = null
        runCatching { room?.disconnect() }
        runCatching { room?.release() }
        room = null
        owner = null
        runCatching {
            @Suppress("DEPRECATION")
            audio.isSpeakerphoneOn = false
            audio.mode = AudioManager.MODE_NORMAL
        }
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
