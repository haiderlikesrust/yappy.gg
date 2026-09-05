package gg.yappy.app.data

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.os.IBinder
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import gg.yappy.app.MainActivity
import gg.yappy.app.R
import gg.yappy.app.YappyApplication
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.time.Instant

/** A call ringing on this device, whatever woke us to learn about it. */
data class IncomingCall(
    val callId: String,
    val callerName: String,
    val video: Boolean,
    val conversationId: String? = null,
)

/**
 * The system half of calling.
 *
 * A phone must ring when the app is closed. Android's answer is a full-screen
 * intent on a high-importance channel: the notification promotes itself to a
 * whole screen while the device is locked, and shows as a heads-up banner with
 * Answer and Decline while it is not. That is what this owns.
 *
 * Two paths arrive here and they must not produce two rings:
 *
 *  - **FCM**, which is the only path when the app is not running.
 *  - **The gateway**, which is faster whenever the socket is up and is the only
 *    path on a build with no Firebase configuration at all.
 *
 * [ring] is idempotent per call id, so whichever lands second is a no-op.
 */
object CallCoordinator {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    private val _incoming = MutableStateFlow<IncomingCall?>(null)

    /** Non-null while a call is ringing on this device and unanswered. */
    val incoming: StateFlow<IncomingCall?> = _incoming.asStateFlow()

    private val _openCallId = MutableStateFlow<String?>(null)

    /**
     * Set when the in-app ring was answered and the UI should navigate to
     * the call. The root consumes it and puts it back to null.
     *
     * Only the in-app sheet sets this. A ring answered from the shade or the
     * lock screen reaches the call screen through its `yappy://call/` intent
     * instead, which the root treats as an external entry and cuts the stack
     * for. This one is an in-app tap: the chat underneath is where Back
     * should land when the call ends.
     */
    val openCallId: StateFlow<String?> = _openCallId.asStateFlow()

    /** Ids already reported, so the second path in is silent. */
    private val seen = mutableSetOf<String>()

    /**
     * The call this device is actually on, set by [adopt].
     *
     * The foreground service is one service for the whole app, so whoever
     * stops it stops the call. A call screen is cleared *after* the next call
     * has taken over — answer a second call and the first screen's teardown
     * lands a moment later — and a `call.end` for a call that already finished
     * can arrive over the gateway at any time. Both used to stop the service
     * under the live call, which froze the process and cut the mic the moment
     * anything else came to the front.
     */
    @Volatile
    private var activeCallId: String? = null

    private var ringTimeout: Job? = null

    private const val NOTIFICATION_ID = 0x0CA11

    // ── Ringing ──────────────────────────────────────────────────────────────

    /**
     * Report an incoming call. Safe to call twice for the same id.
     *
     * @param expiresAt The server's ring deadline. Ringing stops there even if
     *   every end event is lost — the same absolute-deadline rule the gateway
     *   protocol asks of clients.
     */
    fun ring(
        context: Context,
        callId: String,
        callerName: String,
        video: Boolean,
        expiresAt: String? = null,
        conversationId: String? = null,
    ) {
        synchronized(seen) {
            if (!seen.add(callId)) return
        }

        _incoming.value = IncomingCall(callId, callerName, video, conversationId)
        showRingNotification(context.applicationContext, callId, callerName, video)
        armTimeout(context.applicationContext, callId, expiresAt)
    }

    /** Answering the in-app ring: adopt the call and ask the UI to push the
     *  call screen over whatever is open. The notification's Answer goes
     *  through [adopt] plus its own intent — see [CallActionReceiver]. */
    fun answer(context: Context, callId: String) {
        adopt(context, callId)
        _openCallId.value = callId
    }

    /**
     * The call screen taking ownership of a call it is already showing.
     *
     * Everything `answer` does except requesting navigation. The screen used
     * to call `answer` on itself, believing the repeat harmless — but the
     * `openCallId` it set is precisely the signal the navigation root consumes
     * as "open the call screen", so every call screen spawned another: press
     * Call once and Connecting screens stacked for as long as the transition
     * animator could keep up, each one joining the call and wrestling the one
     * shared audio engine.
     */
    fun adopt(context: Context, callId: String) {
        stopRinging(context.applicationContext, callId)

        val app = context.applicationContext as? YappyApplication ?: return
        // The service keeps the process alive and the microphone legal while
        // the call runs; the screen adopts whatever it already connected.
        activeCallId = callId
        CallForegroundService.start(app, callId)
    }

