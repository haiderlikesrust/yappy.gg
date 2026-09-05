package gg.yappy.app.ui.call

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.os.PowerManager
import android.util.Log
import android.view.WindowManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
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
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.CallEnd
import androidx.compose.material.icons.rounded.Mic
import androidx.compose.material.icons.rounded.MicOff
import androidx.compose.material.icons.rounded.VolumeUp
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import gg.yappy.app.LocalContainer
import gg.yappy.app.data.MediaState
import gg.yappy.app.ui.components.Avatar
import gg.yappy.app.ui.components.NeuIconButton
import gg.yappy.app.ui.components.NeuSurface
import gg.yappy.app.ui.components.softClickable
import gg.yappy.app.ui.theme.Neu
import gg.yappy.app.ui.theme.NeuState
import gg.yappy.app.ui.theme.PlaceShape
import gg.yappy.app.ui.theme.neuColors
import gg.yappy.app.ui.util.formatDuration
import kotlinx.coroutines.delay

private const val TAG = "CallScreen"

/** How long "Call ended · 3:12" stays up before the screen goes away. */
private const val ENDED_HOLD_MS = 1_200L

/**
 * Call screen.
 *
 * Two halves meet here. The backend owns *who may be in this call* — permission,
 * ringing, the roster, the record that lands in the thread — and LiveKit owns
 * the sound. [gg.yappy.app.data.CallEngine] joins the SFU with the scoped token
 * the API mints on join, so the controls here move real audio: mute stops publishing,
 * hang-up tears the room down, and the tiles ring when someone talks.
 *
 * The call itself lives in [CallViewModel], scoped to the navigation entry, so
 * this composable only draws its state and owns what belongs to the window —
 * the wake lock, the keep-screen-on flag, the permission sheet, the exit. A
 * rotation rebuilds all of that and nothing else.
 *
 * Microphone permission is asked for but not required: denied, you still join
 * and can hear everyone. Refusing to connect someone who declined a permission
 * would be punishing them for the wrong thing.
 *
 * Audio only, and honest about it: the engine publishes no video, so there is
 * no camera toggle here to promise something the call cannot deliver.
 */
