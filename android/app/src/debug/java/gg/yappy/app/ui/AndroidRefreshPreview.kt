package gg.yappy.app.ui

import android.app.Activity
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Explore
import androidx.compose.material.icons.rounded.Home
import androidx.compose.material.icons.rounded.Notifications
import androidx.compose.material.icons.rounded.PersonOutline
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.yappy.app.data.Conversation
import gg.yappy.app.data.LastMessageStub
import gg.yappy.app.data.Message
import gg.yappy.app.data.PublicUser
import gg.yappy.app.data.SelfState
import gg.yappy.app.ui.chat.ChatTopBar
import gg.yappy.app.ui.chat.Composer
import gg.yappy.app.ui.chat.MessageBubble
import gg.yappy.app.ui.components.AppHeader
import gg.yappy.app.ui.components.LogoMarkGradient
import gg.yappy.app.ui.components.NeuTextField
import gg.yappy.app.ui.components.NeuIconButton
import gg.yappy.app.ui.components.QuietIconButton
import gg.yappy.app.ui.components.SectionLabel
import gg.yappy.app.ui.conversations.ConversationFilter
import gg.yappy.app.ui.conversations.ConversationFilters
import gg.yappy.app.ui.conversations.ConversationRow
import gg.yappy.app.ui.conversations.FilteredEmptyState
import gg.yappy.app.ui.settings.SettingsOverview
import gg.yappy.app.ui.theme.ThemePreference
import gg.yappy.app.ui.theme.YappyTheme
import gg.yappy.app.ui.theme.neuColors
import java.time.Instant

@Preview(name = "Home refresh · light", widthDp = 393, heightDp = 852)
@Composable fun HomeRefreshLightPreview() = RefreshHome(ThemePreference.Light)
@Preview(name = "Home refresh · dark", widthDp = 393, heightDp = 852)
@Composable fun HomeRefreshDarkPreview() = RefreshHome(ThemePreference.Dark)
@Preview(name = "Navigation comparison · labels", widthDp = 393, heightDp = 852)
@Composable fun LabelledNavigationPreview() = RefreshHome(ThemePreference.Dark, labelledNavigation = true)
@Preview(name = "Composer refresh · light", widthDp = 393, heightDp = 852)
@Composable fun ComposerRefreshLightPreview() = RefreshChat(ThemePreference.Light)
@Preview(name = "Composer refresh · dark", widthDp = 393, heightDp = 852)
@Composable fun ComposerRefreshDarkPreview() = RefreshChat(ThemePreference.Dark)
@Preview(name = "Settings refresh · light", widthDp = 393, heightDp = 852)
@Composable fun SettingsRefreshLightPreview() = RefreshSettings(ThemePreference.Light)
@Preview(name = "Settings refresh · dark", widthDp = 393, heightDp = 852)
@Composable fun SettingsRefreshDarkPreview() = RefreshSettings(ThemePreference.Dark)

private val previewPerson = PublicUser("preview-person", username = "alex", displayName = "Alex Chen")
private val previewConversations = listOf(
    Conversation("design", "group", title = "Design friends", badge = "verified", memberCount = 24, hereCount = 4,
        lastMessage = LastMessageStub(preview = "Alex: The new colors look so good", createdAt = Instant.now().toString()),
        self = SelfState(unreadCount = 3)),
    Conversation("weekend", "group", title = "The weekend crew", memberCount = 8, hereCount = 2,
        lastMessage = LastMessageStub(preview = "Anyone up for coffee tomorrow?", createdAt = Instant.now().minusSeconds(1200).toString())),
    Conversation("alex", "dm", otherUser = previewPerson,
        lastMessage = LastMessageStub(preview = "That works for me!", createdAt = Instant.now().toString()), self = SelfState(unreadCount = 1)),
    Conversation("sam", "dm", otherUser = PublicUser("sam", username = "sam", displayName = "Sam Rivera"),
        lastMessage = LastMessageStub(preview = "Sent a photo", createdAt = Instant.now().minusSeconds(3600).toString())),
).map { it.copy(lastMessageAt = it.lastMessage?.createdAt) }