    fun consumeOpen() {
        _openCallId.value = null
    }

    /** Declining, or a caller who hung up before anyone picked up. */
    fun decline(context: Context, callId: String) {
        stopRinging(context.applicationContext, callId)

        val app = context.applicationContext as? YappyApplication ?: return
        app.container.scope.launch {
            runCatching { app.container.repo.declineCall(callId) }
        }
    }

    /** The call ended for any reason — remote hang-up, timeout, our own leave. */
    fun ended(context: Context, callId: String) {
        stopRinging(context.applicationContext, callId)
        // Only the call that owns the service may stop it — see [activeCallId].
        if (activeCallId != null && activeCallId != callId) return
        activeCallId = null
        CallForegroundService.stop(context.applicationContext)
    }

    /**
     * Another of this device's paths already dealt with the call: it was
     * answered elsewhere, declined elsewhere, or the caller gave up.
     */
    private fun stopRinging(context: Context, callId: String) {
        ringTimeout?.cancel()
        ringTimeout = null
        if (_incoming.value?.callId == callId) _incoming.value = null
        runCatching { NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID) }
    }

    /** Sign-out, or a reset: nothing this account was in survives into the next. */
    fun reset(context: Context) {
        ringTimeout?.cancel()
        ringTimeout = null
        _incoming.value = null
        _openCallId.value = null
        activeCallId = null
        synchronized(seen) { seen.clear() }
        runCatching { NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID) }
        CallForegroundService.stop(context)
    }

    private fun armTimeout(context: Context, callId: String, expiresAt: String?) {
        ringTimeout?.cancel()
        val seconds = expiresAt
            ?.let { runCatching { Instant.parse(it).epochSecond - Instant.now().epochSecond }.getOrNull() }
            ?.coerceIn(1, 120)
            ?: 45L

        ringTimeout = scope.launch {
            delay(seconds * 1000)
            if (_incoming.value?.callId == callId) stopRinging(context, callId)
        }
    }

    // ── The notification ─────────────────────────────────────────────────────

    /**
     * A `CallStyle` notification on the calls channel.
     *
     * `setFullScreenIntent` is what turns this into a ringing screen on a
     * locked device. On Android 14+ it needs `USE_FULL_SCREEN_INTENT`, which is
     * granted at install for apps whose declared purpose is calling; without it
     * the notification degrades to a heads-up banner, which still rings and
     * still has both buttons.
     */
    private fun showRingNotification(
        context: Context,
        callId: String,
        callerName: String,
        video: Boolean,
    ) {
        val fullScreen = PendingIntent.getActivity(
            context,
            callId.hashCode(),
            Intent(
                Intent.ACTION_VIEW,
                Uri.parse("yappy://call/$callId"),
                context,
                MainActivity::class.java,
            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val answer = PendingIntent.getBroadcast(
            context,
            callId.hashCode() + 1,
            Intent(context, CallActionReceiver::class.java)
                .setAction(CallActionReceiver.ACTION_ANSWER)
                .putExtra(CallActionReceiver.EXTRA_CALL_ID, callId),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val decline = PendingIntent.getBroadcast(
            context,
            callId.hashCode() + 2,
            Intent(context, CallActionReceiver::class.java)
                .setAction(CallActionReceiver.ACTION_DECLINE)
                .putExtra(CallActionReceiver.EXTRA_CALL_ID, callId),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val caller = androidx.core.app.Person.Builder().setName(callerName).setImportant(true).build()

        val notification = NotificationCompat.Builder(context, "calls")
            .setSmallIcon(R.drawable.logo_mark)
            .setContentTitle(callerName)
            .setContentText(if (video) "Incoming video call" else "Incoming voice call")
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setStyle(NotificationCompat.CallStyle.forIncomingCall(caller, decline, answer))
            // Ongoing: a ring must not be swiped away by accident, and the two
            // buttons are the only way to resolve it.
            .setOngoing(true)
            .setAutoCancel(false)
            .setFullScreenIntent(fullScreen, true)
            .setContentIntent(fullScreen)
            .build()

        runCatching { NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, notification) }
            .onFailure {
                // POST_NOTIFICATIONS refused. The ring is lost, but the in-app
                // path still works, so this is not fatal.
            }

        vibrate(context)
    }

    /**
     * A pulse alongside the channel's own sound.
     *
     * The channel carries the ringtone; the vibration is separate because a
     * phone face-down on a desk is the case a ring most needs to survive.
     */
    private fun vibrate(context: Context) {
        runCatching {
            val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                (context.getSystemService(VibratorManager::class.java))?.defaultVibrator
            } else {
                @Suppress("DEPRECATION")
                context.getSystemService(Vibrator::class.java)
            } ?: return

            val pattern = longArrayOf(0, 700, 600, 700, 600)
            vibrator.vibrate(
                VibrationEffect.createWaveform(pattern, 0),
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                    .build(),
            )

            scope.launch {
                delay(30_000)
                runCatching { vibrator.cancel() }
            }
        }
    }

    /** The system ringtone, for the calls channel to use. */
    fun ringtoneUri(): Uri? =
        runCatching { RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE) }.getOrNull()
}

