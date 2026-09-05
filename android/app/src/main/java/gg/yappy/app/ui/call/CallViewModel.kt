package gg.yappy.app.ui.call

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.util.Log
import androidx.core.content.ContextCompat
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import gg.yappy.app.AppContainer
import gg.yappy.app.data.Call
import gg.yappy.app.data.CallCoordinator
import gg.yappy.app.data.CallEngine
import gg.yappy.app.data.MediaState
import java.time.Instant
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

private const val TAG = "CallViewModel"

/** What the call screen draws, apart from the engine's own media flow. */
data class CallState(
    val call: Call? = null,
    val muted: Boolean = false,
    val speaker: Boolean = true,
    /** Local tick since the call was joined; the timer's fallback while ringing. */
    val seconds: Int = 0,
    val now: Long = System.currentTimeMillis(),
    val micGranted: Boolean = false,
    /** False once the join came back without media credentials. */
    val mediaOffered: Boolean = true,
    /** True once there are credentials a failed audio connection can retry with. */
    val canRetry: Boolean = false,
    /**
     * Set once the call is over — by us, by the other side, or by the server —
     * and held on screen for a beat so "Call ended · 3:12" is read rather than
     * glimpsed. A screen that vanishes the instant a call drops leaves you
     * wondering whether you hung up or the network did.
     */
    val endedAfter: Int? = null,
)

/**
 * The call's lifetime, tied to the navigation entry rather than the window.
 *
 * The screen used to join in a LaunchedEffect and hang up in onDispose, which
 * made every configuration change a hang-up: rotating or folding the phone
 * rebuilds the activity, disposes the composition, tears the room down, tells
 * the server this participant left, and then the new composition joins again —
 * unmuted, on the loudspeaker, with the timer back at zero. A ViewModel scoped
 * to the CALL back-stack entry survives recreation and is cleared only when
 * the entry is popped or the activity finishes for real, so [onCleared] is the
 * one place the call ends because the person left the screen.
 *
 * Owns the join, the media credentials, the roster poll, and the mute and
 * speaker choices. The engine itself stays on the container: a call that
 * survives the app being backgrounded outlives any screen.
 */
