package gg.yappy.app.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Call
import androidx.compose.material.icons.rounded.CallMissed
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.DoneAll
import androidx.compose.material.icons.rounded.PushPin
import androidx.compose.material.icons.rounded.Schedule
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.graphics.Brush
import coil.compose.AsyncImage
import gg.yappy.app.data.ConversationAppearance
import gg.yappy.app.data.Message
import gg.yappy.app.ui.components.Avatar
import gg.yappy.app.ui.components.IdentityMarks
import gg.yappy.app.ui.components.flairColor
import gg.yappy.app.ui.components.softClickable
import gg.yappy.app.ui.theme.Neu
import gg.yappy.app.ui.theme.neuColors
import gg.yappy.app.ui.util.clockTime
import gg.yappy.app.ui.util.formatDuration

/**
 * A message bubble.
 *
 * Bubbles are deliberately *flat* — no neumorphic shadows. The style's own rule
 * is "few raised elements per screen", and a chat breaks it by definition:
 * dozens of bubbles each casting two shadows reads as a wall of pillows.
 * Hierarchy comes from colour instead: outgoing is the accent, incoming a tone
 * one step off the surface. The chrome around the timeline (composer, buttons)
 * is what keeps the soft look.
 */
@Composable
fun MessageBubble(
    message: Message,
    isMine: Boolean,
    showAvatar: Boolean,
    isGrouped: Boolean,
    isPinned: Boolean,
    onLongPress: () -> Unit,
    onReactionClick: (String) -> Unit,
    onVote: (String) -> Unit,
    modifier: Modifier = Modifier,
    /** The group's flair. Inside a flaired group, *its* colours carry your
     *  bubbles — the group's identity follows you into the conversation. */
    appearance: ConversationAppearance? = null,
    onOpenThread: (() -> Unit)? = null,
    onOpenUrl: (String) -> Unit = {},
    /** Opening media is the screen's job — the bubble only reports the tap. */
    onOpenMedia: () -> Unit = {},
    /** Needed to tell whether a button addressed to one person is for you. */
    myUserId: String? = null,
    /** customId of the button currently awaiting a server answer, if any. */
    pressingComponent: String? = null,
    onPressComponent: (gg.yappy.app.data.MessageButton) -> Unit = {},
) {
    val colors = neuColors

    if (message.isSystem) {
        SystemLine(message)
        return
    }

    // Corner radii are asymmetric on the tail side, and only on the last bubble
    // of a run — that is what visually groups consecutive messages.
    val corner = 16.dp
    val shape = RoundedCornerShape(
        topStart = if (isMine || isGrouped) corner else 5.dp,
        topEnd = if (!isMine || isGrouped) corner else 5.dp,
        bottomStart = corner,
        bottomEnd = corner,
    )

    Row(
        modifier
            .fillMaxWidth()
            .padding(top = if (isGrouped) 2.dp else 10.dp),
        horizontalArrangement = if (isMine) Arrangement.End else Arrangement.Start,
        verticalAlignment = Alignment.Bottom,
    ) {
        if (!isMine) {
            if (showAvatar) {
                Avatar(
                    url = message.sender?.avatarUrl,
                    name = message.sender?.label,
                    id = message.senderId ?: message.id,
                    size = 32.dp,
                )
            } else {
                Spacer(Modifier.width(32.dp))
            }
            Spacer(Modifier.width(8.dp))
        }

        Column(
            horizontalAlignment = if (isMine) Alignment.End else Alignment.Start,
            modifier = Modifier.widthIn(max = 300.dp),
        ) {
            if (!isMine && showAvatar && message.sender != null) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.padding(start = 6.dp, bottom = 3.dp),
                ) {
                    Text(
                        message.sender.label,
                        style = MaterialTheme.typography.labelSmall,
                        // A role colour is the one thing allowed to override the
                        // name's tint — it is how a group signals "this person
                        // speaks for us" at a glance.
                        color = flairColor(message.senderRoleColor) ?: colors.textTertiary,
                    )
                    // The timeline is where impersonation actually happens, so
                    // the marks ride next to the name rather than living only
                    // on a profile nobody opens mid-conversation.
                    if (message.sender.badge != null || message.sender.affiliation != null) {
                        Spacer(Modifier.width(4.dp))
                        IdentityMarks(message.sender, size = 13.dp)
                    }
                    // Knowing a message came from software is not a nicety —
                    // it is the difference between advice and an advertisement.
                    if (message.sender.isBot) {
                        Spacer(Modifier.width(5.dp))
                        Box(
                            Modifier
                                .clip(RoundedCornerShape(4.dp))
                                .background(colors.accent)
                                .padding(horizontal = 4.dp, vertical = 1.dp),
                        ) {
                            Text(
                                "BOT",
                                style = MaterialTheme.typography.labelSmall,
                                color = colors.onAccent,
                            )
                        }
                    }
                }
            }

            val outgoingBrush = if (isMine) {
                appearance?.gradient?.mapNotNull(::flairColor)?.takeIf { it.size >= 2 }
                    ?.let { Brush.linearGradient(it) }
            } else null
            val outgoingSolid = if (isMine) flairColor(appearance?.accent) ?: colors.outgoing else colors.incoming

            // A bot's card often *is* the whole message, with nothing said
            // around it. Drawing the bubble anyway leaves an empty rounded box
            // holding only a timestamp, hovering above the card it belongs to.
            val hasSpokenBody = message.isDeleted ||
                message.type in setOf("sticker", "gif", "poll", "call") ||
                message.attachments.isNotEmpty() ||
                !message.content.isNullOrBlank()
            val hasCard = !message.isDeleted &&
                (message.embeds.isNotEmpty() || message.components.isNotEmpty())

            if (hasSpokenBody || !hasCard) {
            Box(
                Modifier
                    .clip(shape)
                    .then(
                        if (outgoingBrush != null) Modifier.background(outgoingBrush)
                        else Modifier.background(outgoingSolid),
                    )
                    .softClickable { onLongPress() }
                    .padding(horizontal = 13.dp, vertical = 9.dp)
                    .alpha(if (message.isPending) 0.6f else 1f),
            ) {
                Column {
                    message.replyTo?.let { ReplyPreview(it.preview, isMine) }

                    when {
                        message.isDeleted -> Text(
                            "This message was deleted",
                            style = MaterialTheme.typography.bodyMedium.copy(fontStyle = FontStyle.Italic),
                            color = if (isMine) colors.onOutgoing.copy(alpha = 0.7f) else colors.textTertiary,
                        )

                        message.type == "sticker" -> StickerBody(message)
                        message.type == "gif" -> GifBody(message)
                        message.type == "poll" -> PollBody(message, isMine, onVote)
                        message.type == "call" -> CallBody(message, isMine)
                        message.attachments.isNotEmpty() -> AttachmentBody(message, isMine, onOpenMedia)

                        else -> Text(
                            mentionStyled(
                                message.content.orEmpty(),
                                // On an accent bubble the accent colour vanishes;
                                // weight alone carries the mention there.
                                if (isMine) colors.onOutgoing else colors.accent,
                                // On the violet bubble the accent is invisible,
                                // so weight alone marks the command there.
                                if (isMine) colors.onOutgoing else colors.accent,
                            ),
                            style = MaterialTheme.typography.bodyLarge,
                            color = if (isMine) colors.onOutgoing else colors.textPrimary,
                        )
                    }

                    // A thread grows from this message.
                    if (message.threadReplyCount > 0 && onOpenThread != null) {
                        Spacer(Modifier.height(5.dp))
                        Text(
                            "💬 ${message.threadReplyCount} ${if (message.threadReplyCount == 1) "reply" else "replies"} ›",
                            style = MaterialTheme.typography.labelMedium,
                            color = if (isMine) colors.onOutgoing else colors.accent,
                            modifier = Modifier.softClickable { onOpenThread() },
                        )
                    }

                    Spacer(Modifier.height(3.dp))

                    Row(verticalAlignment = Alignment.CenterVertically) {
                        if (isPinned) {
                            Icon(
                                Icons.Rounded.PushPin,
                                null,
                                tint = if (isMine) colors.onOutgoing.copy(alpha = 0.6f) else colors.textTertiary,
                                modifier = Modifier.size(11.dp),
                            )
                            Spacer(Modifier.width(4.dp))
                        }
                        if (message.editedAt != null) {
                            Text(
                                "edited",
                                style = MaterialTheme.typography.labelSmall,
                                color = if (isMine) colors.onOutgoing.copy(alpha = 0.6f) else colors.textTertiary,
                            )
                            Spacer(Modifier.width(5.dp))
                        }
                        Text(
                            clockTime(message.createdAt),
                            style = MaterialTheme.typography.labelSmall,
                            color = if (isMine) colors.onOutgoing.copy(alpha = 0.7f) else colors.textTertiary,
                        )
                        if (isMine) {
                            Spacer(Modifier.width(4.dp))
                            Icon(
                                when {
                                    message.isPending -> Icons.Rounded.Schedule
                                    else -> Icons.Rounded.Check
                                },
                                contentDescription = if (message.isPending) "Sending" else "Sent",
                                tint = colors.onOutgoing.copy(alpha = 0.7f),
                                modifier = Modifier.size(12.dp),
                            )
                        }
                    }
                }
            }

            }

            // Embeds sit *outside* the bubble: a link preview is about the
            // message, not part of what was said.
            if (message.embeds.isNotEmpty() && !message.isDeleted) {
                message.embeds.take(4).forEach { embed ->
                    Spacer(Modifier.height(4.dp))
                    EmbedCard(embed, onOpenUrl = onOpenUrl)
                }
            }

            if (message.components.isNotEmpty() && !message.isDeleted) {
                Spacer(Modifier.height(6.dp))
                ComponentRows(
                    rows = message.components,
                    myUserId = myUserId,
                    pressing = pressingComponent,
                    onPress = onPressComponent,
                )
            }

            // The bubble normally carries the time. When it was suppressed
            // because the message is only a card, put it back underneath —
            // "when" is not a detail worth dropping to tidy the layout.
            if (!hasSpokenBody && hasCard) {
                Spacer(Modifier.height(3.dp))
                Text(
                    clockTime(message.createdAt),
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.textTertiary,
                    modifier = Modifier.padding(start = 2.dp),
                )
            }

            if (message.reactions.isNotEmpty()) {
                Spacer(Modifier.height(4.dp))
                ReactionRow(message, onReactionClick)
            }
        }
    }
}

