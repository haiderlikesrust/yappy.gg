package gg.yappy.app.ui.call

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.CallEnd
import androidx.compose.material.icons.rounded.Mic
import androidx.compose.material.icons.rounded.MicOff
import androidx.compose.material.icons.rounded.Videocam
import androidx.compose.material.icons.rounded.VideocamOff
import androidx.compose.material.icons.rounded.VolumeUp
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import gg.yappy.app.LocalContainer
import gg.yappy.app.data.Call
import gg.yappy.app.data.CallCoordinator
import gg.yappy.app.data.CallEngine
import gg.yappy.app.data.MediaState
import gg.yappy.app.ui.components.Avatar
import gg.yappy.app.ui.components.NeuIconButton
import gg.yappy.app.ui.components.NeuSurface
import gg.yappy.app.ui.theme.Neu
import gg.yappy.app.ui.theme.NeuState
import gg.yappy.app.ui.theme.neuColors
import gg.yappy.app.ui.util.formatDuration
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Call screen.
 *
 * Two halves meet here. The backend owns *who may be in this call* — permission,
 * ringing, the roster, the record that lands in the thread — and LiveKit owns
 * the sound. [CallEngine] joins the SFU with the scoped token the API mints on
 * join, so the controls on this screen move real audio: mute stops publishing,
 * hang-up tears the room down, and the tiles ring when someone talks.
 *
 * Microphone permission is asked for but not required: denied, you still join
 * and can hear everyone. Refusing to connect someone who declined a permission
 * would be punishing them for the wrong thing.
 */
