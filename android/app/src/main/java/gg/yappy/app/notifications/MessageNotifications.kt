package gg.yappy.app.notifications

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.app.RemoteInput
import androidx.core.graphics.drawable.IconCompat
import gg.yappy.app.MainActivity
import gg.yappy.app.R
import gg.yappy.app.data.LetterTiles

/**
 * The message notification, drawn by the app instead of the OS.
 *
 * Pushes used to arrive with a `notification` block, which meant the system
 * drew them: a title and two lines of grey text, and that is the ceiling — no
 * faces, no history, no way to answer. The block is gone from the server now
 * (see the worker's push job), every message push is data-only, and this is
 * what renders it.
 *
 * MessagingStyle is the whole upgrade: the notification is a conversation, not
 * an announcement. Each sender is a [Person] with a face, consecutive messages
 * stack into a visible history, the shade groups it under Conversations, and
 * two actions hang off it — an inline reply that sends without opening the
 * app, and mark-as-read for the message that needed seeing but not saying
 * anything back to.
 *
 * History note: the previous messages are *recovered from the posted
 * notification itself* via [NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification].
 * The process that drew message one may be long dead by message five; the
 * notification in the shade is the only place the thread reliably survives.
 */
object MessageNotifications {

    const val KEY_REMOTE_REPLY = "reply"
    private const val MAX_HISTORY = 8

