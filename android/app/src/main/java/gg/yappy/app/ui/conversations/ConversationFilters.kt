package gg.yappy.app.ui.conversations

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.FolderOpen
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import gg.yappy.app.data.Conversation
import gg.yappy.app.data.ChatFolder
import gg.yappy.app.ui.components.QuietIconButton
import gg.yappy.app.ui.components.NeuButton
import gg.yappy.app.ui.components.softClickable
import gg.yappy.app.ui.theme.neuColors

internal enum class ConversationFilter(val label: String) {
    All("All"), Places("Places"), People("People"), Unread("Unread");

    fun accepts(conversation: Conversation): Boolean = when (this) {
        All -> true
        Places -> conversation.type != "dm"
        People -> conversation.type == "dm"
        Unread -> conversation.unread > 0
    }

    // Search and the archive always show their complete results. Remember the
    // home selection so clearing search returns to the same view.
    fun forContext(query: String, archived: Boolean): ConversationFilter =
        if (query.isNotBlank() || archived) All else this
}

@Composable
internal fun ConversationFilters(
    selected: ConversationFilter,
    folders: List<ChatFolder>,
    selectedFolder: String?,
    conversations: List<Conversation>,
    onFolderSelect: (String) -> Unit,
    onManageFolders: () -> Unit,
    onSelect: (ConversationFilter) -> Unit,
) {
    val colors = neuColors
    val scroll = rememberLazyListState()
    LaunchedEffect(selected, selectedFolder, folders.map { it.id }) {
        val index = folders.indexOfFirst { it.id == selectedFolder }
        scroll.animateScrollToItem(if (index >= 0) ConversationFilter.entries.size + index else selected.ordinal)
    }
    Row(Modifier.fillMaxWidth().padding(end = 8.dp), verticalAlignment = Alignment.CenterVertically) {
    LazyRow(
        Modifier.weight(1f).selectableGroup(),
        state = scroll,
        contentPadding = PaddingValues(start = 16.dp, end = 4.dp, top = 4.dp, bottom = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        items(ConversationFilter.entries, key = { it.name }) { filter ->
            val active = filter == selected && selectedFolder == null
            Text(
                filter.label,
                style = MaterialTheme.typography.labelLarge,
                color = if (active) colors.textPrimary else colors.textSecondary,
                modifier = Modifier.heightIn(min = 48.dp)
                    .clip(RoundedCornerShape(24.dp))
                    .background(if (active) colors.accentSoft else Color.Transparent)
                    .semantics { this.selected = active }
                    .softClickable(role = Role.Tab) { onSelect(filter) }
                    .padding(horizontal = 12.dp, vertical = 13.dp),
            )
        }
        items(folders, key = { "folder-${it.id}" }) { folder ->
            val active = folder.id == selectedFolder
            val unread = conversations.filter { it.id in folder.conversationIds }.sumOf { it.self?.unreadCount ?: 0 }
            Text(
                folder.name + if (unread > 0) " · ${if (unread > 99) "99+" else unread}" else "",
                style = MaterialTheme.typography.labelLarge,
                maxLines = 1,
                color = if (active) colors.textPrimary else colors.textSecondary,
                modifier = Modifier.heightIn(min = 48.dp)
                    .clip(RoundedCornerShape(24.dp))
                    .background(if (active) colors.accentSoft else Color.Transparent)
                    .semantics { this.selected = active }
                    .softClickable(role = Role.Tab) { onFolderSelect(folder.id) }
                    .padding(horizontal = 12.dp, vertical = 13.dp),
            )
        }
    }
    QuietIconButton(Icons.Rounded.FolderOpen, "Manage chat folders", onManageFolders)
    }
}

@Composable
internal fun FilteredEmptyState(filter: ConversationFilter, onShowAll: () -> Unit) {
    val colors = neuColors
    Column(
        Modifier.fillMaxSize().padding(28.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            when (filter) {
                ConversationFilter.Unread -> "You're all caught up"
                ConversationFilter.Places -> "No places yet"
                else -> "No conversations here yet"
            },
            style = MaterialTheme.typography.titleMedium,
            color = colors.textPrimary,
            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
        )
        Text(
            if (filter == ConversationFilter.Unread) "New unread messages will appear here."
            else "Your conversations are still available in All.",
            style = MaterialTheme.typography.bodyMedium,
            color = colors.textSecondary,
            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
        )
        NeuButton(onClick = onShowAll) { Text("Show all", color = colors.textPrimary) }
    }
}
