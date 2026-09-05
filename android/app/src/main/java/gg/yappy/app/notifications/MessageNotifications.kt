package gg.yappy.app.notifications

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import androidx.compose.ui.graphics.toArgb
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.app.RemoteInput
import androidx.core.content.LocusIdCompat
import androidx.core.graphics.drawable.IconCompat
import gg.yappy.app.MainActivity
import gg.yappy.app.R
import gg.yappy.app.YappyApplication
import gg.yappy.app.data.LetterTiles
import gg.yappy.app.ui.theme.LightNeuColors
import okhttp3.Request
import java.util.concurrent.TimeUnit

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

    /**
     * The light theme's accent. The shade tints the small icon and the app
     * name with it; left unset, both drew in Material's default grey and the
     * notification read as anybody's. Read from the palette rather than
     * retyped, so a shade change lands here too; the light one on purpose,
     * because the shade has its own light and dark and re-tones for contrast.
     */
    private val ACCENT = LightNeuColors.accent.toArgb()

    /** Pixels for a face in the shade; the letter tile is drawn at the same size. */
    private const val AVATAR_PX = 128

    /**
     * Fetching a face may not delay the message.
     *
     * FCM gives a data push a few seconds on a background thread; the
     * conversation must be in the shade well inside them, so the avatar gets
     * two of those seconds and then the letter tile wins.
     */
    private const val AVATAR_TIMEOUT_MS = 2_000L

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

        // The real face when the server sent one and it arrives in time; the
        // letter tile otherwise, which is what the app itself falls back to.
        val sender = Person.Builder()
            .setName(senderName)
            .setKey(data["senderId"] ?: senderName)
            .setIcon(
                data["senderAvatarUrl"]?.let { fetchAvatar(context, it) }
                    ?: letterIcon(data["senderId"] ?: conversationId, senderName),
            )
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
            .setColor(ACCENT)
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
            // The same identity for the OS's own bookkeeping: with it, the
            // launcher can rank the shortcut by use and a bubble that is
            // already open for this chat is recognised as the same one.
            .setLocusId(LocusIdCompat(conversationId))
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

    /**
     * The sender's avatar as an adaptive icon, or null if it cannot be had
     * quickly. Blocking on purpose: this runs on FCM's background thread,
     * where a coroutine would only add a hop. The URL is a public-bucket one
     * (the worker's push job says so), so no token rides along — the shared
     * client is used for its connection pool, not its credentials. Downsized
     * on decode so a full-resolution upload does not become a 128px face the
     * expensive way.
     */
    private fun fetchAvatar(context: Context, url: String): IconCompat? {
        val http = (context.applicationContext as? YappyApplication)?.container?.api?.http ?: return null
        return runCatching {
            val client = http.newBuilder()
                .callTimeout(AVATAR_TIMEOUT_MS, TimeUnit.MILLISECONDS)
                .build()
            client.newCall(Request.Builder().url(url).build()).execute().use { response ->
                if (!response.isSuccessful) return null
                val bytes = response.body?.bytes() ?: return null
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
                var sample = 1
                while (bounds.outWidth / (sample * 2) >= AVATAR_PX && bounds.outHeight / (sample * 2) >= AVATAR_PX) {
                    sample *= 2
                }
                val decoded = BitmapFactory.decodeByteArray(
                    bytes,
                    0,
                    bytes.size,
                    BitmapFactory.Options().apply { inSampleSize = sample },
                ) ?: return null
                IconCompat.createWithAdaptiveBitmap(Bitmap.createScaledBitmap(decoded, AVATAR_PX, AVATAR_PX, true))
            }
        }.getOrNull()
    }
}
