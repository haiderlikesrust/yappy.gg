package gg.yappy.app.data

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import androidx.core.app.Person
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import gg.yappy.app.MainActivity
import java.net.URL

/**
 * Recent conversations, published to the OS.
 *
 * One list of [ShortcutInfoCompat] buys three separate surfaces at once:
 * long-press on the launcher icon shows recent chats; the system share sheet
 * offers them as direct targets (the share-target declaration in
 * res/xml/shortcuts.xml matches on [SHARE_CATEGORY]); and a notification
 * carrying the same id via `setShortcutId` is promoted into the shade's
 * Conversations section, faces and all.
 *
 * Published after every conversation-list load rather than on a schedule —
 * the list the person just looked at is by definition current.
 */
object ConversationShortcuts {

    private const val SHARE_CATEGORY = "gg.yappy.app.category.SHARE_TARGET"
    private const val MAX = 4

    suspend fun publish(context: Context, conversations: List<Conversation>) {
        val top = conversations
            .filterNot { it.isSpace }
            .take(MAX)
        if (top.isEmpty()) return

        val shortcuts = top.mapIndexed { rank, conversation ->
            val title = conversation.displayTitle()
            val person = Person.Builder().setName(title).setKey(conversation.id).build()

            ShortcutInfoCompat.Builder(context, conversation.id)
                .setShortLabel(title.ifBlank { "Chat" })
                .setLongLived(true)
                .setRank(rank)
                .setPerson(person)
                .setCategories(setOf(SHARE_CATEGORY))
                .setIcon(iconFor(conversation, title))
                .setIntent(
                    Intent(
                        Intent.ACTION_VIEW,
                        Uri.parse("yappy://conversation/${conversation.id}"),
                        context,
                        MainActivity::class.java,
                    ),
                )
                .build()
        }

        runCatching {
            // Replace wholesale: the alternative is diffing against what the OS
            // holds, and four small icons are not worth being clever about.
            ShortcutManagerCompat.removeAllDynamicShortcuts(context)
            ShortcutManagerCompat.addDynamicShortcuts(context, shortcuts)
        }
    }

    private fun Conversation.displayTitle(): String =
        title?.takeIf { it.isNotBlank() }
            ?: otherUser?.label
            ?: "Chat"

    /**
     * The real picture when it can be had quickly, the letter tile otherwise.
     *
     * A blocking fetch is acceptable here because publish() already runs on a
     * background dispatcher and the images are avatar-sized; a miss just means
     * the deterministic letter tile, which is what the app shows anyway.
     */
    private fun iconFor(conversation: Conversation, title: String): IconCompat {
        val url = conversation.avatarUrl ?: conversation.otherUser?.avatarUrl
        if (url != null) {
            val fetched = runCatching {
                URL(url).openStream().use { BitmapFactory.decodeStream(it) }
            }.getOrNull()
            if (fetched != null) return IconCompat.createWithAdaptiveBitmap(square(fetched))
        }
        return LetterTiles.icon(conversation.id, title)
    }

    /** Adaptive icons want a square source; center-crop whatever arrived. */
    private fun square(source: Bitmap): Bitmap {
        val side = minOf(source.width, source.height)
        val x = (source.width - side) / 2
        val y = (source.height - side) / 2
        return Bitmap.createBitmap(source, x, y, side, side)
    }
}
