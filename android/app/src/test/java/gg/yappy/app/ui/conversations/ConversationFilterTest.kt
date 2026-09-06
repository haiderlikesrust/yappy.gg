package gg.yappy.app.ui.conversations

import gg.yappy.app.data.Conversation
import gg.yappy.app.data.SelfState
import org.junit.Assert.assertEquals
import org.junit.Test

class ConversationFilterTest {
    private val conversations = listOf(
        Conversation("dm", "dm", self = SelfState(unreadCount = 2)),
        Conversation("group", "group", self = SelfState(unreadCount = 0)),
        Conversation("space", "space", self = SelfState(unreadCount = 5)),
        Conversation("channel", "channel", self = SelfState(unreadCount = 1, notificationLevel = "none")),
        Conversation("legacy", "dm"),
    )

    @Test fun `places include spaces and channels while people contain only DMs`() {
        assertEquals(listOf("group", "space", "channel"), ids(ConversationFilter.Places))
        assertEquals(listOf("dm", "legacy"), ids(ConversationFilter.People))
    }

    @Test fun `unread uses unread counts including muted conversations and tolerates missing self state`() {
        assertEquals(listOf("dm", "space", "channel"), ids(ConversationFilter.Unread))
        val read = conversations.map { it.copy(self = it.self?.copy(unreadCount = 0)) }
        assertEquals(emptyList<Conversation>(), read.filter(ConversationFilter.Unread::accepts))
    }

    @Test fun `all preserves the supplied order and conversations`() {
        assertEquals(conversations, conversations.filter(ConversationFilter.All::accepts))
    }

    @Test fun `search and archive cannot silently hide results behind a home filter`() {
        for (filter in ConversationFilter.entries) {
            assertEquals(ConversationFilter.All, filter.forContext("design", false))
            assertEquals(ConversationFilter.All, filter.forContext("", true))
            assertEquals(ConversationFilter.All, filter.forContext("design", true))
            assertEquals(filter, filter.forContext("", false))
            assertEquals(filter, filter.forContext("  ", false))
        }
    }

    private fun ids(filter: ConversationFilter) = conversations.filter(filter::accepts).map { it.id }
}
