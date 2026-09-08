package gg.yappy.app.data

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import gg.yappy.app.MainActivity
import gg.yappy.app.R
import gg.yappy.app.YappyApplication
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.cancel

/**
 * A voice hangout, kept alive and reachable while the app is not.
 *
 * A call has had a foreground service since calls existed; a voice channel
 * never did. So dropping into one and then switching apps handed the process
 * to Android to freeze at its convenience, which cuts the microphone
 * mid-sentence — the exact failure the call service exists to prevent, on the
 * feature people leave running the longest. Drop-in voice is meant to be
 * something you stay in while doing something else; that is the whole idea,
 * and it was the one thing it could not do.
 *
 * Its own service rather than a second mode on [CallForegroundService]: the
 * two can be told apart at a glance here, they carry different actions, and
 * a call and a voice session are never live at the same time anyway (the
 * engine is single-owner — see [CallEngine]), so nothing is lost by keeping
 * them separate and a good deal of branching is avoided.
 *
 * The notification is the remote control. Mute and speaker are the two things
 * you reach for without wanting to look at the phone, and they are safe to
 * put here because a voice session's state lives in [VoiceChannels] rather
 * than in a screen — there is no button somewhere else to fall out of step
 * with, which is not true of a call.
 */
class VoiceService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        // A fast failed/cancelled join can clear the session before Android
        // dispatches onStartCommand. Fulfil startForegroundService's promise
        // before looking at that session, even when we will stop immediately.
        val starting = NotificationCompat.Builder(this, "calls")
            .setSmallIcon(R.drawable.logo_mark)
            .setContentTitle("Voice")
            .setContentText("Connecting to voice…")
            .setOngoing(true)
            .setSilent(true)
            .build()
        promote(starting)
        active = this
        startPending = false
    }

    override fun onDestroy() {
        if (active === this) active = null
        super.onDestroy()
    }

    private fun promote(notification: Notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val mic = androidx.core.content.ContextCompat.checkSelfPermission(this, android.Manifest.permission.RECORD_AUDIO) == android.content.pm.PackageManager.PERMISSION_GRANTED
            val type = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK or
                if (mic) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0
            // A permission can be revoked, or the activity backgrounded,
            // between the check and the call. Keep listen-only service alive.
            try { startForeground(ONGOING_ID, notification, type) }
            catch (_: SecurityException) {
                startForeground(ONGOING_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
            }
        } else startForeground(ONGOING_ID, notification)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val app = applicationContext as? YappyApplication
        val session = app?.container?.voiceChannels?.session?.value
        if (session == null) {
            if (active === this) active = null
            stopSelf()
            return START_NOT_STICKY
        }

        val open = PendingIntent.getActivity(
            this,
            session.spaceId.hashCode(),
            Intent(
                Intent.ACTION_VIEW,
                Uri.parse("yappy://conversation/${session.spaceId}"),
                this,
                MainActivity::class.java,
            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        fun action(label: String, act: String) = NotificationCompat.Action.Builder(
            0,
            label,
            PendingIntent.getBroadcast(
                this,
                act.hashCode(),
                Intent(this, VoiceActionReceiver::class.java).setAction(act)
                    .setData(Uri.parse("yappy://voice-action/${session.channelId}/${session.generation}/$act"))
                    .putExtra("channelId", session.channelId).putExtra("generation", session.generation),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            ),
        ).build()

        val speakerOn = app.container.voiceChannels.speakerOn.value
        val notification: Notification = NotificationCompat.Builder(this, "calls")
            .setSmallIcon(R.drawable.logo_mark)
            .setContentTitle(session.title)
            .setContentText(if (!session.connected) "Connecting to voice…" else if (session.muted) "In voice · muted" else "In voice")
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setOngoing(true)
            .setContentIntent(open)
            // The ring already made its noise, and this one updates on every
            // mute — it must not make a sound each time.
            .setSilent(true)
            .addAction(action(if (session.muted) "Unmute" else "Mute", VoiceActionReceiver.ACTION_MUTE))
            .addAction(
                action(
                    if (speakerOn) "Earpiece" else "Speaker",
                    VoiceActionReceiver.ACTION_SPEAKER,
                ),
            )
            .addAction(action("Leave", VoiceActionReceiver.ACTION_LEAVE))
            .build()

        runCatching {
            promote(notification)
        }.onFailure {
            // Denied the microphone, or started from the background on a
            // version that forbids it. The session still runs while the app is
            // in front; it simply will not survive being backgrounded.
            stopSelf()
        }

        return START_NOT_STICKY
    }

    companion object {
        // Deliberately not CallForegroundService's id: a call and a voice
        // session cannot both be live, but a stale one of either must not be
        // able to replace the other's notification if that ever changes.
        private const val ONGOING_ID = 0x0CA13
        // Accessed on the main thread by the session and service callbacks.
        private var active: VoiceService? = null
        private var startPending = false

        /** Also the way the notification is refreshed — same id, new content. */
        fun start(context: Context) {
            active?.let {
                // Refresh an already promoted service without creating a new
                // foreground-start obligation for every mute/speaker tap.
                it.onStartCommand(null, 0, 0)
                return
            }
            if (startPending) return
            startPending = true
            runCatching {
                val intent = Intent(context, VoiceService::class.java)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(intent)
                } else {
                    context.startService(intent)
                }
            }.onFailure { startPending = false }
        }

        fun stop(context: Context) {
            // Never stop a pending start before it has been promoted. Android
            // can retain the foreground timeout even after stopService, then
            // kill the app later. onStartCommand sees the absent session and
            // stops itself after onCreate has fulfilled the obligation.
            active?.let {
                active = null
                it.stopSelf()
            }
        }
    }
}

/**
 * Mute, speaker and leave, from the shade.
 *
 * A broadcast rather than an activity: none of these is a reason to bring the
 * app to the front, and on a locked device an activity would demand an unlock
 * to turn a microphone off.
 */
class VoiceActionReceiver : android.content.BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val app = context.applicationContext as? YappyApplication ?: return
        val voice = app.container.voiceChannels
        val session = voice.session.value ?: return
        if (intent.getStringExtra("channelId") != session.channelId) return
        if (intent.getLongExtra("generation", -1) != session.generation) return

        // The receiver's own scope: `onReceive` returns immediately and these
        // suspend, and a coroutine started on a scope that dies with the
        // broadcast would be cancelled before the microphone was touched.
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        val pending = goAsync()
        scope.launch {
            try {
                when (intent.action) {
                    ACTION_MUTE -> voice.setMuted(!session.muted)
                    ACTION_SPEAKER -> voice.setSpeaker(!voice.speakerOn.value)
                    ACTION_LEAVE -> voice.leave()
                }
            } finally { pending.finish(); scope.cancel() }
        }
    }

    companion object {
        const val ACTION_MUTE = "gg.yappy.app.VOICE_MUTE"
        const val ACTION_SPEAKER = "gg.yappy.app.VOICE_SPEAKER"
        const val ACTION_LEAVE = "gg.yappy.app.VOICE_LEAVE"
    }
}