/**
 * Highlights @mention tokens, and a leading slash command.
 *
 * A command is not prose — it is an instruction addressed to software, and it
 * reads wrong in the same face as the sentence around it. Only a command at
 * the *start* of a message is treated as one, matching how the composer offers
 * completion: a slash anywhere else is a date, a fraction, or a path.
 */
private fun mentionStyled(
    text: String,
    mentionColor: androidx.compose.ui.graphics.Color,
    commandColor: androidx.compose.ui.graphics.Color,
) = androidx.compose.ui.text.buildAnnotatedString {
    var last = 0

    COMMAND_RE.find(text)?.let { command ->
        // No background: a SpanStyle background is a tight, square rectangle
        // with no padding, and it fights the rounded bubble it sits inside.
        // Weight and colour do the same job without drawing a second shape.
        withStyle(
            androidx.compose.ui.text.SpanStyle(
                color = commandColor,
                fontWeight = androidx.compose.ui.text.font.FontWeight.Bold,
            ),
        ) { append(command.value) }
        last = command.range.last + 1
    }

    val rest = text.substring(last)
    var cursor = 0
    for (match in MENTION_RE.findAll(rest)) {
        append(rest.substring(cursor, match.range.first))
        withStyle(
            androidx.compose.ui.text.SpanStyle(
                color = mentionColor,
                fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold,
            ),
        ) { append(match.value) }
        cursor = match.range.last + 1
    }
    append(rest.substring(cursor))
}

