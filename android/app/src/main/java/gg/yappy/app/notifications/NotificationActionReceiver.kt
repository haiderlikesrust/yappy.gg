package gg.yappy.app.notifications

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.RemoteInput
import gg.yappy.app.YappyApplication
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * The two notification buttons, landing without the app opening.
 *
 * A [BroadcastReceiver] rather than an activity because the entire point is
 * that nothing appears on screen: reply sends and the shade stays where it
 * was; mark-as-read moves the watermark and the notification leaves.
 *
 * The work is network, so [goAsync] — the process is kept alive for the
 * request (~10s allowance) instead of being killable the moment onReceive
 * returns. On failure the reply is NOT silently dropped: the notification is
 * left standing so the words are still in the shade's history, which is the
 * only place they exist — there is no composer holding a draft out here.
 */
class NotificationActionReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val conversationId = intent.getStringExtra(EXTRA_CONVERSATION) ?: return
        val app = context.applicationContext as? YappyApplication ?: return
        val repo = app.container.repo

        when (intent.action) {
            ACTION_REPLY -> {
                val text = RemoteInput.getResultsFromIntent(intent)
                    ?.getCharSequence(MessageNotifications.KEY_REMOTE_REPLY)
                    ?.toString()?.trim()
                if (text.isNullOrEmpty()) return

                val pending = goAsync()
                scope.launch {
                    runCatching { repo.sendText(conversationId, text) }
                        .onSuccess {
                            MessageNotifications.appendOwnReply(context, conversationId, text)
                            // Replying is reading — the ticks should say so
                            // without the app ever having come to the front.
                            runCatching { repo.markRead(conversationId, it.message.seq) }
                        }
                    pending.finish()
                }
            }

            ACTION_MARK_READ -> {
                val seq = intent.getStringExtra(EXTRA_SEQ)?.toLongOrNull()
                MessageNotifications.dismiss(context, conversationId)
                if (seq == null) return

                val pending = goAsync()
                scope.launch {
                    runCatching { repo.markRead(conversationId, seq) }
                    pending.finish()
                }
            }
        }
    }

    companion object {
        private const val ACTION_REPLY = "gg.yappy.app.NOTIFICATION_REPLY"
        private const val ACTION_MARK_READ = "gg.yappy.app.NOTIFICATION_MARK_READ"
        private const val EXTRA_CONVERSATION = "conversationId"
        private const val EXTRA_SEQ = "seq"

        /** Receiver-lifetime scope; each action is one short request. */
        private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

        fun reply(context: Context, conversationId: String): Intent =
            Intent(context, NotificationActionReceiver::class.java)
                .setAction(ACTION_REPLY)
                .putExtra(EXTRA_CONVERSATION, conversationId)

        fun markRead(context: Context, conversationId: String, seq: String?): Intent =
            Intent(context, NotificationActionReceiver::class.java)
                .setAction(ACTION_MARK_READ)
                .putExtra(EXTRA_CONVERSATION, conversationId)
                .putExtra(EXTRA_SEQ, seq)
    }
}
