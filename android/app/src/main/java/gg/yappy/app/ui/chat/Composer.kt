package gg.yappy.app.ui.chat

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.AddPhotoAlternate
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.EmojiEmotions
import androidx.compose.material.icons.rounded.Gif
import androidx.compose.material.icons.rounded.Poll
import androidx.compose.material.icons.rounded.Send
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import gg.yappy.app.data.GifResult
import gg.yappy.app.data.Message
import gg.yappy.app.data.Sticker
import gg.yappy.app.data.StickerPack
import gg.yappy.app.ui.components.NeuChip
import gg.yappy.app.ui.components.NeuIconButton
import gg.yappy.app.ui.components.NeuTextField
import gg.yappy.app.ui.components.softClickable
import gg.yappy.app.ui.theme.Neu
import gg.yappy.app.ui.theme.NeuState
import gg.yappy.app.ui.theme.neu
import gg.yappy.app.ui.theme.neuColors

enum class PickerTab { Stickers, Gifs, Emoji }

/** Sensible one-tap reactions, matching the order most chat apps settled on. */
val QUICK_EMOJI = listOf("👍", "❤️", "😂", "😮", "😢", "🙏", "🔥", "🎉")

private val EMOJI_GRID = listOf(
    "😀", "😂", "🥲", "😊", "😍", "😘", "😜", "🤔", "😐", "😴",
    "😭", "😡", "🥳", "🤯", "😱", "🤗", "🙄", "😬", "🥶", "🤒",
    "👍", "👎", "👏", "🙌", "🤝", "💪", "🙏", "✌️", "🤞", "👋",
    "❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "💔", "💯", "✨",
    "🔥", "🎉", "🎂", "🍕", "☕", "🍺", "⚽", "🎮", "🎧", "📷",
    "🚀", "🌙", "⭐", "🌧️", "🌈", "🐶", "🐱", "🦊", "🐼", "🦄",
)

@Composable
fun Composer(
    draft: String,
    onDraftChange: (String) -> Unit,
    onSend: () -> Unit,
    replyTo: Message?,
    onCancelReply: () -> Unit,
    editing: Message?,
    onCancelEdit: () -> Unit,
    pickerOpen: Boolean,
    onTogglePicker: () -> Unit,
    onOpenPoll: () -> Unit,
    canSend: Boolean,
    modifier: Modifier = Modifier,
    /** The group's accent — carries its identity onto the send button. */
    accentOverride: Color? = null,
    /** Everyone who can be @-mentioned here. */
    mentionable: List<gg.yappy.app.data.PublicUser> = emptyList(),
    onPickMedia: (() -> Unit)? = null,
) {
    val colors = neuColors

    // Autocomplete keys off the last token: mentions are typed at the point of
    // thought, which is almost always the end of the draft.
    val lastToken = draft.substringAfterLast(' ').substringAfterLast('\n')
    val mentionQuery = lastToken.takeIf { it.startsWith("@") && it.length >= 1 }?.drop(1)
    val suggestions = mentionQuery?.let { q ->
        mentionable.filter { u ->
            u.username?.startsWith(q, ignoreCase = true) == true ||
                u.displayName?.startsWith(q, ignoreCase = true) == true
        }.take(6)
    }.orEmpty()

    Column(modifier.fillMaxWidth()) {
        AnimatedVisibility(
            visible = suggestions.isNotEmpty(),
            enter = expandVertically() + fadeIn(),
            exit = shrinkVertically() + fadeOut(),
        ) {
            LazyRow(
                Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                items(suggestions, key = { it.id }) { user ->
                    Row(
                        Modifier
                            .clip(RoundedCornerShape(Neu.CornerPill))
                            .neu(RoundedCornerShape(Neu.CornerPill), colors, NeuState.Raised, 3.dp)
                            .softClickable {
                                val username = user.username ?: return@softClickable
                                onDraftChange(draft.dropLast(lastToken.length) + "@$username ")
                            }
                            .padding(horizontal = 10.dp, vertical = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            "@${user.username ?: "?"}",
                            style = MaterialTheme.typography.labelMedium,
                            color = colors.accent,
                        )
                        user.displayName?.let {
                            Spacer(Modifier.width(6.dp))
                            Text(it, style = MaterialTheme.typography.labelMedium, color = colors.textTertiary)
                        }
                    }
                }
            }
        }
        AnimatedVisibility(
            visible = replyTo != null || editing != null,
            enter = expandVertically() + fadeIn(),
            exit = shrinkVertically() + fadeOut(),
        ) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 6.dp)
                    .clip(RoundedCornerShape(Neu.CornerSmall))
                    .background(colors.dark.copy(alpha = 0.08f))
                    .padding(horizontal = 12.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(
                    Modifier
                        .width(3.dp)
                        .height(28.dp)
                        .background(colors.accent, RoundedCornerShape(2.dp)),
                )
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Text(
                        if (editing != null) "Editing message" else "Replying to ${replyTo?.sender?.label ?: "message"}",
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.accent,
                    )
                    Text(
                        (editing ?: replyTo)?.content.orEmpty(),
                        style = MaterialTheme.typography.bodyMedium,
                        color = colors.textSecondary,
                        maxLines = 1,
                    )
                }
                NeuIconButton(
                    Icons.Rounded.Close,
                    "Cancel",
                    onClick = { if (editing != null) onCancelEdit() else onCancelReply() },
                    size = 30.dp,
                    iconSize = 15.dp,
                )
            }
        }

        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 14.dp, vertical = 10.dp),
            verticalAlignment = Alignment.Bottom,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            NeuIconButton(
                icon = Icons.Rounded.EmojiEmotions,
                contentDescription = "Stickers, GIFs and emoji",
                onClick = onTogglePicker,
                active = pickerOpen,
                size = 42.dp,
                iconSize = 20.dp,
            )

            if (onPickMedia != null) {
                NeuIconButton(
                    icon = Icons.Rounded.AddPhotoAlternate,
                    contentDescription = "Send a photo",
                    onClick = onPickMedia,
                    size = 42.dp,
                    iconSize = 20.dp,
                )
            }

            NeuTextField(
                value = draft,
                onValueChange = onDraftChange,
                placeholder = "Message",
                singleLine = false,
                maxLines = 5,
                shape = RoundedCornerShape(Neu.CornerLarge),
                modifier = Modifier.weight(1f),
                trailing = {
                    NeuIconButton(
                        Icons.Rounded.Poll,
                        "Create poll",
                        onClick = onOpenPoll,
                        size = 30.dp,
                        iconSize = 16.dp,
                    )
                },
            )

            NeuIconButton(
                icon = Icons.Rounded.Send,
                contentDescription = "Send",
                onClick = onSend,
                accent = canSend,
                fillColor = if (canSend) accentOverride else null,
                enabled = canSend,
                size = 44.dp,
                iconSize = 20.dp,
            )
        }
    }
}

