package gg.yappy.app.data

import java.util.concurrent.ConcurrentHashMap

/**
 * Just enough of a conversation to draw its header on the first frame.
 *
 * Opening a chat fetches the conversation, and until that lands the header has
 * nothing to show — which is why moving between channels flashed "…" and then
 * the real name, once per hop. The list that sent you here already knew the
 * name, so it leaves it behind.
 *
 * Deliberately not a [Conversation]: a channel row in a space is a
 * [ChannelEntry], not a conversation, and inventing a half-populated
 * `Conversation` from one would put a fake object into a cache that other code
 * could mistake for real.
 */
data class ChatHeaderSeed(
    val title: String,
    val avatarUrl: String? = null,
    val avatarSeed: String,
    val badge: String? = null,
    val appearance: ConversationAppearance? = null,
    val subtitle: String? = null,
    val isGroup: Boolean = false,
    /**
     * The space a channel belongs to, when known. Lets an external entry —
     * a notification, a link — put the space *under* the channel so Back
     * lands somewhere sensible instead of straight on the home list.
     */
    val parentId: String? = null,
)

/**
 * Seeds the app has picked up while showing lists.
 *
 * Not a `StateFlow`: this is read once when a chat opens, and republishing it
 * on every conversation-list refresh would redraw every screen observing the
 * container for something none of them display. A concurrent map because the
 * writers are list loads on background dispatchers and the reader is the UI.
 */
class HeaderSeedCache {

    private val seeds = ConcurrentHashMap<String, ChatHeaderSeed>()

    operator fun get(id: String): ChatHeaderSeed? = seeds[id]

    fun remember(conversation: Conversation) {
        seeds[conversation.id] = ChatHeaderSeed(
            title = conversation.displayName,
            avatarUrl = conversation.displayAvatar,
            avatarSeed = conversation.avatarSeed,
            badge = if (conversation.type == "dm") conversation.otherUser?.badge else conversation.badge,
            appearance = conversation.appearance,
            subtitle = subtitleFor(conversation),
            isGroup = conversation.type != "dm",
            parentId = conversation.parentId,
        )
    }

    fun remember(conversations: List<Conversation>) {
        conversations.forEach { remember(it) }
    }

    /**
     * A channel inherits its space's look: the avatar, the flair and the badge
     * all belong to the place, and a channel that dropped them would look like
     * a different room for the half-second before its own fetch returns.
     */
    fun remember(channel: ChannelEntry, space: Conversation) {
        seeds[channel.id] = ChatHeaderSeed(
            title = channel.title ?: "channel",
            avatarUrl = space.displayAvatar,
            avatarSeed = space.avatarSeed,
            badge = space.badge,
            appearance = space.appearance,
            subtitle = "in ${space.displayName} · ${space.memberCount} members",
            isGroup = true,
            parentId = space.id,
        )
    }

    fun clear() = seeds.clear()

    private fun subtitleFor(conversation: Conversation): String? = when {
        conversation.type == "dm" -> conversation.otherUser?.username?.let { "@$it" }
        conversation.parentTitle != null ->
            "in ${conversation.parentTitle} · ${conversation.memberCount} members"
        else -> "${conversation.memberCount} members"
    }
}