@Composable
private fun RefreshHome(preference: ThemePreference, labelledNavigation: Boolean = false) {
    var filter by remember { mutableStateOf(ConversationFilter.All) }
    var query by remember { mutableStateOf("") }
    var chatOpen by remember { mutableStateOf(false) }
    if (chatOpen) {
        RefreshChat(preference, onBack = { chatOpen = false })
        return
    }
    YappyTheme(preference) {
        val colors = neuColors
        Column(Modifier.fillMaxSize().background(colors.surface).statusBarsPadding()) {
            Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                LogoMarkGradient(height = 24.dp)
                Spacer(Modifier.width(9.dp))
                Text("yappy", style = MaterialTheme.typography.headlineMedium, color = colors.textPrimary, modifier = Modifier.weight(1f))
                QuietIconButton(Icons.Rounded.Notifications, "Notifications", {})
                if (!labelledNavigation) {
                    QuietIconButton(Icons.Rounded.Explore, "Explore", {})
                    QuietIconButton(Icons.Rounded.PersonOutline, "Settings", {})
                }
            }
            NeuTextField(query, { query = it }, placeholder = "Search", modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
                leading = { Icon(Icons.Rounded.Search, null, tint = colors.textTertiary) })
            Spacer(Modifier.height(8.dp))
            if (query.isBlank()) ConversationFilters(
                selected = filter, folders = emptyList(), selectedFolder = null,
                conversations = previewConversations, onFolderSelect = {}, onManageFolders = {},
            ) { filter = it }
            val visible = previewConversations.filter(filter.forContext(query, false)::accepts)
                .filter { query.isBlank() || it.displayName.contains(query, true) }
            Box(Modifier.weight(1f).fillMaxWidth()) {
                if (visible.isEmpty()) {
                    FilteredEmptyState(filter) { filter = ConversationFilter.All; query = "" }
                } else LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 84.dp)) {
                    for ((label, rows) in visible.groupBy { if (it.type == "dm") "People" else "Places" }) {
                        item { SectionLabel(label, Modifier.padding(top = 12.dp, start = 12.dp)) }
                        items(rows, key = { it.id }) { conversation ->
                            Column(Modifier.padding(vertical = 5.dp)) {
                                ConversationRow(conversation, false, conversation.type != "dm", 0L, { chatOpen = true }, {})
                            }
                        }
                    }
                }
                NeuIconButton(Icons.Rounded.Add, "New chat", { chatOpen = true }, accent = true, size = 56.dp,
                    modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp))
            }
            if (labelledNavigation) {
                // Layout comparison only. Destinations stay unchanged in the app.
                NavigationBar(containerColor = colors.surface, tonalElevation = 0.dp) {
                    listOf("Home" to Icons.Rounded.Home, "Explore" to Icons.Rounded.Explore, "You" to Icons.Rounded.PersonOutline).forEach { (label, icon) ->
                        NavigationBarItem(selected = label == "Home", onClick = {},
                            icon = { Icon(icon, null) }, label = { Text(label) },
                            colors = NavigationBarItemDefaults.colors(
                                indicatorColor = colors.accentSoft, selectedIconColor = colors.textPrimary,
                                selectedTextColor = colors.textPrimary, unselectedIconColor = colors.textSecondary,
                                unselectedTextColor = colors.textSecondary))
                    }
                }
            } else Spacer(Modifier.navigationBarsPadding())
        }
    }
}

@Composable
private fun RefreshChat(preference: ThemePreference, onBack: (() -> Unit)? = null) {
    val activity = LocalContext.current as? Activity
    val back = onBack ?: { activity?.finish(); Unit }
    BackHandler(onBack = back)
    var draft by remember { mutableStateOf("") }
    var pickerOpen by remember { mutableStateOf(false) }
    var sent by remember { mutableStateOf(listOf("Yes! Much easier to read now.")) }
    YappyTheme(preference) {
        Column(Modifier.fillMaxSize().background(neuColors.surface).navigationBarsPadding().imePadding()) {
            ChatTopBar(null, true, "Design friends", "4 people here", "verified", null, "design", back, {}, {})
            Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("Today", style = MaterialTheme.typography.labelSmall, color = neuColors.textTertiary, modifier = Modifier.align(Alignment.CenterHorizontally))
                MessageBubble(
                    Message("sample", "design", 1, content = "What do you think of the new colors?", sender = previewPerson, createdAt = Instant.now().toString()),
                    isMine = false, showAvatar = true, isGrouped = false, isPinned = false, onLongPress = {}, onReactionClick = {}, onVote = {})
                sent.forEachIndexed { i, body ->
                    MessageBubble(Message("sent-$i", "design", i + 2L, content = body, createdAt = Instant.now().toString()),
                        isMine = true, showAvatar = false, isGrouped = false, isPinned = false, onLongPress = {}, onReactionClick = {}, onVote = {})
                }
            }
            Composer(draft, { draft = it }, { if (draft.isNotBlank()) { sent = sent + draft; draft = "" } },
                replyTo = null, onCancelReply = {}, editing = null, onCancelEdit = {}, pickerOpen = pickerOpen,
                onTogglePicker = { pickerOpen = !pickerOpen }, onOpenPoll = {}, onOpenLocation = {}, canSend = draft.isNotBlank(), onPickMedia = {})
        }
    }
}

@Composable
private fun RefreshSettings(preference: ThemePreference) {
    val activity = LocalContext.current as? Activity
    YappyTheme(preference) {
        Column(Modifier.fillMaxSize().background(neuColors.surface).statusBarsPadding()) {
            AppHeader("Settings", { activity?.finish() })
            Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).navigationBarsPadding()) {
                SettingsOverview("Alex Chen", "alex", null, "preview-person", "${if (preference == ThemePreference.Light) "Light" else "Dark"} theme · 100% message text",
                    "Messages, sounds and quiet hours", "24 MB cached on this device", "2 active sessions",
                    onPage = {}, onProfile = {}, onHelp = {}, onAbout = {})
                Spacer(Modifier.height(24.dp))
            }
        }
    }
}