@Composable
fun PickerSheet(
    packs: List<StickerPack>,
    recentStickers: List<Sticker>,
    gifs: List<GifResult>,
    gifQuery: String,
    gifsLoading: Boolean,
    onGifQueryChange: (String) -> Unit,
    onSticker: (Sticker) -> Unit,
    onGif: (GifResult) -> Unit,
    onEmoji: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = neuColors
    var tab by remember { mutableStateOf(PickerTab.Stickers) }

    Column(
        modifier
            .fillMaxWidth()
            .height(300.dp)
            // Recessed: the picker is a drawer opened *into* the sheet, so
            // everything inside it sits at a lower level than the composer.
            .neu(RoundedCornerShape(topStart = Neu.CornerLarge, topEnd = Neu.CornerLarge), colors, NeuState.Pressed, 6.dp)
            .padding(12.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            NeuChip("Stickers", tab == PickerTab.Stickers, { tab = PickerTab.Stickers })
            NeuChip("GIFs", tab == PickerTab.Gifs, { tab = PickerTab.Gifs })
            NeuChip("Emoji", tab == PickerTab.Emoji, { tab = PickerTab.Emoji })
        }

        Spacer(Modifier.height(10.dp))

        when (tab) {
            PickerTab.Stickers -> StickerTab(packs, recentStickers, onSticker)
            PickerTab.Gifs -> GifTab(gifs, gifQuery, gifsLoading, onGifQueryChange, onGif)
            PickerTab.Emoji -> EmojiTab(onEmoji)
        }
    }
}