@Composable
fun CallScreen(callId: String, onLeave: () -> Unit) {
    val container = LocalContainer.current
    val colors = neuColors
    val scope = rememberCoroutineScope()
    val context = LocalContext.current

    var call by remember { mutableStateOf<Call?>(null) }
    var muted by remember { mutableStateOf(false) }
    var videoOn by remember { mutableStateOf(false) }
    var speaker by remember { mutableStateOf(true) }
    var seconds by remember { mutableIntStateOf(0) }
    var mediaOffered by remember { mutableStateOf(true) }

    // The container's engine, not one built here. A call answered from the lock
    // screen brings audio up before any screen exists, and a call that survives
    // the app being backgrounded outlives this composition — so the screen
    // *adopts* whatever is already connected rather than owning it.
    val engine = container.callEngine
    val mediaState by engine.media.collectAsState()

    var micGranted by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
                PackageManager.PERMISSION_GRANTED,
        )
    }
    val askMic = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        micGranted = granted
        // Granted mid-call: start publishing without making them rejoin.
        if (granted) scope.launch { engine.setMicEnabled(!muted) }
    }

    LaunchedEffect(Unit) {
        if (!micGranted) askMic.launch(Manifest.permission.RECORD_AUDIO)
    }

    LaunchedEffect(callId) {
        // Answering from the notification already stopped the ring and started
        // the foreground service; doing it again here is a no-op and covers the
        // case where the call was started from inside the app.
        CallCoordinator.answer(context, callId)

        val joined = runCatching { container.repo.joinCall(callId, video = false) }.getOrNull()
        call = joined?.call
        videoOn = joined?.call?.mode == "video"

        val token = joined?.token
        val url = joined?.url
        if (token != null && url != null) {
            engine.connect(container.scope, CallEngine.resolveUrl(url), token, publishAudio = micGranted)
        } else {
            mediaOffered = false
        }
    }

    // Poll the roster. The gateway pushes participant updates too; this is the
    // backstop for the case where the socket is down but the call is not.
    LaunchedEffect(callId) {
        while (true) {
            delay(1_000)
            seconds += 1
            if (seconds % 5 == 0) {
                runCatching { container.repo.call(callId).call }.getOrNull()?.let { fresh ->
                    call = fresh
                    if (fresh.state == "ended") onLeave()
                }
            }
        }
    }

    DisposableEffect(callId) {
        onDispose {
            // Tear the room down synchronously — leaving a publishing mic alive
            // after the screen is gone is the worst bug a call app can have.
            engine.close()
            CallCoordinator.ended(context, callId)
            // Fire-and-forget on the container scope: the composable is going
            // away and its own scope dies with it.
            container.scope.launch { runCatching { container.repo.leaveCall(callId) } }
        }
    }

    val participants = call?.participants.orEmpty()
    val joined = participants.filter { it.state == "joined" }
    val ringing = participants.filter { it.state == "ringing" || it.state == "invited" }

    Column(
        Modifier
            .fillMaxSize()
            .systemBarsPadding()
            .padding(20.dp),
    ) {
        Text(
            when {
                call == null -> "Connecting…"
                mediaState.state == MediaState.Connecting -> "Connecting audio…"
                mediaState.state == MediaState.Reconnecting -> "Reconnecting…"
                call!!.state == "ringing" -> "Ringing…"
                else -> formatDuration(seconds)
            },
            style = MaterialTheme.typography.titleMedium,
            color = colors.textSecondary,
            modifier = Modifier.fillMaxWidth(),
            textAlign = TextAlign.Center,
        )

        Spacer(Modifier.height(6.dp))
        Text(
            buildString {
                append(if (call?.mode == "video") "Video call" else "Voice call")
                if (mediaState.state == MediaState.Connected) append(" · audio live")
                if (!micGranted) append(" · listening only")
            },
            style = MaterialTheme.typography.labelMedium,
            color = if (mediaState.state == MediaState.Connected) colors.success else colors.textTertiary,
            modifier = Modifier.fillMaxWidth(),
            textAlign = TextAlign.Center,
        )

        Spacer(Modifier.height(24.dp))

        Box(Modifier.weight(1f)) {
            LazyVerticalGrid(
                columns = GridCells.Fixed(if (participants.size <= 2) 1 else 2),
                horizontalArrangement = Arrangement.spacedBy(14.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                items(participants, key = { it.user.id }) { participant ->
                    // LiveKit reports speakers by identity, which the backend
                    // mints as our user id — so this maps straight across.
                    val isSpeaking = mediaState.speaking.contains(participant.user.id)
                    val ring by animateColorAsState(
                        if (isSpeaking) colors.success else Color.Transparent,
                        label = "speaking-ring",
                    )

                    NeuSurface(
                        Modifier
                            .fillMaxWidth()
                            .height(if (participants.size <= 2) 260.dp else 170.dp)
                            .border(2.dp, ring, RoundedCornerShape(Neu.CornerLarge)),
                        shape = RoundedCornerShape(Neu.CornerLarge),
                        // Someone still ringing is recessed; once they join the
                        // tile lifts. Depth carries the state without a label.
                        state = if (participant.state == "joined") NeuState.Raised else NeuState.Pressed,
                        elevation = if (participant.state == "joined") 8.dp else 5.dp,
                        contentPadding = 12.dp,
                    ) {
                        Column(
                            Modifier.fillMaxSize(),
                            verticalArrangement = Arrangement.Center,
                            horizontalAlignment = Alignment.CenterHorizontally,
                        ) {
                            Avatar(
                                participant.user.avatarUrl,
                                participant.user.label,
                                participant.user.id,
                                size = if (participants.size <= 2) 96.dp else 62.dp,
                            )
                            Spacer(Modifier.height(10.dp))
                            Text(
                                participant.user.label,
                                style = MaterialTheme.typography.titleSmall,
                                color = colors.textPrimary,
                            )
                            Text(
                                when {
                                    isSpeaking -> "Speaking"
                                    participant.state == "joined" ->
                                        if (participant.isMuted) "Muted" else "In call"
                                    participant.state == "ringing" || participant.state == "invited" -> "Ringing…"
                                    participant.state == "declined" -> "Declined"
                                    participant.state == "missed" -> "No answer"
                                    else -> participant.state
                                },
                                style = MaterialTheme.typography.labelSmall,
                                color = if (isSpeaking) colors.success else colors.textTertiary,
                            )
                        }
                    }
                }
            }
        }

        // Only ever shown when something is actually wrong: a media failure the
        // user can act on, or a build the server refused to give a token to.
        val mediaProblem = when {
            !mediaOffered -> "No media token — check LIVEKIT_URL on the server"
            mediaState.state == MediaState.Failed -> mediaState.error ?: "Audio failed to connect"
            else -> null
        }
        if (mediaProblem != null) {
            Text(
                mediaProblem,
                style = MaterialTheme.typography.labelSmall,
                color = colors.warning,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().padding(bottom = 12.dp),
            )
        }

        Row(
            Modifier.fillMaxWidth().padding(vertical = 16.dp),
            horizontalArrangement = Arrangement.SpaceEvenly,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            NeuIconButton(
                if (muted) Icons.Rounded.MicOff else Icons.Rounded.Mic,
                if (muted) "Unmute" else "Mute",
                onClick = {
                    muted = !muted
                    scope.launch {
                        // Stop the track first, then tell the roster. In the
                        // other order a slow request leaves you hot-mic'd.
                        engine.setMicEnabled(!muted)
                        runCatching { container.repo.setCallState(callId, muted = muted) }
                    }
                },
                enabled = micGranted,
                active = muted,
                size = 58.dp,
                iconSize = 24.dp,
            )

            NeuIconButton(
                if (videoOn) Icons.Rounded.Videocam else Icons.Rounded.VideocamOff,
                "Camera",
                onClick = {
                    videoOn = !videoOn
                    scope.launch { runCatching { container.repo.setCallState(callId, video = videoOn) } }
                },
                active = !videoOn,
                size = 58.dp,
                iconSize = 24.dp,
            )

            NeuIconButton(
                Icons.Rounded.VolumeUp,
                "Speaker",
                onClick = {
                    speaker = !speaker
                    engine.setSpeakerphone(speaker)
                },
                active = !speaker,
                size = 58.dp,
                iconSize = 24.dp,
            )

            NeuIconButton(
                Icons.Rounded.CallEnd,
                "End call",
                onClick = {
                    engine.close()
                    scope.launch {
                        runCatching { container.repo.leaveCall(callId) }
                        onLeave()
                    }
                },
                accent = true,
                tint = colors.onAccent,
                size = 66.dp,
                iconSize = 27.dp,
            )
        }
    }
}
