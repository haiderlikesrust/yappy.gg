package gg.yappy.app.ui.forum

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.PushPin
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import gg.yappy.app.data.ForumPage
import gg.yappy.app.data.ForumPost
import gg.yappy.app.LocalContainer
import gg.yappy.app.ui.components.Avatar
import gg.yappy.app.ui.components.NeuIconButton
import gg.yappy.app.ui.theme.neuColors
import kotlinx.coroutines.launch

/**
 * A forum channel: the top level is a list of posts, not a timeline.
 *
 * The machinery underneath is the app's existing threads — a post is a root
 * message with a title, and opening one opens its thread. So this screen is a
 * list and a composer; ThreadScreen does the actual conversation.
 */
@Composable
fun ForumScreen(
    conversationId: String,
    title: String?,
    mayPost: Boolean,
    onBack: () -> Unit,
    onOpenPost: (String) -> Unit,
) {
    val container = LocalContainer.current
    val colors = neuColors
    val scope = rememberCoroutineScope()

    var posts by remember(conversationId) { mutableStateOf<List<ForumPost>>(emptyList()) }
    var cursor by remember(conversationId) { mutableStateOf<String?>(null) }
    var loading by remember(conversationId) { mutableStateOf(true) }
    var composing by remember { mutableStateOf(false) }

    suspend fun load(after: String? = null) {
        runCatching { container.repo.forumPosts(conversationId, after) }
            .onSuccess { page ->
                posts = if (after == null) page.posts else posts + page.posts
                cursor = page.nextCursor
            }
        loading = false
    }

    // Reply counts and ordering both move while a post is open, so the list is
    // refetched every time this screen comes back rather than cached.
    LaunchedEffect(conversationId) { load() }

    Column(
        Modifier
            .fillMaxSize()
            // The screen draws edge to edge, so the header has to make room
            // for the clock rather than sitting under it.
            .statusBarsPadding(),
    ) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            NeuIconButton(Icons.AutoMirrored.Rounded.ArrowBack, "Back", onBack)
            Spacer(Modifier.width(12.dp))
            Text(
                title ?: "forum",
                // headlineSmall, not titleLarge: the app's type scale does not
                // define titleLarge at all, so it falls through to Material's
                // default font and the title comes out in Roboto.
                style = MaterialTheme.typography.headlineSmall,
                color = colors.textPrimary,
                modifier = Modifier.weight(1f),
            )
            if (mayPost) {
                TextButton(onClick = { composing = true }) {
                    Icon(Icons.Rounded.Add, contentDescription = null, tint = colors.accent)
                    Spacer(Modifier.width(4.dp))
                    Text("New post", color = colors.accent)
                }
            }
        }

        HorizontalDivider(color = colors.hairline)

        if (!loading && posts.isEmpty()) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text(
                    if (mayPost) "Nothing here yet. Start the first post." else "Nothing here yet.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = colors.textTertiary,
                )
            }
        }

        LazyColumn(Modifier.fillMaxSize()) {
            items(posts, key = { it.id }) { post ->
                PostRow(post) { onOpenPost(post.id) }
                HorizontalDivider(color = colors.hairline)
            }
            if (cursor != null) {
                item {
                    TextButton(
                        onClick = { scope.launch { load(cursor) } },
                        modifier = Modifier.fillMaxWidth().padding(12.dp),
                    ) {
                        Text("Older posts", color = colors.textSecondary)
                    }
                }
            }
        }
    }

    if (composing) {
        NewPostSheet(
            onDismiss = { composing = false },
            onPost = { postTitle, body ->
                scope.launch {
                    runCatching { container.repo.createForumPost(conversationId, postTitle, body) }
                    composing = false
                    load()
                }
            },
        )
    }
}

@Composable
private fun PostRow(post: ForumPost, onClick: () -> Unit) {
    val colors = neuColors
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(14.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Avatar(
            url = post.author?.avatarUrl,
            name = post.author?.displayName ?: post.author?.username,
            id = post.author?.id ?: post.id,
            size = 34.dp,
        )
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (post.pinned) {
                    Icon(
                        Icons.Rounded.PushPin,
                        contentDescription = "Pinned",
                        tint = colors.accent,
                        modifier = Modifier.width(14.dp),
                    )
                    Spacer(Modifier.width(4.dp))
                }
                Text(
                    post.title ?: "Untitled",
                    style = MaterialTheme.typography.titleSmall,
                    color = colors.textPrimary,
                    maxLines = 1,
                )
            }
            if (post.excerpt.isNotBlank()) {
                Spacer(Modifier.height(2.dp))
                Text(
                    post.excerpt,
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.textSecondary,
                    maxLines = 1,
                )
            }
            Spacer(Modifier.height(3.dp))
            Text(
                buildString {
                    append(post.author?.displayName ?: post.author?.username ?: "someone")
                    append(" · ")
                    append(
                        when (post.replyCount) {
                            0 -> "no replies"
                            1 -> "1 reply"
                            else -> "${post.replyCount} replies"
                        },
                    )
                    append(" · ")
                    append(age(post.lastActivityAt))
                },
                style = MaterialTheme.typography.labelSmall,
                color = colors.textTertiary,
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun NewPostSheet(onDismiss: () -> Unit, onPost: (String, String?) -> Unit) {
    val colors = neuColors
    var title by remember { mutableStateOf("") }
    var body by remember { mutableStateOf("") }

    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = colors.surface,
        contentColor = colors.textPrimary,
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("New post", style = MaterialTheme.typography.titleMedium, color = colors.textPrimary)
            OutlinedTextField(
                value = title,
                onValueChange = { if (it.length <= 100) title = it },
                label = { Text("What is this about?") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next),
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = body,
                onValueChange = { body = it },
                label = { Text("Say more…") },
                minLines = 3,
                modifier = Modifier.fillMaxWidth(),
            )
            Text(
                "The title is how people will find this later — it is the whole row in the list.",
                style = MaterialTheme.typography.labelSmall,
                color = colors.textTertiary,
            )
            Row(horizontalArrangement = Arrangement.End, modifier = Modifier.fillMaxWidth()) {
                TextButton(onClick = onDismiss) { Text("Cancel", color = colors.textSecondary) }
                TextButton(
                    enabled = title.isNotBlank(),
                    onClick = { onPost(title.trim(), body.trim().ifBlank { null }) },
                ) {
                    Text("Post", color = if (title.isNotBlank()) colors.accent else colors.textTertiary)
                }
            }
        }
    }
}

/** "3m", "5h", "2d" — a forum row wants an age, not a clock reading. */
private fun age(iso: String?): String {
    if (iso == null) return ""
    val then = runCatching { java.time.Instant.parse(iso).toEpochMilli() }.getOrNull() ?: return ""
    val secs = ((System.currentTimeMillis() - then) / 1000).coerceAtLeast(0)
    return when {
        secs < 60 -> "just now"
        secs < 3600 -> "${secs / 60}m"
        secs < 86_400 -> "${secs / 3600}h"
        else -> "${secs / 86_400}d"
    }
}
