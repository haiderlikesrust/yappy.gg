package gg.yappy.app.data

import android.Manifest
import android.app.NotificationManager
import android.content.Context
import android.content.pm.PackageManager
import android.util.Log
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import gg.yappy.app.YappyApplication
import gg.yappy.app.notifications.MessageNotifications
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

private const val TAG = "yappy.push"

/**
 * Push registration.
 *
 * The server's worker already speaks FCM (`apps/worker/src/lib/fcm.ts`) and the
 * notification channels it addresses already exist in [YappyApplication] — the
 * missing half was the client: fetch a token, hand it to
 * `PUT /devices/me/push`, and route a tap back into the conversation.
 *
 * Permission is asked for *after* sign-in rather than at first launch. A prompt
 * on the very first screen, before the person has seen a single message, is the
 * one most reliably denied, and on Android 13+ two denials make it permanent.
 */
class PushRegistrar(
    private val context: Context,
    private val repo: YappyRepository,
    private val scope: CoroutineScope,
) {

    /** The token most recently sent, so a re-register with nothing new is a
     *  no-op instead of a redundant PUT on every foreground. */
    @Volatile
    private var sentToken: String? = null

    /**
     * Fetch the current token and register it. Safe to call repeatedly.
     *
     * Silently does nothing when Firebase was never configured — see
     * [YappyApplication.initialiseFirebase]. The app keeps working without
     * push, which is the right failure mode for a build someone is running
     * against a local backend.
     */
    suspend fun register() {
        val token = currentToken() ?: return
        if (token == sentToken) return
        runCatching { repo.registerPush(token) }
            .onSuccess { sentToken = token }
            .onFailure { Log.w(TAG, "push registration failed: ${it.message}") }
    }

    /** A token that arrived from [YappyPushService] while the app was running. */
    fun onNewToken(token: String) {
        scope.launch {
            if (token == sentToken) return@launch
            runCatching { repo.registerPush(token) }.onSuccess { sentToken = token }
        }
    }

    /**
     * Sign-out. The device row keeps its token otherwise, and the next person
     * to sign in on this handset would inherit the previous account's pushes
     * until their own registration overwrote it.
     */
    suspend fun unregister() {
        sentToken = null
        runCatching {
            suspendCancellableCoroutine { cont ->
                FirebaseMessaging.getInstance().deleteToken()
                    .addOnCompleteListener { cont.resume(Unit) }
            }
        }
        NotificationManagerCompat.from(context).cancelAll()
    }

    private suspend fun currentToken(): String? = runCatching {
        suspendCancellableCoroutine { cont ->
            FirebaseMessaging.getInstance().token
                .addOnSuccessListener { cont.resume(it) }
                .addOnFailureListener {
                    Log.w(TAG, "no FCM token: ${it.message}")
                    cont.resume(null)
                }
        }
    }.getOrNull()

    companion object {
        /** Whether the OS will let us post anything at all. */
        fun canPost(context: Context): Boolean =
            android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.TIRAMISU ||
                ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
                PackageManager.PERMISSION_GRANTED
    }
}

/**
 * Inbound push.
 *
 * Two jobs. Message and reaction pushes arrive with a `notification` block, so
 * the OS has already drawn them while the app was backgrounded and this only
 * needs to route the tap — the payload still comes through here so the deep
 * link is built from `data` rather than guessed from a title.
 *
 * Call pushes are the interesting case: they must ring, full-screen, whether or
 * not the app is running, which is [CallCoordinator]'s job.
 */
class YappyPushService : FirebaseMessagingService() {

    override fun onNewToken(token: String) {
        val app = application as? YappyApplication ?: return
        app.container.push.onNewToken(token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data
        val app = application as? YappyApplication

        when (data["type"]) {
            "call" -> {
                val callId = data["callId"] ?: return
                CallCoordinator.ring(
                    context = applicationContext,
                    callId = callId,
                    callerName = data["callerName"] ?: message.notification?.title ?: "yappy",
                    video = data["mode"] == "video",
                    expiresAt = data["expiresAt"],
                )
            }

            "message", "mention", "reaction" -> {
                val conversationId = data["conversationId"] ?: return

                // Already on screen. The gateway delivered this a second ago and
                // the messages are right there — a notification for the chat you
                // are reading is noise.
                if (app?.container?.foregroundConversationId == conversationId) return

                // A `notification` block means the OS drew it already and a
                // second one here would double up. The server stopped sending
                // the block (data-only unlocks MessagingStyle), so this guard
                // only fires against an old server.
                if (message.notification != null) return

                if (!PushRegistrar.canPost(this)) return
                MessageNotifications.show(this, data)
            }
        }
    }

}

/**
 * Clears message notifications — called when the app comes forward.
 *
 * A ring is left alone: the call is still happening, and cancelling its
 * notification because the user opened the app is how you lose the only control
 * that answers it.
 */
fun clearMessageNotifications(context: Context) {
    runCatching {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        manager.activeNotifications
            .filter { it.notification.channelId != "calls" }
            .forEach { manager.cancel(it.id) }
    }
}