class CallViewModel(
    private val container: AppContainer,
    private val appContext: Context,
    private val callId: String,
) : ViewModel() {

    private val engine: CallEngine get() = container.callEngine

    private val _state = MutableStateFlow(CallState(micGranted = hasMic()))
    val state: StateFlow<CallState> = _state.asStateFlow()

    // The join response's media credentials, kept so a failed audio connection
    // can be retried in place instead of making you hang up and call again.
    private var mediaUrl: String? = null
    private var mediaToken: String? = null

    private var micPrompted = false

    /**
     * Whether the server has already been told this participant left.
     *
     * Hanging up posts the leave and then, a beat later, the screen is popped
     * and [onCleared] posted it again — and the API adds this seat's seconds
     * to the call's total on each one, so every hang-up counted its own
     * duration twice.
     */
    private var left = false

    init {
        join()
        tick()
    }

    private fun hasMic(): Boolean =
        ContextCompat.checkSelfPermission(appContext, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED

    private fun join() {
        viewModelScope.launch {
            // Adopt, never answer: answer() requests navigation to the call
            // screen, and a screen requesting navigation to itself is how
            // pressing Call stacked an endless pile of Connecting screens.
            CallCoordinator.adopt(appContext, callId)

            val joined = runCatching { container.repo.joinCall(callId, video = false) }.getOrNull()
            joined?.call?.let { fresh -> _state.update { it.copy(call = fresh) } }

            // Hung up while the join was still in flight — a wrong number is
            // ended in the second it takes to answer. Without this the room
            // came up behind the "Call ended" headline and published the mic
            // into a call the screen had already said goodbye to.
            if (_state.value.endedAfter != null) return@launch

            val token = joined?.token
            val url = joined?.url
            if (token != null && url != null) {
                val resolved = CallEngine.resolveUrl(url)
                mediaUrl = resolved
                mediaToken = token
                _state.update { it.copy(canRetry = true) }
                connect(resolved, token)
            } else {
                // The detail is for whoever runs the server, not for the person
                // on the call — it lands in the log, and the screen says only
                // that audio is not on offer.
                Log.w(TAG, "join returned no media credentials for call $callId")
                _state.update { it.copy(mediaOffered = false) }
            }
        }
    }

    /**
     * Bring the room up, then make it match what the person chose meanwhile.
     *
     * The engine forces the loudspeaker on every connect — VoiceChannels has
     * no speaker control and relies on that default — and a Mute or Speaker
     * tap while the headline still said "Connecting audio…" landed on a room
     * that was not there yet. So the loudspeaker came back on as the phone
     * was lifted to an ear, with the button still pressed in and the
     * proximity lock still held; or the mic published behind a Mute that
     * said otherwise. The flags are read *after* the suspend, so they are
     * whatever was tapped in the meantime, and only re-applied when the room
     * is actually up: a failed connect must not switch the audio mode into a
     * call that never started.
     */
    private suspend fun connect(url: String, token: String) {
        val before = _state.value
        val published = before.micGranted && !before.muted
        engine.connect(container.scope, url, token, publishAudio = published, owner = callId)
        // Hang-up landed during the connect: the room exists now, so it has to
        // be taken down here — nothing else will, the screen having already
        // done its own teardown before this returned.
        if (_state.value.endedAfter != null) {
            engine.close(callId)
            return
        }
        if (engine.media.value.state != MediaState.Connected) return
        val after = _state.value
        engine.setSpeakerphone(after.speaker)
        val wanted = after.micGranted && !after.muted
        if (wanted != published) engine.setMicEnabled(wanted)
    }

    /**
     * The timer, and the roster poll riding on it. The gateway pushes
     * participant updates too; the poll is the backstop for the case where
     * the socket is down but the call is not.
     */
    private fun tick() {
        viewModelScope.launch {
            while (true) {
                delay(1_000)
                _state.update { it.copy(seconds = it.seconds + 1, now = System.currentTimeMillis()) }
                val s = _state.value
                if (s.seconds % 5 != 0 || s.endedAfter != null) continue
                val fresh = runCatching { container.repo.call(callId).call }.getOrNull() ?: continue
                // Ended somewhere else: the seat is already gone on the server,
                // so there is nothing left for onCleared to leave.
                if (fresh.state == "ended") {
                    engine.close(callId)
                    left = true
                }
                _state.update {
                    it.copy(
                        call = fresh,
                        // A hang-up that landed while the request was in
                        // flight already has the right number; the server's
                        // is only for a call that ended somewhere else.
                        endedAfter = it.endedAfter ?: if (fresh.state == "ended") {
                            fresh.durationSeconds ?: elapsedSeconds(fresh, it.now, it.seconds)
                        } else {
                            null
                        },
                    )
                }
            }
        }
    }

    /**
     * Whether the composable should raise the permission sheet. True exactly
     * once per call: the screen asked on every composition, so a rotation
     * re-asked a question the person had just answered — and Android 13+
     * counts dismissals, after which the sheet stops appearing at all.
     */
    fun shouldPromptMic(): Boolean {
        if (_state.value.micGranted || micPrompted) return false
        micPrompted = true
        return true
    }

    fun onMicPermission(granted: Boolean) {
        _state.update { it.copy(micGranted = granted) }
        if (granted) {
            // The foreground service is declared `microphone`, and starting one
            // of that type without RECORD_AUDIO is refused outright — so on the
            // very first call the service died at start and never came back.
            // The call then ran only while the app was in front: switch apps
            // and Android froze the process mid-sentence. Adopt is idempotent,
            // so re-running it now that the permission is held is the whole
            // repair.
            CallCoordinator.adopt(appContext, callId)
            // And start publishing without making them rejoin.
            viewModelScope.launch { engine.setMicEnabled(!_state.value.muted) }
        }
    }

    fun toggleMute() {
        val muted = !_state.value.muted
        _state.update { it.copy(muted = muted) }
        viewModelScope.launch {
            // Stop the track first, then tell the roster. In the other order
            // a slow request leaves you hot-mic'd.
            engine.setMicEnabled(!muted)
            runCatching { container.repo.setCallState(callId, muted = muted) }
        }
    }

    fun toggleSpeaker() {
        val on = !_state.value.speaker
        _state.update { it.copy(speaker = on) }
        engine.setSpeakerphone(on)
    }

    fun retryMedia() {
        val url = mediaUrl ?: return
        val token = mediaToken ?: return
        // The engine refuses a second connect from the same owner while a room
        // exists; a failed attempt left one behind.
        engine.close(callId)
        viewModelScope.launch { connect(url, token) }
    }

    fun hangUp() {
        val s = _state.value
        if (s.endedAfter != null) return
        engine.close(callId)
        _state.update {
            it.copy(endedAfter = s.call?.let { c -> elapsedSeconds(c, s.now, s.seconds) } ?: s.seconds)
        }
        left = true
        // On the container scope, not the screen's: the screen holds "Call
        // ended" for a beat and is then popped, and a leave still in flight
        // when viewModelScope closes would be cancelled with nothing left to
        // re-send it.
        container.scope.launch { runCatching { container.repo.leaveCall(callId) } }
    }

    override fun onCleared() {
        // Tear the room down synchronously — leaving a publishing mic alive
        // after the screen is gone is the worst bug a call app can have. Named,
        // because this entry is often cleared *after* the next call has taken
        // the engine over: closing blind would hang up the call being answered.
        engine.close(callId)
        CallCoordinator.ended(appContext, callId)
        // Fire-and-forget on the container scope: viewModelScope is already
        // closed by the time this runs. Skipped when the hang-up already sent
        // it — see [left].
        if (!left) container.scope.launch { runCatching { container.repo.leaveCall(callId) } }
        super.onCleared()
    }

    companion object {
        fun factory(container: AppContainer, appContext: Context, callId: String) =
            object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T : ViewModel> create(modelClass: Class<T>): T =
                    CallViewModel(container, appContext.applicationContext, callId) as T
            }
    }
}

/**
 * Seconds this call has been live. From the server's `startedAt` when it has
 * one, so a call joined late (or adopted from the lock screen) shows the call's
 * age rather than this screen's; the local tick is the fallback while ringing
 * or when the clock string does not parse.
 */
internal fun elapsedSeconds(call: Call, nowMillis: Long, fallback: Int): Int {
    val started = call.startedAt?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() }
        ?: return fallback
    return ((nowMillis - started) / 1_000L).toInt().coerceAtLeast(0)
}