@Composable
fun CallScreen(callId: String, onLeave: () -> Unit) {
    val container = LocalContainer.current
    val colors = neuColors
    val context = LocalContext.current
    val haptics = LocalHapticFeedback.current

    // Keyed to the call so the entry's store cannot hand back another call's
    // model, and resolved against the back-stack entry so it outlives the
    // window: see CallViewModel for why the join and the hang-up live there.
    val vm: CallViewModel = viewModel(
        key = "call-$callId",
        factory = CallViewModel.factory(container, context.applicationContext, callId),
    )
    val state by vm.state.collectAsStateWithLifecycle()
    val call = state.call
    val endedAfter = state.endedAfter

    // The container's engine, not one built here. A call answered from the lock
    // screen brings audio up before any screen exists, and a call that survives
    // the app being backgrounded outlives this composition — so the screen
    // *adopts* whatever is already connected rather than owning it.
    val mediaState by container.callEngine.media.collectAsStateWithLifecycle()

    val askMic = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        vm.onMicPermission(granted)
    }

    LaunchedEffect(Unit) {
        // The model says whether this is the first ask; a rotation is not.
        if (vm.shouldPromptMic()) askMic.launch(Manifest.permission.RECORD_AUDIO)
    }

    // ── Window: stay awake, and go dark against the ear ──────────────────────
    val view = LocalView.current
    DisposableEffect(view) {
        // A call is the one screen where the timeout is always wrong: nobody
        // is touching the phone, and everybody is still using it.
        val window = view.context.findActivity()?.window
        window?.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        onDispose { window?.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
    }
    DisposableEffect(state.speaker) {
        // Off the loudspeaker means the phone is at an ear, and a lit screen at
        // an ear hangs up with a cheek. The proximity wake lock is what the
        // dialer uses for exactly this; released the moment speaker comes back.
        // Bound to the window on purpose: a recreated activity re-acquires it
        // from the model's speaker state, so an earpiece call stays dark
        // through a rotation.
        val lock = if (!state.speaker) {
            runCatching {
                val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
                if (pm.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK)) {
                    pm.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "yappy:call").also {
                        it.acquire()
                    }
                } else {
                    null
                }
            }.getOrNull()
        } else {
            null
        }
        onDispose { runCatching { if (lock?.isHeld == true) lock.release() } }
    }

    // Who this call is with. The list that sent you here left the conversation's
    // name and avatar behind; when the screen is reached cold (a notification,
    // a deep link) it fetches the conversation once and seeds the cache so the
    // next hop is free.
    val conversationId = call?.conversationId
    var seed by remember(conversationId) {
        mutableStateOf(conversationId?.let { container.headerSeeds[it] })
    }
    LaunchedEffect(conversationId) {
        if (conversationId == null || seed != null) return@LaunchedEffect
        runCatching { container.repo.conversation(conversationId).conversation }.getOrNull()?.let {
            container.headerSeeds.remember(it)
            seed = container.headerSeeds[conversationId]
        }
    }

    // The hold before leaving, shared by every way a call can end. Here and
    // not in the model because only the composable holds the navigation.
    LaunchedEffect(endedAfter) {
        if (endedAfter == null) return@LaunchedEffect
        delay(ENDED_HOLD_MS)
        onLeave()
    }

    val hangUp = {
        if (endedAfter == null) {
            haptics.performHapticFeedback(HapticFeedbackType.LongPress)
            vm.hangUp()
        }
    }

    val participants = call?.participants.orEmpty()
    val active = call?.state == "active" || participants.count { it.state == "joined" } > 1

    Column(
        Modifier
            .fillMaxSize()
            .systemBarsPadding()
            .padding(20.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        // ── Who and where ────────────────────────────────────────────────────
        // A squircle for a place, a circle for a person: the same silhouette
        // rule as everywhere else, so the header says "group call" or "call
        // with Sam" before the name is read.
        seed?.let { s ->
            Avatar(
                s.avatarUrl,
                s.title,
                s.avatarSeed,
                size = 56.dp,
                shape = if (s.isGroup) PlaceShape else CircleShape,
            )
            Spacer(Modifier.height(12.dp))
            Text(
                s.title,
                style = MaterialTheme.typography.headlineSmall,
                color = colors.textPrimary,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(4.dp))
        }

        val headline = when {
            endedAfter != null -> "Call ended · ${formatDuration(endedAfter)}"
            call == null -> "Connecting…"
            mediaState.state == MediaState.Connecting -> "Connecting audio…"
            mediaState.state == MediaState.Reconnecting -> "Reconnecting…"
            !active -> "Ringing…"
            else -> formatDuration(elapsedSeconds(call, state.now, state.seconds))
        }
        AnimatedContent(
            targetState = endedAfter != null,
            transitionSpec = { fadeIn() togetherWith fadeOut() },
            label = "call-headline",
        ) { ended ->
            Text(
                headline,
                style = MaterialTheme.typography.titleMedium,
                color = if (ended) colors.textPrimary else colors.textSecondary,
                modifier = Modifier.fillMaxWidth(),
                textAlign = TextAlign.Center,
            )
        }

        Spacer(Modifier.height(6.dp))
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                buildString {
                    append("Voice call")
                    if (mediaState.state == MediaState.Connected && endedAfter == null) append(" · audio live")
                },
                style = MaterialTheme.typography.labelMedium,
                // Never green under "Call ended": a hang-up that lands while
                // the room is still coming up leaves the engine Connected for
                // the moment it takes to tear down, and the line under the
                // headline said the audio was live on a call that was over.
                color = if (mediaState.state == MediaState.Connected && endedAfter == null) {
                    colors.success
                } else {
                    colors.textTertiary
                },
            )
            if (!state.micGranted && endedAfter == null) {
                // Not a status line but a way back in: the permission sheet
                // was dismissed once, and this is the second chance without
                // a trip to system settings.
                Text(
                    " · Microphone off — tap to allow",
                    style = MaterialTheme.typography.labelMedium,
                    color = colors.accent,
                    modifier = Modifier
                        .minimumInteractiveComponentSize()
                        .semantics { role = Role.Button }
                        .softClickable { askMic.launch(Manifest.permission.RECORD_AUDIO) },
                )
            }
        }

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

        // Only ever shown when something is actually wrong. The wording is for
        // the person holding the phone; the reason goes to the log, where the
        // person who can fix it will look.
        val failed = mediaState.state == MediaState.Failed
        val mediaProblem = when {
            endedAfter != null -> null
            !state.mediaOffered -> "Audio isn't available right now"
            failed -> "Couldn't connect audio · Tap to retry"
            else -> null
        }
        if (mediaProblem != null) {
            LaunchedEffect(mediaState.error) {
                mediaState.error?.let { Log.w(TAG, "media failed: $it") }
            }
            val retry = failed && state.canRetry
            Text(
                mediaProblem,
                style = MaterialTheme.typography.labelSmall,
                color = colors.warning,
                textAlign = TextAlign.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(bottom = 12.dp)
                    .then(
                        if (retry) {
                            Modifier
                                .minimumInteractiveComponentSize()
                                .semantics { role = Role.Button }
                                .softClickable { vm.retryMedia() }
                        } else {
                            Modifier
                        },
                    ),
            )
        }

        Row(
            Modifier.fillMaxWidth().padding(vertical = 16.dp),
            horizontalArrangement = Arrangement.SpaceEvenly,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            NeuIconButton(
                if (state.muted) Icons.Rounded.MicOff else Icons.Rounded.Mic,
                if (state.muted) "Unmute" else "Mute",
                onClick = {
                    // The heavy tick: muting is the one thing on a call you
                    // want to *feel* land, because you cannot hear the result.
                    haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                    vm.toggleMute()
                },
                enabled = state.micGranted && endedAfter == null,
                active = state.muted,
                size = 58.dp,
                iconSize = 24.dp,
            )

            NeuIconButton(
                Icons.Rounded.VolumeUp,
                "Speaker",
                onClick = {
                    haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                    vm.toggleSpeaker()
                },
                // `active` is both the pressed-in look and, since the
                // components gained state descriptions, the word TalkBack
                // reads ("On"). It has to mean "speaker on", which is what
                // the flag already is — the old `!speaker` inverted the
                // announcement.
                active = state.speaker,
                enabled = endedAfter == null,
                size = 58.dp,
                iconSize = 24.dp,
            )

            // Red, like the decline button on the ring and like every phone
            // ever made. Violet is the colour of "confirm" everywhere else in
            // the app, and hanging up is the one thing here nobody should
            // confirm by accident.
            NeuIconButton(
                Icons.Rounded.CallEnd,
                "End call",
                onClick = hangUp,
                fillColor = colors.danger,
                tint = colors.onAccent,
                enabled = endedAfter == null,
                size = 66.dp,
                iconSize = 27.dp,
            )
        }
    }
}

/**
 * The view's context is usually a theme wrapper around the activity rather
 * than the activity itself; unwrap until something owns a window.
 */
private tailrec fun Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}