    fun show(context: Context, data: Map<String, String>) {
        val conversationId = data["conversationId"] ?: return
        val body = data["body"].orEmpty().ifEmpty { "New message" }
        val title = data["title"].orEmpty().ifEmpty { "yappy" }

        // Separate sender/room fields arrive from 1.4.1 servers; an older
        // server's push still renders, just with the fused title as the name.
        val senderName = data["senderName"].orEmpty().ifEmpty { title }
        val isGroup = data["isGroup"] == "1"
        val conversationTitle = data["conversationTitle"].orEmpty().ifEmpty { title }
        // The server resolves the silent-preference variant; trust it, fall
        // back to the loud channel the way the server itself would.
        val channel = data["channel"].orEmpty().ifEmpty {
            if (data["type"] == "mention") "mentions" else "messages"
        }

        // A group body arrives as "Haider: hey" because the OS renderer had one
        // line for both. MessagingStyle has a Person slot for the name, so keep
        // only the words — with a guard for bodies that never carried a prefix
        // (previews off, media placeholders).
        val text = if (isGroup && body.startsWith("$senderName: ")) {
            body.removePrefix("$senderName: ")
        } else {
            body
        }

        val sender = Person.Builder()
            .setName(senderName)
            .setKey(data["senderId"] ?: senderName)
            .setIcon(letterIcon(data["senderId"] ?: conversationId, senderName))
            .build()

        // Required by MessagingStyle; never displayed for incoming messages.
        val me = Person.Builder().setName("You").build()

        val style = restoreStyle(context, conversationId, me)
            .setGroupConversation(isGroup)
            .setConversationTitle(if (isGroup) conversationTitle else null)
            .addMessage(text, System.currentTimeMillis(), sender)
        // Bound the thread: the shade shows a handful, and an unbounded
        // parcel eventually trips TransactionTooLargeException.
        while (style.messages.size > MAX_HISTORY) style.messages.removeAt(0)

        val id = conversationId.hashCode()
        val open = PendingIntent.getActivity(
            context,
            id,
            Intent(
                Intent.ACTION_VIEW,
                Uri.parse("yappy://conversation/$conversationId"),
                context,
                MainActivity::class.java,
            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        // The floating chat head. Opt-in per person in the OS's own UI — this
        // only declares that the conversation *can* float; the flare icon on
        // the notification is the OS asking whether it should.
        val bubbleIntent = PendingIntent.getActivity(
            context,
            id,
            Intent(
                Intent.ACTION_VIEW,
                Uri.parse("yappy://bubble/$conversationId"),
                context,
                gg.yappy.app.BubbleActivity::class.java,
            ),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
        )
        val bubble = NotificationCompat.BubbleMetadata.Builder(
            bubbleIntent,
            LetterTiles.icon(data["senderId"] ?: conversationId, senderName),
        )
            .setDesiredHeight(480)
            .build()

        val notification = NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.logo_mark)
            .setStyle(style)
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(open)
            .setGroup("conv:$conversationId")
            // Ties the notification to the published conversation shortcut,
            // which is what promotes it into the shade's Conversations section
            // and lets the launcher long-press show it.
            .setShortcutId(conversationId)
            .setBubbleMetadata(bubble)
            .addAction(replyAction(context, conversationId))
            .addAction(markReadAction(context, conversationId, data["seq"]))
            // Appending your own reply must not re-sound the channel.
            .setOnlyAlertOnce(false)
            .build()

        runCatching { NotificationManagerCompat.from(context).notify(id, notification) }
    }

    /**
     * Your reply, appended into the same thread.
     *
     * Without this the shade keeps showing only the message you already
     * answered, which reads as the reply having gone nowhere. Silent on
     * purpose: your own words are not news to you.
     */
    fun appendOwnReply(context: Context, conversationId: String, text: String) {
        val me = Person.Builder().setName("You").build()
        val style = restoreStyle(context, conversationId, me)
        style.addMessage(text, System.currentTimeMillis(), null as Person?)
        while (style.messages.size > MAX_HISTORY) style.messages.removeAt(0)

        val existing = activeNotification(context, conversationId) ?: return
        val rebuilt = NotificationCompat.Builder(context, existing)
            .setStyle(style)
            .setOnlyAlertOnce(true)
            .build()
        runCatching {
            NotificationManagerCompat.from(context).notify(conversationId.hashCode(), rebuilt)
        }
    }

    fun dismiss(context: Context, conversationId: String) {
        NotificationManagerCompat.from(context).cancel(conversationId.hashCode())
    }

    private fun restoreStyle(
        context: Context,
        conversationId: String,
        me: Person,
    ): NotificationCompat.MessagingStyle {
        val existing = activeNotification(context, conversationId)
        val restored = existing?.let {
            NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(it)
        }
        return restored ?: NotificationCompat.MessagingStyle(me)
    }

    private fun activeNotification(context: Context, conversationId: String): Notification? {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return null
        val id = conversationId.hashCode()
        return runCatching {
            manager.activeNotifications.firstOrNull { it.id == id }?.notification
        }.getOrNull()
    }

    private fun replyAction(context: Context, conversationId: String): NotificationCompat.Action {
        val remote = RemoteInput.Builder(KEY_REMOTE_REPLY).setLabel("Reply").build()
        val pending = PendingIntent.getBroadcast(
            context,
            conversationId.hashCode(),
            NotificationActionReceiver.reply(context, conversationId),
            // Mutable: the OS writes the typed text into this very intent.
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
        )
        return NotificationCompat.Action.Builder(R.drawable.logo_mark, "Reply", pending)
            .addRemoteInput(remote)
            .setAllowGeneratedReplies(true)
            .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY)
            .build()
    }

    private fun markReadAction(
        context: Context,
        conversationId: String,
        seq: String?,
    ): NotificationCompat.Action {
        val pending = PendingIntent.getBroadcast(
            context,
            // Distinct request code from reply, or the two PendingIntents
            // collapse into one and the second registered wins both buttons.
            conversationId.hashCode() + 1,
            NotificationActionReceiver.markRead(context, conversationId, seq),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Action.Builder(R.drawable.logo_mark, "Mark as read", pending)
            .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_MARK_AS_READ)
            .setShowsUserInterface(false)
            .build()
    }

    /** The shared letter tile, so the face in the shade matches the app's. */
    private fun letterIcon(id: String, name: String): IconCompat = LetterTiles.icon(id, name)
}
