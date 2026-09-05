package gg.yappy.app.ui.forum

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.CloudOff
import androidx.compose.material.icons.rounded.PushPin
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import gg.yappy.app.LocalContainer
import gg.yappy.app.data.ApiException
import gg.yappy.app.data.ForumPost
import gg.yappy.app.ui.components.Avatar
import gg.yappy.app.ui.components.NeuButton
import gg.yappy.app.ui.components.NeuIconButton
import gg.yappy.app.ui.components.NeuSurface
import gg.yappy.app.ui.components.NeuTextField
import gg.yappy.app.ui.components.softClickable
import gg.yappy.app.ui.components.RefreshBox
import gg.yappy.app.ui.theme.Neu
import gg.yappy.app.ui.theme.NeuState
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
    var refreshing by remember(conversationId) { mutableStateOf(false) }
    /** Why the first page did not arrive. Null once anything has. */
    var error by remember(conversationId) { mutableStateOf<String?>(null) }
    // Survives a rotation: the sheet reopens over the list with its draft.
    var composing by rememberSaveable { mutableStateOf(false) }
    /**
     * Why the last Post failed, drawn inside the sheet. A snackbar on the
     * shell host lands in the activity window, and the sheet is a dialog
     * window over it: the message was posted, and nobody could see it.
     */
    var postError by remember { mutableStateOf<String?>(null) }
    /** A Post is in flight; a second tap would file the same post twice. */
    var posting by remember { mutableStateOf(false) }

    suspend fun load(after: String? = null) {
        runCatching { container.repo.forumPosts(conversationId, after) }
            .onSuccess { page ->
                posts = if (after == null) page.posts else posts + page.posts
                cursor = page.nextCursor
                error = null
            }
            .onFailure { err ->
                // A failed refetch over a list already drawn is not worth a
                // full-screen apology; a failed first page is, because the
                // alternative reads as "nothing here", which is a lie.
                if (posts.isEmpty()) {
                    error = (err as? ApiException)?.message ?: "Couldn't load the posts"
                }
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
            NeuIconButton(Icons.AutoMirrored.Rounded.ArrowBack, "Back", onBack, size = 42.dp, iconSize = 19.dp)
            Spacer(Modifier.width(12.dp))
            Text(
                title ?: "forum",
                // headlineSmall is the top-bar screen-title slot (Settings,
                // Explore, About, Group settings all use it), so this header
                // matches them.
                style = MaterialTheme.typography.headlineSmall,
                color = colors.textPrimary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            if (mayPost) {
                Spacer(Modifier.width(12.dp))
                NeuIconButton(
                    Icons.Rounded.Add,
                    "New post",
                    onClick = { composing = true },
                    size = 42.dp,
                    iconSize = 19.dp,
                )
            }
        }

        val navBottom = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
        RefreshBox(
            refreshing = refreshing,
            underStatusBar = false,
            onRefresh = {
                scope.launch {
                    refreshing = true
                    load()
                    refreshing = false
                }
            },
            modifier = Modifier.fillMaxSize(),
        ) {
            when {
                loading -> Box(
                    Modifier.fillMaxSize().navigationBarsPadding(),
                    contentAlignment = Alignment.Center,
                ) {
                    CircularProgressIndicator(color = colors.accent)
                }

                // Both empty states live in a one-item LazyColumn so the pull
                // gesture still works on them — a plain Box has nothing to
                // scroll and the refresh box never hears the drag.
                error != null -> LazyColumn(Modifier.fillMaxSize()) {
                    item {
                        Column(
                            Modifier.fillParentMaxSize().navigationBarsPadding().padding(horizontal = 40.dp),
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.Center,
                        ) {
                            NeuSurface(shape = CircleShape, state = NeuState.Pressed, elevation = 5.dp, contentPadding = 18.dp) {
                                Icon(Icons.Rounded.CloudOff, null, tint = colors.textTertiary, modifier = Modifier.size(26.dp))
                            }
                            Spacer(Modifier.height(16.dp))
                            Text(
                                error ?: "",
                                style = MaterialTheme.typography.bodyMedium,
                                color = colors.textSecondary,
                                textAlign = TextAlign.Center,
                            )
                            Spacer(Modifier.height(16.dp))
                            NeuButton(onClick = { scope.launch { loading = true; load() } }) {
                                Text("Try again", style = MaterialTheme.typography.labelLarge, color = colors.textPrimary)
                            }
                        }
                    }
                }

                posts.isEmpty() -> LazyColumn(Modifier.fillMaxSize()) {
                    item {
                        Box(
                            Modifier.fillParentMaxSize().navigationBarsPadding().padding(horizontal = 40.dp),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(
                                if (mayPost) "Nothing here yet. Start the first post." else "Nothing here yet.",
                                style = MaterialTheme.typography.bodyMedium,
                                color = colors.textTertiary,
                                textAlign = TextAlign.Center,
                            )
                        }
                    }
                }

                else -> LazyColumn(
                    Modifier.fillMaxSize(),
                    // The real bar height plus a design gap, so the last post
                    // clears a 3-button bar and does not float over gestures.
                    contentPadding = PaddingValues(start = 12.dp, end = 12.dp, top = 4.dp, bottom = navBottom + 24.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    items(posts, key = { it.id }) { post ->
                        PostRow(post) { onOpenPost(post.id) }
                    }
                    if (cursor != null) {
                        item(key = "older") {
                            Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                                Text(
                                    "Older posts",
                                    style = MaterialTheme.typography.labelLarge,
                                    color = colors.accent,
                                    modifier = Modifier
                                        .clip(RoundedCornerShape(Neu.CornerSmall))
                                        .softClickable { scope.launch { load(cursor) } }
                                        .minimumInteractiveComponentSize()
                                        .padding(horizontal = 12.dp, vertical = 8.dp),
                                )
                            }
                        }
                    }
                }
            }
        }
    }

    if (composing) {
        NewPostSheet(
            error = postError,
            posting = posting,
            onDismiss = {
                composing = false
                postError = null
            },
            // The request runs in this screen's scope, not the sheet's: a
            // successful post removes the sheet from composition at once,
            // and a coroutine owned by the sheet would be cancelled before
            // the reload that shows the new post at the top.
            onPost = { postTitle, body ->
                if (posting) return@NewPostSheet
                posting = true
                postError = null
                scope.launch {
                    val ok = runCatching { container.repo.createForumPost(conversationId, postTitle, body) }.isSuccess
                    posting = false
                    if (ok) {
                        composing = false
                        load()
                    } else {
                        // The sheet stays up with the draft in it; losing a
                        // paragraph to a network blip is worse than the blip.
                        postError = "Couldn't post that. Try again."
                    }
                }
            },
        )
    }
}