@Composable
private fun StickerTab(packs: List<StickerPack>, recent: List<Sticker>, onPick: (Sticker) -> Unit) {
    val colors = neuColors
    val all = (recent + packs.flatMap { it.stickers }).distinctBy { it.id }

    if (all.isEmpty()) {
        Box(Modifier.fillMaxWidth().height(220.dp), Alignment.Center) {
            Text(
                "No sticker packs installed yet",
                style = MaterialTheme.typography.bodyMedium,
                color = colors.textTertiary,
            )
        }
        return
    }

    LazyVerticalGrid(
        columns = GridCells.Adaptive(72.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        items(all, key = { it.id }) { sticker ->
            AsyncImage(
                model = sticker.url,
                contentDescription = sticker.name ?: sticker.emoji,
                modifier = Modifier
                    .size(72.dp)
                    .clip(RoundedCornerShape(Neu.CornerSmall))
                    .softClickable { onPick(sticker) },
            )
        }
    }
}

@Composable
private fun GifTab(
    gifs: List<GifResult>,
    query: String,
    loading: Boolean,
    onQueryChange: (String) -> Unit,
    onPick: (GifResult) -> Unit,
) {
    val colors = neuColors
    Column {
        NeuTextField(
            value = query,
            onValueChange = onQueryChange,
            placeholder = "Search GIFs",
            leading = { Icon(Icons.Rounded.Gif, null, tint = colors.textTertiary, modifier = Modifier.size(20.dp)) },
            shape = RoundedCornerShape(Neu.CornerPill),
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(8.dp))

        if (gifs.isEmpty()) {
            Box(Modifier.fillMaxWidth().height(170.dp), Alignment.Center) {
                Text(
                    if (loading) "Searching…" else "No GIFs found",
                    style = MaterialTheme.typography.bodyMedium,
                    color = colors.textTertiary,
                )
            }
            return
        }

        LazyVerticalGrid(
            columns = GridCells.Fixed(2),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            items(gifs, key = { "${it.provider}:${it.id}" }) { gif ->
                AsyncImage(
                    model = gif.previewUrl,
                    contentDescription = gif.title,
                    contentScale = ContentScale.Crop,
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(100.dp)
                        .clip(RoundedCornerShape(Neu.CornerSmall))
                        .softClickable { onPick(gif) },
                )
            }
        }
    }
}

@Composable
private fun EmojiTab(onPick: (String) -> Unit) {
    LazyVerticalGrid(
        columns = GridCells.Adaptive(46.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        items(EMOJI_GRID) { emoji ->
            Box(
                Modifier
                    .size(46.dp)
                    .clip(CircleShape)
                    .softClickable { onPick(emoji) },
                contentAlignment = Alignment.Center,
            ) {
                Text(emoji, style = MaterialTheme.typography.headlineSmall)
            }
        }
    }
}

/** The quick-reaction strip that appears above the message action sheet. */
@Composable
fun QuickReactions(onPick: (String) -> Unit, modifier: Modifier = Modifier) {
    val colors = neuColors
    LazyRow(
        modifier
            .fillMaxWidth()
            .neu(RoundedCornerShape(Neu.CornerPill), colors, NeuState.Raised, 6.dp)
            .clip(RoundedCornerShape(Neu.CornerPill))
            .padding(horizontal = 8.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        items(QUICK_EMOJI) { emoji ->
            Box(
                Modifier
                    .size(42.dp)
                    .clip(CircleShape)
                    .softClickable { onPick(emoji) },
                contentAlignment = Alignment.Center,
            ) {
                Text(emoji, style = MaterialTheme.typography.headlineSmall)
            }
        }
    }
}

@Composable
fun PollComposer(
    onDismiss: () -> Unit,
    onCreate: (String, List<String>, Boolean) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = neuColors
    var question by remember { mutableStateOf("") }
    var options by remember { mutableStateOf(listOf("", "")) }
    var multiSelect by remember { mutableStateOf(false) }

    Column(
        modifier
            .fillMaxWidth()
            .heightIn(max = 460.dp)
            .padding(16.dp),
    ) {
        Text("New poll", style = MaterialTheme.typography.headlineSmall, color = colors.textPrimary)
        Spacer(Modifier.height(14.dp))

        NeuTextField(question, { question = it }, placeholder = "Ask a question", modifier = Modifier.fillMaxWidth())
        Spacer(Modifier.height(10.dp))

        options.forEachIndexed { index, value ->
            NeuTextField(
                value = value,
                onValueChange = { next ->
                    options = options.toMutableList().also { it[index] = next }
                },
                placeholder = "Option ${index + 1}",
                modifier = Modifier.fillMaxWidth().padding(bottom = 8.dp),
            )
        }

        if (options.size < 12) {
            Text(
                "+ Add option",
                style = MaterialTheme.typography.labelMedium,
                color = colors.accent,
                modifier = Modifier
                    .padding(vertical = 6.dp)
                    .softClickable { options = options + "" },
            )
        }

        Spacer(Modifier.height(8.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            NeuChip("Multiple answers", multiSelect, { multiSelect = !multiSelect })
        }

        Spacer(Modifier.height(16.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            gg.yappy.app.ui.components.NeuButton(onClick = onDismiss, modifier = Modifier.weight(1f)) {
                Text("Cancel", style = MaterialTheme.typography.labelLarge, color = colors.textSecondary)
            }
            gg.yappy.app.ui.components.NeuButton(
                onClick = {
                    val clean = options.map(String::trim).filter(String::isNotEmpty)
                    if (question.isNotBlank() && clean.size >= 2) onCreate(question.trim(), clean, multiSelect)
                },
                accent = true,
                modifier = Modifier.weight(1f),
            ) {
                Text("Create", style = MaterialTheme.typography.labelLarge, color = colors.onAccent)
            }
        }
    }
}
