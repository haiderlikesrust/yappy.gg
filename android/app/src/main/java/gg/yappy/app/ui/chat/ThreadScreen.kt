package gg.yappy.app.ui.chat

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.Send
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import gg.yappy.app.LocalContainer
import gg.yappy.app.data.AppJson
import gg.yappy.app.data.Message
import gg.yappy.app.ui.components.NeuIconButton
import gg.yappy.app.ui.components.NeuTextField
import gg.yappy.app.ui.theme.Neu
import gg.yappy.app.ui.theme.neuColors
import kotlinx.coroutines.launch
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * A thread: one root message and its replies, oldest first.
 *
 * Threads keep a side conversation from flooding the main timeline — the
 * backend already maintained the counts and the reply index; this screen is
 * the missing half.
 */
@Composable
fun ThreadScreen(
    conversationId: String,
    rootId: String,
    onBack: () -> Unit,
) {
    val container = LocalContainer.current
    val colors = neuColors
    val scope = rememberCoroutineScope()

    var root by remember { mutableStateOf<Message?>(null) }
    var replies by remember { mutableStateOf<List<Message>>(emptyList()) }
    var draft by remember { mutableStateOf("") }
    var meId by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(rootId) {
        meId = container.session.currentUserId()
        root = runCatching { container.repo.message(conversationId, rootId).message }.getOrNull()
        replies = runCatching { container.repo.thread(conversationId, rootId).messages }
            .getOrDefault(emptyList())
    }

    // Live replies ride the same conversation subscription as the main chat.
    LaunchedEffect(rootId) {
        container.gateway.events.collect { event ->
            if (event.type != "message.create") return@collect
            val obj = runCatching { event.data.jsonObject }.getOrNull() ?: return@collect
            if (obj["threadRootId"]?.jsonPrimitive?.content != rootId) return@collect
            runCatching { AppJson.decodeFromJsonElement(Message.serializer(), event.data) }
                .getOrNull()
                ?.let { incoming ->
                    if (replies.none { it.id == incoming.id }) replies = replies + incoming
                }
        }
    }

    Column(Modifier.fillMaxSize().imePadding()) {
        Row(
            Modifier
                .fillMaxWidth()
                .statusBarsPadding()
                .padding(horizontal = 14.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            NeuIconButton(Icons.AutoMirrored.Rounded.ArrowBack, "Back", onBack, size = 42.dp, iconSize = 19.dp)
            Spacer(Modifier.width(12.dp))
            Column {
                Text(
                    // A forum post is known by its title; a chat thread has
                    // none, and "Thread" is the right word for those.
                    root?.title ?: "Thread",
                    style = MaterialTheme.typography.titleMedium,
                    color = colors.textPrimary,
                    maxLines = 1,
                )
                Text(
                    "${replies.size} ${if (replies.size == 1) "reply" else "replies"}",
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.textTertiary,
                )
            }
        }

        val rootMessage = root
        if (rootMessage == null) {
            Box(Modifier.weight(1f).fillMaxWidth(), Alignment.Center) {
                CircularProgressIndicator(color = colors.accent)
            }
        } else {
            // Reactions resolve their `:name:` keys through LocalCustomEmoji,
            // which only ChatScreen used to provide — a custom-emoji reaction
            // in a thread fell back to its shortcode text. Derived from the
            // thread's own messages rather than fetched: an emoji someone
            // reacted with in here has almost always been said in here.
            val threadEmoji = androidx.compose.runtime.remember(rootMessage, replies) {
                buildMap {
                    (listOfNotNull(rootMessage) + replies).forEach { m ->
                        m.customEmojis.values.forEach { info -> put(info.name, info.url) }
                    }
                }
            }
            androidx.compose.runtime.CompositionLocalProvider(LocalCustomEmoji provides threadEmoji) {
            LazyColumn(
                Modifier.weight(1f),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 14.dp, vertical = 8.dp),
            ) {
                item(key = rootMessage.id) {
                    MessageBubble(
                        message = rootMessage,
                        isMine = rootMessage.senderId == meId,
                        showAvatar = true,
                        isGrouped = false,
                        isPinned = false,
                        onLongPress = {},
                        onReactionClick = {},
                        onVote = {},
                        // A thread carries the same message types the timeline
                        // does; without these a voice note in one is a bubble
                        // with nothing in it.
                        voicePlayer = container.voicePlayer,
                        mediaFactory = container.mediaFactory,
                    )
                    Spacer(Modifier.padding(vertical = 6.dp))
                }
                items(replies, key = { it.id }) { message ->
                    MessageBubble(
                        message = message,
                        isMine = message.senderId == meId,
                        showAvatar = message.senderId != meId,
                        isGrouped = false,
                        isPinned = false,
                        onLongPress = {},
                        onReactionClick = {},
                        onVote = {},
                        // A thread carries the same message types the timeline
                        // does; without these a voice note in one is a bubble
                        // with nothing in it.
                        voicePlayer = container.voicePlayer,
                        mediaFactory = container.mediaFactory,
                    )
                }
            }
            }
        }

        Row(
            Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 10.dp),
            verticalAlignment = Alignment.Bottom,
        ) {
            NeuTextField(
                value = draft,
                onValueChange = { draft = it },
                placeholder = "Reply in thread",
                singleLine = false,
                maxLines = 4,
                shape = RoundedCornerShape(Neu.CornerLarge),
                modifier = Modifier.weight(1f),
            )
            Spacer(Modifier.width(8.dp))
            NeuIconButton(
                icon = Icons.Rounded.Send,
                contentDescription = "Send reply",
                onClick = {
                    val text = draft.trim()
                    if (text.isEmpty()) return@NeuIconButton
                    draft = ""
                    scope.launch {
                        runCatching {
                            container.repo.sendText(conversationId, text, threadRootId = rootId)
                        }.onSuccess { sent ->
                            if (replies.none { it.id == sent.message.id }) replies = replies + sent.message
                        }
                    }
                },
                accent = draft.isNotBlank(),
                enabled = draft.isNotBlank(),
                size = 44.dp,
                iconSize = 20.dp,
            )
        }

        Spacer(Modifier.navigationBarsPadding())
    }
}