/**
 * One post. Flat and full-width like a channel row: the list is the content,
 * and a stack of raised cards would turn it into a wall of pillows.
 */
@Composable
private fun PostRow(post: ForumPost, onClick: () -> Unit) {
    val colors = neuColors
    NeuSurface(
        Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(Neu.CornerLarge),
        state = NeuState.Flat,
        elevation = 0.dp,
        contentPadding = 13.dp,
        onClick = onClick,
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
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
                            modifier = Modifier.size(14.dp),
                        )
                        Spacer(Modifier.width(4.dp))
                    }
                    Text(
                        post.title ?: "Untitled",
                        style = MaterialTheme.typography.titleSmall,
                        color = colors.textPrimary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                if (post.excerpt.isNotBlank()) {
                    Spacer(Modifier.height(2.dp))
                    Text(
                        post.excerpt,
                        style = MaterialTheme.typography.bodyMedium,
                        color = colors.textSecondary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
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
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun NewPostSheet(
    /** The last failure, shown under the fields; null when there is none. */
    error: String?,
    /** A post is in flight: the button waits rather than filing a twin. */
    posting: Boolean,
    onDismiss: () -> Unit,
    onPost: (String, String?) -> Unit,
) {
    val colors = neuColors
    // The draft outlives a rotation; the sheet is the one place on this
    // screen where somebody types a paragraph.
    var title by rememberSaveable { mutableStateOf("") }
    var body by rememberSaveable { mutableStateOf("") }

    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = colors.surface,
        contentColor = colors.textPrimary,
    ) {
        Column(
            Modifier.padding(horizontal = 20.dp).padding(bottom = 20.dp).imePadding(),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text("New post", style = MaterialTheme.typography.titleMedium, color = colors.textPrimary)
            NeuTextField(
                value = title,
                onValueChange = { if (it.length <= 100) title = it },
                placeholder = "What is this about?",
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next),
                modifier = Modifier.fillMaxWidth(),
            )
            NeuTextField(
                value = body,
                onValueChange = { body = it },
                placeholder = "Say more…",
                singleLine = false,
                maxLines = 6,
                modifier = Modifier.fillMaxWidth(),
            )
            Text(
                "The title is how people will find this later — it is the whole row in the list.",
                style = MaterialTheme.typography.labelSmall,
                color = colors.textTertiary,
            )
            // In the sheet's own window, the way the report and settings
            // sheets show theirs: the shell's snackbar draws underneath this
            // dialog, so a failure posted there was invisible.
            error?.let {
                Text(it, style = MaterialTheme.typography.labelSmall, color = colors.danger)
            }
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.End,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    "Cancel",
                    style = MaterialTheme.typography.labelLarge,
                    color = colors.textSecondary,
                    modifier = Modifier
                        .clip(RoundedCornerShape(Neu.CornerSmall))
                        .softClickable(onClick = onDismiss)
                        .minimumInteractiveComponentSize()
                        .padding(horizontal = 12.dp, vertical = 8.dp),
                )
                Spacer(Modifier.width(8.dp))
                NeuButton(
                    enabled = title.isNotBlank() && !posting,
                    accent = true,
                    onClick = { onPost(title.trim(), body.trim().ifBlank { null }) },
                ) {
                    Text(
                        if (posting) "Posting…" else "Post",
                        style = MaterialTheme.typography.labelLarge,
                        color = colors.onAccent,
                    )
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