private val MENTION_RE = Regex("@[A-Za-z0-9_]{2,32}")

/** Anchored: only the first token, and only if the message opens with it. */
private val COMMAND_RE = Regex("^/[a-z][a-z0-9_-]{0,31}", RegexOption.IGNORE_CASE)

@Composable
private fun ReplyPreview(preview: String?, isMine: Boolean) {
    val colors = neuColors
    Row(
        Modifier
            .padding(bottom = 6.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(
                if (isMine) Color.White.copy(alpha = 0.16f) else colors.dark.copy(alpha = 0.10f),
            )
            .padding(horizontal = 8.dp, vertical = 5.dp),
    ) {
        Box(
            Modifier
                .width(2.5.dp)
                .height(18.dp)
                .background(if (isMine) colors.onOutgoing else colors.accent, RoundedCornerShape(2.dp)),
        )
        Spacer(Modifier.width(7.dp))
        Text(
            preview ?: "Message unavailable",
            style = MaterialTheme.typography.labelMedium,
            color = if (isMine) colors.onOutgoing.copy(alpha = 0.85f) else colors.textSecondary,
            maxLines = 1,
        )
    }
}

@Composable
private fun ReactionRow(message: Message, onClick: (String) -> Unit) {
    val colors = neuColors
    Row(horizontalArrangement = Arrangement.spacedBy(5.dp)) {
        message.reactions.entries.sortedByDescending { it.value }.take(6).forEach { (emoji, count) ->
            val mine = message.myReactions.contains(emoji)
            Row(
                Modifier
                    // Flat, like the bubbles they belong to. Yours are tinted
                    // with the accent — colour is the "you did this" signal.
                    .clip(RoundedCornerShape(Neu.CornerPill))
                    .background(if (mine) colors.accentSoft else colors.incoming)
                    .softClickable { onClick(emoji) }
                    .padding(horizontal = 8.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(emoji, style = MaterialTheme.typography.labelMedium)
                if (count > 1) {
                    Spacer(Modifier.width(4.dp))
                    Text(
                        count.toString(),
                        style = MaterialTheme.typography.labelSmall,
                        color = if (mine) colors.accent else colors.textTertiary,
                    )
                }
            }
        }
    }
}

@Composable
private fun StickerBody(message: Message) {
    AsyncImage(
        model = message.attachments.firstOrNull()?.url ?: message.gif?.url,
        contentDescription = "Sticker",
        modifier = Modifier.size(132.dp),
    )
}

@Composable
private fun GifBody(message: Message) {
    val gif = message.gif ?: return
    val ratio = if (gif.height > 0) gif.width.toFloat() / gif.height else 1.4f
    AsyncImage(
        model = gif.url,
        contentDescription = gif.title ?: "GIF",
        contentScale = ContentScale.Crop,
        modifier = Modifier
            .width(240.dp)
            .height((240f / ratio.coerceIn(0.5f, 2.5f)).dp)
            .clip(RoundedCornerShape(Neu.CornerSmall)),
    )
}

@Composable
private fun AttachmentBody(message: Message, isMine: Boolean, onOpenMedia: () -> Unit = {}) {
    val colors = neuColors
    val attachment = message.attachments.first()
    // Honour the real aspect ratio rather than cropping everything to a
    // letterbox — a portrait photo cropped to 4:3 loses the subject's head.
    val ratio = when {
        attachment.width != null && attachment.height != null && attachment.height!! > 0 ->
            (attachment.width!!.toFloat() / attachment.height!!).coerceIn(0.6f, 1.8f)
        else -> 1.33f
    }

    Column {
        Box(contentAlignment = Alignment.Center) {
            AsyncImage(
                model = attachment.thumbnailUrl ?: attachment.url,
                contentDescription = attachment.filename,
                contentScale = ContentScale.Crop,
                modifier = Modifier
                    .width(240.dp)
                    .height((240f / ratio).dp)
                    .clip(RoundedCornerShape(Neu.CornerSmall))
                    // Not while it is still uploading — there is nothing on
                    // the server to open yet.
                    .then(
                        if (message.isPending) Modifier
                        else Modifier.softClickable(onClick = onOpenMedia),
                    ),
            )
            // Still uploading: the picture is already on screen (it is the
            // local file), so the only thing missing is a sign of progress.
            if (message.isPending) {
                Box(
                    Modifier
                        .size(36.dp)
                        .clip(CircleShape)
                        .background(Color.Black.copy(alpha = 0.45f)),
                    contentAlignment = Alignment.Center,
                ) {
                    CircularProgressIndicator(
                        color = Color.White,
                        strokeWidth = 2.dp,
                        modifier = Modifier.size(20.dp),
                    )
                }
            }
        }
        if (!message.content.isNullOrBlank()) {
            Spacer(Modifier.height(6.dp))
            Text(
                message.content,
                style = MaterialTheme.typography.bodyMedium,
                color = if (isMine) colors.onOutgoing else colors.textPrimary,
            )
        }
    }
}

@Composable
private fun PollBody(message: Message, isMine: Boolean, onVote: (String) -> Unit) {
    val colors = neuColors
    val poll = message.poll ?: return
    val total = poll.options.sumOf { it.voteCount }.coerceAtLeast(1)
    val onColor = if (isMine) colors.onOutgoing else colors.textPrimary

    Column(Modifier.width(250.dp)) {
        Text(poll.question, style = MaterialTheme.typography.titleSmall, color = onColor)
        Spacer(Modifier.height(8.dp))

        poll.options.forEach { option ->
            val chosen = poll.myVotes.contains(option.id)
            val fraction = option.voteCount.toFloat() / total

            Box(
                Modifier
                    .fillMaxWidth()
                    .padding(vertical = 3.dp)
                    .clip(RoundedCornerShape(9.dp))
                    .background(if (isMine) Color.White.copy(alpha = 0.14f) else colors.dark.copy(alpha = 0.08f))
                    .softClickable(enabled = !poll.isClosed) { onVote(option.id) },
            ) {
                // The bar is a background fill rather than a separate progress
                // widget, so the row stays one tap target.
                Box(
                    Modifier
                        .fillMaxWidth(fraction)
                        .height(32.dp)
                        .background(
                            if (isMine) Color.White.copy(alpha = 0.20f) else colors.accent.copy(alpha = 0.20f),
                            RoundedCornerShape(9.dp),
                        ),
                )
                Row(
                    Modifier
                        .fillMaxWidth()
                        .height(32.dp)
                        .padding(horizontal = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        option.label,
                        style = MaterialTheme.typography.bodyMedium,
                        color = onColor,
                        modifier = Modifier.weight(1f),
                    )
                    if (chosen) {
                        Icon(Icons.Rounded.Check, null, tint = onColor, modifier = Modifier.size(14.dp))
                        Spacer(Modifier.width(5.dp))
                    }
                    Text(
                        option.voteCount.toString(),
                        style = MaterialTheme.typography.labelSmall,
                        color = onColor.copy(alpha = 0.75f),
                    )
                }
            }
        }

        Spacer(Modifier.height(5.dp))
        Text(
            buildString {
                append("${poll.totalVoters} vote${if (poll.totalVoters == 1) "" else "s"}")
                if (poll.isClosed) append(" · closed")
                if (poll.multiSelect) append(" · multiple choice")
            },
            style = MaterialTheme.typography.labelSmall,
            color = onColor.copy(alpha = 0.65f),
        )
    }
}

@Composable
private fun CallBody(message: Message, isMine: Boolean) {
    val colors = neuColors
    val summary = message.callSummary ?: return
    val missed = summary.outcome == "missed" || summary.outcome == "declined"
    val onColor = if (isMine) colors.onOutgoing else colors.textPrimary

    Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(
            if (missed) Icons.Rounded.CallMissed else Icons.Rounded.Call,
            null,
            tint = if (missed) colors.danger else onColor,
            modifier = Modifier.size(17.dp),
        )
        Spacer(Modifier.width(8.dp))
        Column {
            Text(
                when (summary.outcome) {
                    "missed" -> "Missed ${summary.mode} call"
                    "declined" -> "Call declined"
                    "cancelled" -> "Call cancelled"
                    else -> "${summary.mode.replaceFirstChar(Char::uppercase)} call"
                },
                style = MaterialTheme.typography.bodyMedium,
                color = onColor,
            )
            if (summary.durationSeconds > 0) {
                Text(
                    formatDuration(summary.durationSeconds),
                    style = MaterialTheme.typography.labelSmall,
                    color = onColor.copy(alpha = 0.7f),
                )
            }
        }
    }
}

/**
 * Group activity ("Alex added Sam").
 *
 * Centred, small, no bubble: it is part of the timeline but not part of the
 * conversation, and giving it a bubble makes people try to reply to it.
 */
@Composable
private fun SystemLine(message: Message) {
    val colors = neuColors
    val system = message.system ?: return

    val text = when (system.event) {
        "conversation_created" -> "Group created"
        "member_added" -> "Someone was added"
        "member_joined" -> "Someone joined"
        "member_left" -> "Someone left"
        "member_removed" -> "Someone was removed"
        "member_promoted" -> "Role updated"
        "member_demoted" -> "Role updated"
        "title_changed" -> "Group renamed${system.value?.let { " to \"$it\"" }.orEmpty()}"
        "avatar_changed" -> "Group photo updated"
        "message_pinned" -> "A message was pinned"
        // Worth spelling out: someone scrolling up will find the group's whole
        // history above this line and should know why it is here.
        "upgraded_to_space" -> "This group became a space — its history lives here now"
        "channel_created" -> "Channel created${system.value?.let { " · #$it" }.orEmpty()}"
        "disappearing_changed" ->
            if (system.value == "0") "Disappearing messages off" else "Disappearing messages on"
        else -> system.event.replace('_', ' ')
    }

    Box(Modifier.fillMaxWidth().padding(vertical = 10.dp), contentAlignment = Alignment.Center) {
        Box(
            Modifier
                .clip(CircleShape)
                .background(colors.dark.copy(alpha = 0.10f))
                .padding(horizontal = 14.dp, vertical = 6.dp),
        ) {
            Text(text, style = MaterialTheme.typography.labelSmall, color = colors.textTertiary)
        }
    }
}