/**
 * Answer and Decline from the notification.
 *
 * A broadcast rather than an activity for Decline: hanging up should not have
 * to open the app, and on a locked device an activity would demand the user
 * unlock first just to say no.
 */
class CallActionReceiver : android.content.BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val callId = intent.getStringExtra(EXTRA_CALL_ID) ?: return

        when (intent.action) {
            ACTION_DECLINE -> CallCoordinator.decline(context, callId)

            ACTION_ANSWER -> {
                // `adopt`, not `answer`: the intent below is what navigates.
                // It arrives as a deep link, which the root treats as an
                // external entry and cuts the stack back to home for — the
                // right thing for a call answered from the shade over
                // Settings › About. Setting `openCallId` as well made the root
                // navigate twice, and made the in-app ring's answer, which
                // shares that signal, take the external route too: answering
                // from inside a chat then dumped you on the home list when
                // the call ended.
                CallCoordinator.adopt(context, callId)
                // Answering does need the app: there is a call screen to show,
                // and the OS dismisses the keyguard for a call intent.
                context.startActivity(
                    Intent(
                        Intent.ACTION_VIEW,
                        Uri.parse("yappy://call/$callId"),
                        context,
                        MainActivity::class.java,
                    ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
                )
            }
        }
    }

    companion object {
        const val ACTION_ANSWER = "gg.yappy.app.CALL_ANSWER"
        const val ACTION_DECLINE = "gg.yappy.app.CALL_DECLINE"
        const val EXTRA_CALL_ID = "callId"
    }
}

/**
 * Keeps the process alive for the duration of a call.
 *
 * Without a foreground service Android freezes the process once it is cached,
 * which cuts the microphone mid-sentence the moment someone switches apps. The
 * `microphone` service type is what makes holding the mic while backgrounded
 * legal on Android 14+, and it is declared in the manifest alongside the
 * matching runtime permission.
 */
class CallForegroundService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val callId = intent?.getStringExtra(EXTRA_CALL_ID)
        if (callId == null) {
            stopSelf()
            return START_NOT_STICKY
        }

        val open = PendingIntent.getActivity(
            this,
            callId.hashCode(),
            Intent(
                Intent.ACTION_VIEW,
                Uri.parse("yappy://call/$callId"),
                this,
                MainActivity::class.java,
            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val notification: Notification = NotificationCompat.Builder(this, "calls")
            .setSmallIcon(R.drawable.logo_mark)
            .setContentTitle("Call in progress")
            .setContentText("Tap to return to the call")
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setOngoing(true)
            .setContentIntent(open)
            // The ring already made its noise; the ongoing notice must not
            // make it a second time on every update.
            .setSilent(true)
            .build()

        runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(
                    ONGOING_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
                )
            } else {
                startForeground(ONGOING_ID, notification)
            }
        }.onFailure {
            // Denied the microphone, or started from the background on a
            // version that forbids it. The call still runs while the app is
            // foreground; it simply will not survive being backgrounded.
            stopSelf()
        }

        return START_NOT_STICKY
    }

    companion object {
        private const val ONGOING_ID = 0x0CA12
        private const val EXTRA_CALL_ID = "callId"

        fun start(context: Context, callId: String) {
            runCatching {
                val intent = Intent(context, CallForegroundService::class.java)
                    .putExtra(EXTRA_CALL_ID, callId)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(intent)
                } else {
                    context.startService(intent)
                }
            }
        }

        fun stop(context: Context) {
            runCatching { context.stopService(Intent(context, CallForegroundService::class.java)) }
        }
    }
}
