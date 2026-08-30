package gg.yappy.app.ui.chat

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
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
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.AddPhotoAlternate
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Delete
import androidx.compose.material.icons.rounded.EmojiEmotions
import androidx.compose.material.icons.rounded.Gif
import androidx.compose.material.icons.rounded.Mic
import androidx.compose.material.icons.rounded.LocationOn
import androidx.compose.material.icons.rounded.Poll
import androidx.compose.material.icons.rounded.Send
import androidx.compose.material.icons.rounded.Videocam
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
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import gg.yappy.app.data.GifResult
import gg.yappy.app.data.Message
import gg.yappy.app.data.Sticker
import gg.yappy.app.data.StickerPack
import gg.yappy.app.ui.components.Avatar
import gg.yappy.app.ui.components.NeuChip
import gg.yappy.app.ui.components.NeuIconButton
import gg.yappy.app.ui.components.NeuTextField
import gg.yappy.app.ui.components.softClickable
import gg.yappy.app.ui.theme.Neu
import gg.yappy.app.ui.theme.NeuState
import gg.yappy.app.ui.theme.neu
import gg.yappy.app.ui.theme.neuColors
import androidx.compose.material.icons.rounded.Campaign
import gg.yappy.app.ui.components.flairColor

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

@OptIn(ExperimentalLayoutApi::class)
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
    onOpenLocation: () -> Unit,
    canSend: Boolean,
    modifier: Modifier = Modifier,
    /** The group's accent — carries its identity onto the send button. */
    accentOverride: Color? = null,
    /** Everyone who can be @-mentioned here. */
    mentionable: List<gg.yappy.app.data.PublicUser> = emptyList(),
    /** The roles this person may ping — already filtered by the screen. */
    mentionableRoles: List<gg.yappy.app.data.RoleEntry> = emptyList(),
    /** Whether `@everyone` is theirs to send. */
    canMentionAll: Boolean = false,
    /** Slash commands the bots in this conversation answer. */
    commands: List<gg.yappy.app.data.BotCommand> = emptyList(),
    onPickMedia: (() -> Unit)? = null,
    /** Hold the mic to record; release to send. */
    onRecordStart: (() -> Unit)? = null,
    onRecordFinish: (() -> Unit)? = null,
    onRecordCancel: (() -> Unit)? = null,
    /** Non-null while a voice note is being recorded — its length so far. */
    recordingMs: Long? = null,
    /** Live input level, 0–1, so the mic can pulse while someone talks. */
    recordingLevel: Float = 0f,
    onOpenVideoNote: (() -> Unit)? = null,
) {
    val colors = neuColors
    var attachOpen by remember { mutableStateOf(false) }

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

    /*
     * Roles and the room, ahead of people.
     *
     * There are far fewer of them, they are the answer more often when
     * somebody types `@` in a space, and a role behind six usernames that
     * happen to share a prefix is a role nobody finds.
     */
    val roleSuggestions = mentionQuery?.let { q ->
        mentionableRoles.filter { it.name.startsWith(q, ignoreCase = true) }.take(4)
    }.orEmpty()
    val everyoneSuggested =
        canMentionAll && mentionQuery != null && "everyone".startsWith(mentionQuery, true)

    // A slash command is only a command at the very start of a message, and
    // only while it is still the whole of it — once there is a space the
    // person is typing arguments, and a list of commands is in the way.
    val commandQuery = draft
        .takeIf { it.startsWith("/") && !it.contains(' ') && !it.contains('\n') }
        ?.drop(1)
    val commandMatches = commandQuery?.let { q ->
        commands.filter { it.name.startsWith(q, ignoreCase = true) }.take(6)
    }.orEmpty()

    Column(modifier.fillMaxWidth()) {
        AnimatedVisibility(
            visible = commandMatches.isNotEmpty(),
            enter = expandVertically() + fadeIn(),
            exit = shrinkVertically() + fadeOut(),
        ) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 14.dp, vertical = 4.dp)
                    .clip(RoundedCornerShape(Neu.CornerMedium))
                    // Explicit fill: `neu` defaults to `colors.surface`, which
                    // is the page background, so a panel drawn over the
                    // timeline would be shadows around nothing and the
                    // messages would read straight through it.
                    .neu(
                        RoundedCornerShape(Neu.CornerMedium),
                        colors,
                        NeuState.Raised,
                        6.dp,
                        fill = colors.incoming,
                    )
                    .padding(vertical = 4.dp),
            ) {
                commandMatches.forEach { command ->
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .softClickable {
                                // Trailing space: every one of these takes an
                                // argument or ends the message, and neither
                                // wants the caret jammed against the name.
                                onDraftChange("/${command.name} ")
                            }
                            .padding(horizontal = 14.dp, vertical = 9.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        // Whose command this is. With one bot it is a gentle
                        // signature; with several it is the difference between
                        // a picker and a guessing game.
                        command.botId?.let { botId ->
                            Avatar(
                                url = command.botAvatarUrl,
                                name = command.botUsername,
                                id = botId,
                                size = 22.dp,
                            )
                            Spacer(Modifier.width(10.dp))
                        }
                        Text(
                            "/${command.name}",
                            style = MaterialTheme.typography.labelLarge,
                            color = colors.accent,
                        )
                        if (command.description.isNotBlank()) {
                            Spacer(Modifier.width(10.dp))
                            Text(
                                command.description,
                                style = MaterialTheme.typography.bodySmall,
                                color = colors.textTertiary,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.weight(1f, fill = false),
                            )
                        }
                        command.botUsername?.let {
                            Spacer(Modifier.weight(1f))
                            Spacer(Modifier.width(10.dp))
                            Text(
                                it,
                                style = MaterialTheme.typography.labelSmall,
                                color = colors.textTertiary,
                            )
                        }
                    }
                }
            }
        }
        AnimatedVisibility(
            visible = suggestions.isNotEmpty() || roleSuggestions.isNotEmpty() || everyoneSuggested,
            enter = expandVertically() + fadeIn(),
            exit = shrinkVertically() + fadeOut(),
        ) {
            LazyRow(
                Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                if (everyoneSuggested) {
                    item(key = "everyone") {
                        Row(
                            Modifier
                                .clip(RoundedCornerShape(Neu.CornerPill))
                                .neu(RoundedCornerShape(Neu.CornerPill), colors, NeuState.Raised, 3.dp)
                                .softClickable {
                                    onDraftChange(draft.dropLast(lastToken.length) + "@everyone ")
                                }
                                .padding(horizontal = 10.dp, vertical = 6.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Icon(
                                Icons.Rounded.Campaign,
                                null,
                                tint = colors.accent,
                                modifier = Modifier.size(15.dp),
                            )
                            Spacer(Modifier.width(5.dp))
                            Text(
                                "@everyone",
                                style = MaterialTheme.typography.labelMedium,
                                color = colors.accent,
                            )
                        }
                    }
                }
                items(roleSuggestions, key = { it.id }) { role ->
                    val tint = flairColor(role.color) ?: colors.accent
                    Row(
                        Modifier
                            .clip(RoundedCornerShape(Neu.CornerPill))
                            .neu(RoundedCornerShape(Neu.CornerPill), colors, NeuState.Raised, 3.dp)
                            .softClickable {
                                // A role name can hold spaces, so the draft
                                // carries the whole thing — the send path
                                // matches it back by name.
                                onDraftChange(draft.dropLast(lastToken.length) + "@${role.name} ")
                            }
                            .padding(horizontal = 10.dp, vertical = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Box(
                            Modifier
                                .size(7.dp)
                                .clip(CircleShape)
                                .background(tint),
                        )
                        Spacer(Modifier.width(6.dp))
                        Text(
                            "@${role.name}",
                            style = MaterialTheme.typography.labelMedium,
                            color = tint,
                        )
                    }
                }
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
                    .background(colors.veil)
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

        // Recording takes the whole row over: the composer is not a place you
        // type while holding the mic, and leaving the text field there invites
        // a lift-off onto the keyboard that cancels the recording.
        if (recordingMs != null) {
            RecordingRow(
                elapsedMs = recordingMs,
                level = recordingLevel,
                onCancel = { onRecordCancel?.invoke() },
                onSend = { onRecordFinish?.invoke() },
            )
            return@Column
        }

        /**
         * The attach menu — photo, poll, video note behind one "+".
         *
         * These used to be three separate controls in the input row, which with
         * emoji and the mic left the text field about eighty points of a
         * 360-point screen: the one thing the composer exists for was the one
         * thing squeezed to nothing. WhatsApp and Telegram both answer this the
         * same way — everything that *creates an attachment* lives behind a
         * single +, and the row keeps exactly three fixed controls.
         */
        AnimatedVisibility(
            visible = attachOpen,
            enter = expandVertically() + fadeIn(),
            exit = shrinkVertically() + fadeOut(),
        ) {
            /**
             * Wraps rather than squeezes.
             *
             * A plain `Row` divides whatever width it has between its children,
             * so a fourth chip left the last one too narrow for its own label —
             * "Video note" broke one letter per line into a tall column. Chips
             * are a set that grows, and a layout that only works at exactly
             * three of them is a trap for the next one added. This puts the
             * overflow on a second line instead.
             */
            FlowRow(
                Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                if (onPickMedia != null) {
                    AttachChip(Icons.Rounded.AddPhotoAlternate, "Photo") {
                        attachOpen = false
                        onPickMedia()
                    }
                }
                AttachChip(Icons.Rounded.LocationOn, "Location") {
                    attachOpen = false
                    onOpenLocation()
                }
                AttachChip(Icons.Rounded.Poll, "Poll") {
                    attachOpen = false
                    onOpenPoll()
                }
                if (onOpenVideoNote != null) {
                    AttachChip(Icons.Rounded.Videocam, "Video note") {
                        attachOpen = false
                        onOpenVideoNote()
                    }
                }
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

            NeuIconButton(
                icon = Icons.Rounded.Add,
                contentDescription = "Attach a photo, poll or video note",
                onClick = { attachOpen = !attachOpen },
                active = attachOpen,
                size = 42.dp,
                iconSize = 20.dp,
            )

            NeuTextField(
                value = draft,
                onValueChange = onDraftChange,
                placeholder = "Message",
                singleLine = false,
                maxLines = 5,
                shape = RoundedCornerShape(Neu.CornerLarge),
                modifier = Modifier.weight(1f),
            )

            // The send button becomes a mic when there is nothing to send —
            // the swap everyone already understands, and it keeps the row from
            // growing a fourth control that is dead most of the time.
            if (canSend || onRecordStart == null) {
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
            } else {
                NeuIconButton(
                    icon = Icons.Rounded.Mic,
                    contentDescription = "Record a voice note",
                    onClick = onRecordStart,
                    size = 44.dp,
                    iconSize = 20.dp,
                )
            }
        }
    }
}

/// One entry in the attach menu: an icon and its name in a soft pill.
@Composable
private fun AttachChip(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    onClick: () -> Unit,
) {
    val colors = neuColors
    Row(
        Modifier
            .clip(RoundedCornerShape(Neu.CornerPill))
            .neu(RoundedCornerShape(Neu.CornerPill), colors, NeuState.Raised, 4.dp, fill = colors.incoming)
            .softClickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, tint = colors.accent, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(7.dp))
        // Never wrapped. A chip squeezed by a row that has run out of width
        // used to break its label one letter per line and grow into a tall
        // column — the label has to refuse before the layout can do that.
        Text(
            label,
            style = MaterialTheme.typography.labelLarge,
            color = colors.textPrimary,
            softWrap = false,
            maxLines = 1,
        )
    }
}

/**
 * The composer while a voice note is recording.
 *
 * A tap to start and a tap to send, rather than press-and-hold. Hold-to-record
 * is the more familiar gesture but it is also the one that loses a two-minute
 * message to a mis-lift, and it cannot coexist with a scrollable timeline
 * without stealing drags from it.
 */
@Composable
private fun RecordingRow(
    elapsedMs: Long,
    level: Float,
    onCancel: () -> Unit,
    onSend: () -> Unit,
) {
    val colors = neuColors

    // The dot breathes with the input level, so the row shows that the mic is
    // actually hearing something — silence looks identical to a dead mic.
    val pulse by animateFloatAsState(
        targetValue = 1f + level.coerceIn(0f, 1f) * 0.8f,
        animationSpec = tween(120),
        label = "record-pulse",
    )

    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 14.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        NeuIconButton(
            icon = Icons.Rounded.Delete,
            contentDescription = "Discard the recording",
            onClick = onCancel,
            size = 42.dp,
            iconSize = 20.dp,
        )

        Row(
            Modifier
                .weight(1f)
                .clip(RoundedCornerShape(Neu.CornerPill))
                .neu(RoundedCornerShape(Neu.CornerPill), colors, NeuState.Pressed, 4.dp)
                .padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                Modifier
                    .size(9.dp)
                    .scale(pulse)
                    .clip(CircleShape)
                    .background(colors.danger),
            )
            Spacer(Modifier.width(10.dp))
            Text(
                "%d:%02d".format((elapsedMs / 1000) / 60, (elapsedMs / 1000) % 60),
                style = MaterialTheme.typography.bodyMedium,
                color = colors.textPrimary,
            )
            Spacer(Modifier.width(10.dp))
            Text(
                "Recording…",
                style = MaterialTheme.typography.labelMedium,
                color = colors.textTertiary,
            )
        }

        NeuIconButton(
            icon = Icons.Rounded.Send,
            contentDescription = "Send the voice note",
            onClick = onSend,
            accent = true,
            size = 44.dp,
            iconSize = 20.dp,
        )
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
fun QuickReactions(
    onPick: (String) -> Unit,
    modifier: Modifier = Modifier,
    /** Opens the full grid, for the feelings the quick eight don't cover. */
    onMore: (() -> Unit)? = null,
) {
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
        if (onMore != null) {
            item(key = "more") {
                Box(
                    Modifier
                        .size(42.dp)
                        .clip(CircleShape)
                        .background(colors.veil)
                        .softClickable(onClick = onMore),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        Icons.Rounded.Add,
                        "More reactions",
                        tint = colors.textSecondary,
                        modifier = Modifier.size(20.dp),
                    )
                }
            }
        }
    }
}

/**
 * Every emoji the composer's picker offers, as a reaction grid. Shares
 * [EMOJI_GRID] with the composer so the two vocabularies cannot drift.
 */
@Composable
fun ReactionEmojiGrid(onPick: (String) -> Unit, modifier: Modifier = Modifier) {
    LazyVerticalGrid(
        columns = GridCells.Fixed(8),
        modifier = modifier.fillMaxWidth().heightIn(max = 340.dp),
    ) {
        items(EMOJI_GRID) { emoji ->
            Box(
                Modifier
                    .size(44.dp)
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
