package gg.yappy.app.ui.chat

import androidx.compose.material.icons.rounded.InsertDriveFile
import androidx.compose.material.icons.rounded.Download
import androidx.compose.ui.platform.LocalUriHandler
import gg.yappy.app.data.Attachment
import kotlin.math.roundToInt
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextDecoration
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
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
import androidx.compose.material.icons.automirrored.rounded.Reply
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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import gg.yappy.app.data.ConversationAppearance
import gg.yappy.app.data.Message
import gg.yappy.app.data.MessageReceiptState
import gg.yappy.app.data.findPumpMints
import gg.yappy.app.data.isPumpFunUrl
import gg.yappy.app.ui.components.Avatar
import gg.yappy.app.ui.components.IdentityMarks
import gg.yappy.app.ui.components.flairColor
import gg.yappy.app.ui.components.softClickable
import androidx.compose.ui.text.style.TextOverflow
import gg.yappy.app.ui.theme.Neu
import gg.yappy.app.ui.theme.neuColors
import gg.yappy.app.ui.util.clockTime
import gg.yappy.app.ui.util.formatDuration
import kotlinx.coroutines.delay

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
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun MessageBubble(
    message: Message,
    isMine: Boolean,
    showAvatar: Boolean,
    isGrouped: Boolean,
    isPinned: Boolean,
    /**
     * Drawn as a card on a page rather than a bubble in a conversation.
     *
     * A bubble says "somebody said this to you, at a time". A card says "this
     * is true until it changes" — so it has no surface, no side, and its
     * author is always named, because a notice nobody signed is a notice
     * nobody is accountable for.
     */
    readsAsPage: Boolean = false,
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
    /** Sender-side delivery status, drawn beside the timestamp on own bubbles. */
    receipt: MessageReceiptState = MessageReceiptState.None,
    /** id → display name, for turning "Someone joined" into "Rayyan joined". */
    names: Map<String, String> = emptyMap(),
    /**
     * Where this share is *now*, when it is still moving. Null on a plain pin
     * and on a share that has finished — both of which draw their own point.
     */
    liveLocation: gg.yappy.app.data.LiveLocation? = null,
    /** Only offered on your own live share. */
    onStopLocation: () -> Unit = {},
    /**
     * A quick double-tap heart, the gesture everyone already has in their
     * fingers. The long-press sheet still offers the full picker.
     */
    onDoubleTap: () -> Unit = {},
    /**
     * A tapped @mention, reported as the bare username. Resolution is the
     * screen's job — the bubble does not know who is a member.
     */
    onMention: (String) -> Unit = {},
    /**
     * A tapped author name or avatar.
     *
     * The name and the face are the two things in a timeline that look like
     * they should open a profile, and until this they did nothing — you had
     * to find the person in the member list instead, which is a strange
     * detour from a message they just sent.
     */
    onOpenProfile: (String) -> Unit = {},
    /** Shared player, so starting one voice note stops the last. */
    voicePlayer: VoiceNotePlayer? = null,
    /** Builds authorised players for video notes and video files. */
    mediaFactory: MediaFactory? = null,
) {
    val colors = neuColors

    if (message.isSystem) {
        SystemLine(message, names)
        return
    }

    val videoNote = message.isVideoNote()

    /**
     * A sticker stands on its own — no bubble, the way every messenger draws
     * them. The image *is* the message. A video note is the same idea: a circle
     * inside a rounded rectangle reads as a mistake. A message that is nothing
     * but emoji is the third case: at that size the bubble is a box drawn
     * around a gesture.
     */
    val jumbo = jumboEmojiCount(message)
    /**
     * A picture, a video or a GIF sent with nothing said around it.
     *
     * The bubble around one of these was always doing nothing: a rounded box
     * hugging a rectangle that already has its own corners, adding a rim of
     * colour and no meaning. Every other messenger drops it.
     *
     * A caption keeps the bubble, and that is the whole distinction — once
     * there are words the bubble is holding *them*, and a floating line of text
     * under a photo has nothing to sit on. One attachment only: a grid of
     * several is a block that wants an edge.
     */
    val bareMedia = message.content.isNullOrEmpty() &&
        (
            message.type == "gif" ||
                (message.attachments.size == 1 && (message.type == "image" || message.type == "video"))
            )

    val bubbleless = !message.isDeleted &&
        (message.type == "sticker" || videoNote || jumbo != null || bareMedia)

    // Corner radii are asymmetric on the tail side, and only on the last bubble
    // of a run — that is what visually groups consecutive messages.
    val corner = 16.dp
    val shape = RoundedCornerShape(
        topStart = if (isMine || isGrouped) corner else 5.dp,
        topEnd = if (!isMine || isGrouped) corner else 5.dp,
        bottomStart = corner,
        bottomEnd = corner,
    )

    /**
     * Whether this content sits on the accent surface.
     *
     * "Mine" decides two things in a chat: which side the bubble hugs, and
     * whether the text is drawn for a purple background. A page has neither,
     * so the second question always answers no — otherwise a card you wrote
     * yourself is white text on the page.
     */
    val onAccent = isMine && !readsAsPage

    Row(
        modifier
            .fillMaxWidth()
            .padding(top = if (isGrouped) 2.dp else 10.dp),
        horizontalArrangement = if (isMine && !readsAsPage) Arrangement.End else Arrangement.Start,
        verticalAlignment = Alignment.Bottom,
    ) {
        // No avatar column on a page: an avatar per card reads as a
        // conversation, and the name alone does not.
        if (!isMine && !readsAsPage) {
            if (showAvatar) {
                Avatar(
                    url = message.sender?.avatarUrl,
                    name = message.sender?.label,
                    id = message.senderId ?: message.id,
                    size = 32.dp,
                    modifier = message.senderId?.let { id ->
                        Modifier.softClickable { onOpenProfile(id) }
                    } ?: Modifier,
                )
            } else {
                Spacer(Modifier.width(32.dp))
            }
            Spacer(Modifier.width(8.dp))
        }

        Column(
            horizontalAlignment = if (isMine && !readsAsPage) Alignment.End else Alignment.Start,
            // A card takes the page; a bubble takes only what it needs.
            modifier = if (readsAsPage) Modifier.fillMaxWidth() else Modifier.widthIn(max = 300.dp),
        ) {
            // Own bubbles carry no name in a chat — you know who you are, and
            // the bubble is already on your side. A page has no sides.
            if ((readsAsPage || (!isMine && showAvatar)) && message.sender != null) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier
                        .then(
                            message.senderId?.let { id ->
                                Modifier.softClickable { onOpenProfile(id) }
                            } ?: Modifier,
                        )
                        .padding(start = 6.dp, bottom = 3.dp),
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
                    // Knowing a message came from software is not a nicety — it
                    // is the difference between advice and an advertisement. It
                    // used to be drawn here by hand, at labelSmall, which is why
                    // the tag was taller and heavier in the timeline than the
                    // identical tag everywhere else. IdentityMarks draws it.
                    if (message.sender.badge != null ||
                        message.sender.affiliation != null ||
                        message.sender.isBot
                    ) {
                        Spacer(Modifier.width(4.dp))
                        IdentityMarks(message.sender, size = 13.dp)
                    }

                    // On a page this line is the only clock, so it carries the
                    // time the meta row would otherwise repeat underneath.
                    if (readsAsPage) {
                        Spacer(Modifier.width(6.dp))
                        Text(
                            clockTime(message.createdAt),
                            style = MaterialTheme.typography.labelSmall,
                            color = colors.textTertiary,
                        )
                    }
                }
            }

            // Above the bubble, outside it: attribution is about the message's
            // provenance, not part of what was said.
            message.forwardedFrom?.takeIf { !message.isDeleted }?.let { forwarded ->
                Row(
                    Modifier
                        .padding(bottom = 3.dp)
                        .padding(start = if (isMine) 0.dp else 2.dp, end = if (isMine) 2.dp else 0.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        Icons.AutoMirrored.Rounded.Reply,
                        null,
                        tint = colors.textTertiary,
                        modifier = Modifier.size(11.dp).scale(scaleX = -1f, scaleY = 1f),
                    )
                    Spacer(Modifier.width(4.dp))
                    Text(
                        "Forwarded from ${forwarded.label}",
                        style = MaterialTheme.typography.labelSmall.copy(fontStyle = FontStyle.Italic),
                        color = colors.textTertiary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
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

            if (bubbleless) {
                // Stickers, video notes and emoji-only messages, drawn without
                // the bubble: the media itself, with the time and ticks tucked
                // underneath.
                Column(
                    horizontalAlignment = if (isMine) Alignment.End else Alignment.Start,
                    modifier = Modifier
                        .combinedClickable(
                            interactionSource = null,
                            indication = null,
                            onDoubleClick = { if (!videoNote) onDoubleTap() },
                            onLongClick = onLongPress,
                            onClick = {},
                        ),
                ) {
                    when {
                        jumbo != null -> Text(
                            message.content.orEmpty(),
                            // Fewer glyphs, bigger glyphs — one emoji is a
                            // reaction, three are a sentence, and they should
                            // not be set at the same size.
                            fontSize = when (jumbo) {
                                1 -> 56.sp
                                2 -> 46.sp
                                else -> 38.sp
                            },
                            lineHeight = 64.sp,
                            color = colors.textPrimary,
                            modifier = Modifier.padding(vertical = 2.dp),
                        )

                        videoNote -> if (mediaFactory != null) {
                            VideoNoteBody(message, mediaFactory)
                        }

                        message.type == "gif" -> GifBody(message)
                        message.type == "video" -> VideoBody(message, onAccent, onOpenMedia)
                        message.type == "image" -> AttachmentBody(message, onAccent, onOpenMedia)

                        else -> StickerBody(message)
                    }

                    Spacer(Modifier.height(2.dp))
                    MetaRow(message, onAccent, isPinned, receipt, onSurface = true)
                }
            } else if (hasSpokenBody || !hasCard) {
            Box(
                Modifier
                    .clip(shape)
                    .then(
                        // A card has no surface. Giving it one — even a flat
                        // bordered one — is a bubble wearing a different coat.
                        when {
                            readsAsPage -> Modifier
                            outgoingBrush != null -> Modifier.background(outgoingBrush)
                            else -> Modifier.background(outgoingSolid)
                        },
                    )
                    .combinedClickable(
                        interactionSource = null,
                        indication = null,
                        onDoubleClick = onDoubleTap,
                        onLongClick = onLongPress,
                        onClick = {},
                    )
                    .padding(horizontal = 13.dp, vertical = 9.dp)
                    .alpha(if (message.isPending) 0.6f else 1f),
            ) {
                Column {
                    message.replyTo?.let { ReplyPreview(it.preview, onAccent) }

                    when {
                        message.isDeleted -> Text(
                            "This message was deleted",
                            style = MaterialTheme.typography.bodyMedium.copy(fontStyle = FontStyle.Italic),
                            color = if (onAccent) colors.onOutgoing.copy(alpha = 0.7f) else colors.textTertiary,
                        )

                        message.type == "sticker" -> StickerBody(message)
                        message.type == "gif" -> GifBody(message)
                        message.type == "location" -> message.location?.let { payload ->
                            LocationCard(payload, liveLocation, isMine, onStopLocation)
                        }

                        message.type == "poll" -> PollBody(message, onAccent, onVote)
                        message.type == "call" -> CallBody(message, onAccent)

                        message.type == "audio" -> if (voicePlayer != null) {
                            VoiceNoteBody(message, onAccent, voicePlayer)
                        }

                        // Video *notes* are drawn bubble-less above; only video
                        // files reach here, as a rectangle.
                        message.type == "video" -> VideoBody(message, onAccent, onOpenMedia)

                        // Anything that is not a picture or a video. Drawn
                        // before the media branch because that one hands
                        // every attachment to an image loader, and a PDF
                        // through an image loader is an empty grey box.
                        message.attachments.firstOrNull()?.isViewableMedia == false ->
                            FileBody(message.attachments.first(), onAccent)

                        message.attachments.isNotEmpty() -> AttachmentBody(message, onAccent, onOpenMedia)

                        else -> Text(
                            mentionStyled(
                                text = message.content.orEmpty(),
                                entities = message.entities,
                                // On an accent bubble the accent colour vanishes,
                                // so weight alone carries the mention and the
                                // command there.
                                highlight = if (onAccent) colors.onOutgoing else colors.accent,
                                onMention = onMention,
                                roles = message.mentionedRoles,
                            ),
                            style = MaterialTheme.typography.bodyLarge,
                            color = if (onAccent) colors.onOutgoing else colors.textPrimary,
                        )
                    }

                    // A thread grows from this message.
                    if (message.threadReplyCount > 0 && onOpenThread != null) {
                        Spacer(Modifier.height(5.dp))
                        Text(
                            "💬 ${message.threadReplyCount} ${if (message.threadReplyCount == 1) "reply" else "replies"} ›",
                            style = MaterialTheme.typography.labelMedium,
                            color = if (onAccent) colors.onOutgoing else colors.accent,
                            modifier = Modifier.softClickable { onOpenThread() },
                        )
                    }

                    Spacer(Modifier.height(3.dp))
                    // The author line above already says who and when. Repeating
                    // the clock under a card whose own text reads "updated a
                    // moment ago" gives three answers to one question — and
                    // delivery ticks mean nothing on a notice board.
                    if (!readsAsPage) {
                        MetaRow(message, onAccent, isPinned, receipt, onSurface = false)
                    }
                }
            }

            }

            // Embeds sit *outside* the bubble: a link preview is about the
            // message, not part of what was said.
            val pumpMints = remember(message.id, message.content, message.embeds) {
                findPumpMints(message)
            }
            if (message.embeds.isNotEmpty() && !message.isDeleted) {
                message.embeds
                    // A launchpad / DexScreener URL also unfurls as a generic
                    // OG card. The mint card below is the real preview.
                    .filterNot { pumpMints.isNotEmpty() && isPumpFunUrl(it.url) }
                    .take(4)
                    .forEach { embed ->
                    Spacer(Modifier.height(4.dp))
                    // An invite to one of our own groups is not a link preview
                    // and should not be read like one. The server only fills
                    // this in for a live invite, so a revoked or expired one
                    // falls back to the ordinary card rather than offering a
                    // join that cannot succeed.
                    val invite = embed.invite
                    if (invite != null) {
                        InviteEmbedCard(invite)
                    } else {
                        EmbedCard(
                            embed,
                            onOpenUrl = onOpenUrl,
                            // The client's own half of the trust check. The server
                            // already strips `kind` from anyone who is not a badged
                            // bot; this makes a bug there insufficient on its own.
                            trusted = message.sender?.isBot == true && message.sender?.badge == "staff",
                        )
                    }
                }
            }

            // Android-only: a pasted CA (Solana, BNB, Robinhood) becomes a
            // live coin card. Fetched on the device, not stored on the message.
            if (pumpMints.isNotEmpty() && !message.isDeleted) {
                pumpMints.forEach { mint ->
                    Spacer(Modifier.height(6.dp))
                    PumpChartCard(mint, onOpenUrl)
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
 *
 * Mentions are wrapped in a `LinkAnnotation`, which is what makes them tappable
 * — a mention is a door, not just paint. The link handling is Compose's, so it
 * gets the hit-testing right on wrapped and bidirectional text, which a
 * hand-rolled `onTextLayout` offset lookup reliably does not.
 */
private fun mentionStyled(
    text: String,
    highlight: Color,
    onMention: (String) -> Unit,
    /**
     * Spans the server computed — markdown on a board, or a bot saying what
     * it meant. Offsets are UTF-16 code units into this exact string, which
     * is what Kotlin indexes by, so they need no conversion.
     */
    entities: List<JsonElement>? = null,
    /** Role id → name and colour, for the `@role` spans above. */
    roles: Map<String, gg.yappy.app.data.MentionedRole> = emptyMap(),
) = androidx.compose.ui.text.buildAnnotatedString {
    val styles = styleSpans(entities, text.length)
    if (styles.isNotEmpty()) {
        // Server spans and the local regexes cannot both own the string, and
        // the server has better information: it knows a bot meant that word to
        // be bold, where a regex is guessing from punctuation.
        var cursor = 0
        for (span in styles) {
            // The gaps get the URL pass: the server described the spans, not
            // the prose between them, and a bare address there is still a link.
            if (span.start > cursor) appendLinkingUrls(text.substring(cursor, span.start), highlight)
            val body = text.substring(span.start, span.end)
            val url = span.url
            if (url != null) {
                withLink(
                    LinkAnnotation.Url(
                        url = url,
                        styles = TextLinkStyles(
                            style = SpanStyle(color = highlight, textDecoration = TextDecoration.Underline),
                        ),
                    ),
                ) { append(body) }
            } else {
                val roleColor = span.roleId?.let { flairColor(roles[it]?.color) }
                withStyle(span.style(highlight, roleColor)) { append(body) }
            }
            cursor = span.end
        }
        if (cursor < text.length) appendLinkingUrls(text.substring(cursor), highlight)
        return@buildAnnotatedString
    }

    var last = 0

    COMMAND_RE.find(text)?.let { command ->
        // No background: a SpanStyle background is a tight, square rectangle
        // with no padding, and it fights the rounded bubble it sits inside.
        // Weight and colour do the same job without drawing a second shape.
        withStyle(
            SpanStyle(color = highlight, fontWeight = FontWeight.Bold),
        ) { append(command.value) }
        last = command.range.last + 1
    }

    val rest = text.substring(last)

    /*
     * URLs and mentions in one ordered pass.
     *
     * Separate loops would each rewrite the string from its own cursor and
     * the second would lose whatever the first had built. A mention inside a
     * URL is dropped rather than drawn: "https://x.com/@someone" is one
     * address, and painting half of it as a mention both looks wrong and
     * steals the tap from the link it belongs to.
     */
    val urls = URL_RE.findAll(rest).map { Hit(it.range, it.value, null) }.toList()
    val mentions = MENTION_RE.findAll(rest)
        .filterNot { m -> urls.any { m.range.first >= it.range.first && m.range.last <= it.range.last } }
        .map { Hit(it.range, null, it.value.drop(1)) }
    val hits = (urls + mentions).sortedBy { it.range.first }

    var cursor = 0
    for (hit in hits) {
        if (hit.range.first > cursor) append(rest.substring(cursor, hit.range.first))
        val body = rest.substring(hit.range.first, hit.range.last + 1)
        if (hit.url != null) {
            withLink(
                LinkAnnotation.Url(
                    url = hit.url,
                    styles = TextLinkStyles(
                        style = SpanStyle(color = highlight, textDecoration = TextDecoration.Underline),
                    ),
                ),
            ) { append(body) }
        } else {
            val username = hit.username!!
            withLink(
                LinkAnnotation.Clickable(
                    tag = "mention:$username",
                    styles = TextLinkStyles(
                        style = SpanStyle(color = highlight, fontWeight = FontWeight.SemiBold),
                    ),
                    linkInteractionListener = { onMention(username) },
                ),
            ) { append(body) }
        }
        cursor = hit.range.last + 1
    }
    append(rest.substring(cursor))
}

/**
 * One span of styled text, as the server described it.
 *
 * Nothing here parses anything: markdown is turned into these on the way in
 * (see packages/shared/src/markdown.ts) precisely so that three clients do
 * not each get to have an opinion about what counts as bold.
 */
private class StyleSpan(
    val start: Int,
    val end: Int,
    val kind: String,
    val url: String?,
    val roleId: String? = null,
) {
    fun style(highlight: Color, roleColor: Color? = null): SpanStyle = when (kind) {
        "bold" -> SpanStyle(fontWeight = FontWeight.Bold)
        "italic" -> SpanStyle(fontStyle = FontStyle.Italic)
        "strike" -> SpanStyle(textDecoration = TextDecoration.LineThrough)
        "code" -> SpanStyle(fontFamily = FontFamily.Monospace)
        // No tap-to-reveal here yet, so it is drawn as marked-out text rather
        // than as a promise the bubble cannot keep.
        "spoiler" -> SpanStyle(background = highlight.copy(alpha = 0.25f))
        // A role wears its own colour where it has one. Falling back to the
        // highlight rather than to plain text matters: an uncoloured role is
        // still a mention, and drawing it as prose hides that somebody was
        // called.
        "mention_role" ->
            SpanStyle(color = roleColor ?: highlight, fontWeight = FontWeight.SemiBold)
        "mention", "mention_all" -> SpanStyle(color = highlight, fontWeight = FontWeight.SemiBold)
        else -> SpanStyle()
    }
}

/**
 * The spans worth drawing, in order, clipped to the text.
 *
 * A span that runs past the end is dropped rather than clamped: it means the
 * text and the offsets came from different versions of the message, and
 * half-applying it would style the wrong words.
 */
private fun styleSpans(entities: List<JsonElement>?, length: Int): List<StyleSpan> {
    if (entities.isNullOrEmpty()) return emptyList()
    val out = mutableListOf<StyleSpan>()
    for (element in entities) {
        val obj = element as? JsonObject ?: continue
        val kind = (obj["type"] as? JsonPrimitive)?.contentOrNull ?: continue
        val start = (obj["offset"] as? JsonPrimitive)?.intOrNull ?: continue
        val len = (obj["length"] as? JsonPrimitive)?.intOrNull ?: continue
        if (start < 0 || len <= 0 || start + len > length) continue
        val url = (obj["url"] as? JsonPrimitive)?.contentOrNull
        val roleId = (obj["roleId"] as? JsonPrimitive)?.contentOrNull
        out += StyleSpan(start, start + len, kind, url, roleId)
    }
    // Sorted and de-overlapped: the walk above assumes it can move forward.
    out.sortBy { it.start }
    var end = 0
    return out.filter { span ->
        val ok = span.start >= end
        if (ok) end = span.end
        ok
    }
}

private val MENTION_RE = Regex("@[A-Za-z0-9_]{2,32}")

/**
 * Bare URLs, which carry no entity: the server only computes those for a
 * board, so a link typed in a chat arrives as ordinary text.
 *
 * Character for character the web client's pattern (URL_IN_TEXT in
 * ChatView.tsx), so a link is a link in the same places on every client. The
 * closing class is what keeps trailing sentence punctuation out of the href —
 * "see https://yappy.gg." links the address and leaves the full stop as prose.
 */
private val URL_RE = Regex("""https?://[^\s<>"'()\[\]]+[^\s<>"'()\[\].,;:!?]""")

/** One autolinked run in the fallback pass: a URL, or an @mention. */
private class Hit(val range: IntRange, val url: String?, val username: String?)

/**
 * Appends plain text, linking any bare URL inside it.
 *
 * Used for the stretches *between* server spans. A board writes its markdown
 * as spans and leaves a bare address between them as ordinary text, so those
 * gaps still need looking at even when the server described everything else.
 */
private fun androidx.compose.ui.text.AnnotatedString.Builder.appendLinkingUrls(
    text: String,
    highlight: Color,
) {
    var cursor = 0
    for (match in URL_RE.findAll(text)) {
        if (match.range.first > cursor) append(text.substring(cursor, match.range.first))
        withLink(
            LinkAnnotation.Url(
                url = match.value,
                styles = TextLinkStyles(
                    style = SpanStyle(color = highlight, textDecoration = TextDecoration.Underline),
                ),
            ),
        ) { append(match.value) }
        cursor = match.range.last + 1
    }
    if (cursor < text.length) append(text.substring(cursor))
}

/** Anchored: only the first token, and only if the message opens with it. */
private val COMMAND_RE = Regex("^/[a-z][a-z0-9_-]{0,31}", RegexOption.IGNORE_CASE)

/**
 * How many emoji, when the message is *only* emoji. Null otherwise.
 *
 * Capped at three. Past that they wrap, the row stops reading as a single
 * gesture, and every other messenger draws the line in about the same place.
 * Anything else in the message — a quote, an attachment, a card, or one stray
 * character of text — puts the bubble back, because then the emoji is
 * punctuation rather than the whole point.
 */
private fun jumboEmojiCount(message: Message): Int? {
    if (message.type != "text") return null
    if (message.replyTo != null) return null
    if (message.attachments.isNotEmpty() || message.embeds.isNotEmpty()) return null
    if (message.components.isNotEmpty()) return null

    val raw = message.content?.trim().orEmpty()
    if (raw.isEmpty()) return null

    // Grapheme clusters, not chars: a flag is two code points and a family with
    // skin tones is seven, and counting `Char`s calls both of those "too long".
    val clusters = graphemeClusters(raw)
    if (clusters.isEmpty() || clusters.size > 3) return null
    return if (clusters.all { it.isPureEmoji() }) clusters.size else null
}

private fun graphemeClusters(text: String): List<String> {
    val iterator = java.text.BreakIterator.getCharacterInstance()
    iterator.setText(text)
    val result = mutableListOf<String>()
    var start = iterator.first()
    var end = iterator.next()
    while (end != java.text.BreakIterator.DONE) {
        result.add(text.substring(start, end))
        start = end
        end = iterator.next()
    }
    return result
}

/**
 * Code points that are *drawn* as emoji by default.
 *
 * Deliberately a hand-written table rather than `Character.isEmoji`, which is a
 * Java 21 API that Android only shipped in API 35 — calling it would crash
 * every device below Android 15, which is nearly all of them.
 *
 * The ranges are the emoji-presentation ones only. That exclusion is the whole
 * point: ASCII digits, `#` and `*` carry the emoji *property* because they are
 * the base of the keycap sequences (0️⃣, #️⃣), so a table built on the property
 * would make "123" an emoji-only message and blow it up to 56sp.
 */
private val EMOJI_RANGES = listOf(
    0x1F300..0x1F5FF, // symbols and pictographs
    0x1F600..0x1F64F, // emoticons
    0x1F680..0x1F6FF, // transport and map
    0x1F900..0x1F9FF, // supplemental symbols, most people
    0x1FA70..0x1FAFF, // symbols extended-A
    0x1F1E6..0x1F1FF, // regional indicators, which pair into flags
    0x2600..0x26FF, // miscellaneous symbols
    0x2700..0x27BF, // dingbats
    0x2B00..0x2BFF, // arrows and shapes
    0x1F000..0x1F02F, // mahjong and dominoes
    0x1F0A0..0x1F0FF, // playing cards
)

/**
 * True for a grapheme cluster that reads as emoji.
 *
 * A multi-code-point cluster whose *first* code point is emoji counts: that is
 * what flags, skin tones, ZWJ families and keycaps all look like. A single code
 * point has to be in the table on its own.
 */
private fun String.isPureEmoji(): Boolean {
    if (isEmpty()) return false
    val first = codePointAt(0)
    return EMOJI_RANGES.any { first in it }
}

/**
 * Pin, "edited", the time, and the ticks.
 *
 * @param onSurface The row is under a bubbleless message and sits on the page
 *   rather than on the accent fill, so it takes the ordinary text colours —
 *   `onOutgoing` on the surface is invisible.
 */
@Composable
private fun MetaRow(
    message: Message,
    isMine: Boolean,
    isPinned: Boolean,
    receipt: MessageReceiptState,
    onSurface: Boolean,
) {
    val colors = neuColors
    val dim = when {
        onSurface -> colors.textTertiary
        isMine -> colors.onOutgoing.copy(alpha = 0.7f)
        else -> colors.textTertiary
    }

    Row(verticalAlignment = Alignment.CenterVertically) {
        if (isPinned) {
            Icon(Icons.Rounded.PushPin, null, tint = dim, modifier = Modifier.size(11.dp))
            Spacer(Modifier.width(4.dp))
        }
        if (message.editedAt != null) {
            Text("edited", style = MaterialTheme.typography.labelSmall, color = dim)
            Spacer(Modifier.width(5.dp))
        }
        Text(clockTime(message.createdAt), style = MaterialTheme.typography.labelSmall, color = dim)
        if (isMine) {
            Spacer(Modifier.width(4.dp))
            Ticks(message, receipt, dim, read = if (onSurface) colors.accent else colors.onOutgoing)
        }
    }
}

/**
 * The tick ladder, in the grammar WhatsApp taught everyone: a clock while
 * sending, one tick on the server, two when their device has it, and the pair
 * brightening when they have read it.
 *
 * Colour carries the read state rather than a hue swap because these sit on the
 * accent bubble, where a blue-on-violet pair would just look broken.
 */
@Composable
private fun Ticks(
    message: Message,
    receipt: MessageReceiptState,
    dim: Color,
    read: Color,
) {
    when (receipt) {
        MessageReceiptState.Pending -> Icon(
            Icons.Rounded.Schedule,
            "Sending",
            tint = dim,
            modifier = Modifier.size(12.dp),
        )

        // `None` falls back to the plain sent mark: a bubble with no receipt
        // information should not pretend to know more.
        MessageReceiptState.None, MessageReceiptState.Sent -> Icon(
            if (message.isPending) Icons.Rounded.Schedule else Icons.Rounded.Check,
            if (message.isPending) "Sending" else "Sent",
            tint = dim,
            modifier = Modifier.size(12.dp),
        )

        MessageReceiptState.Delivered, MessageReceiptState.Read -> Icon(
            Icons.Rounded.DoneAll,
            if (receipt == MessageReceiptState.Read) "Read" else "Delivered",
            tint = if (receipt == MessageReceiptState.Read) read else dim,
            modifier = Modifier.size(13.dp),
        )
    }
}

@Composable
private fun ReplyPreview(preview: String?, isMine: Boolean) {
    val colors = neuColors
    Row(
        Modifier
            .padding(bottom = 6.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(
                if (isMine) Color.White.copy(alpha = 0.16f) else colors.veil,
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

/**
 * The room's custom emoji, name → image URL, provided by ChatScreen. A
 * composition local rather than a parameter because it would otherwise thread
 * through every surface that draws a bubble for the benefit of one chip.
 */
val LocalCustomEmoji = compositionLocalOf { emptyMap<String, String>() }

/** Reaction keys shaped `:name:` are custom-emoji references, web-convention. */
private val CUSTOM_EMOJI_KEY = Regex("^:([a-z0-9_]{2,32}):$")

@Composable
private fun ReactionRow(message: Message, onClick: (String) -> Unit) {
    Row(horizontalArrangement = Arrangement.spacedBy(5.dp)) {
        message.reactions.entries.sortedByDescending { it.value }.take(6).forEach { (emoji, count) ->
            ReactionChip(
                emoji = emoji,
                count = count,
                mine = message.myReactions.contains(emoji),
                onClick = { onClick(emoji) },
            )
        }
    }
}

/**
 * One emoji-and-count capsule under a bubble.
 *
 * Its own composable so it can own the pop: a spring overshoot whenever the
 * count moves or your own reaction lands, plus a tick of haptic on the tap
 * itself. Reactions are the most-pressed playful surface in the app, and they
 * used to just silently change.
 */
@Composable
private fun ReactionChip(emoji: String, count: Int, mine: Boolean, onClick: () -> Unit) {
    val colors = neuColors
    val haptics = LocalHapticFeedback.current
    var popped by remember { mutableStateOf(false) }

    val scale by animateFloatAsState(
        targetValue = if (popped) 1.3f else 1f,
        animationSpec = spring(dampingRatio = 0.45f, stiffness = 900f),
        label = "reaction-pop",
    )

    LaunchedEffect(count, mine) {
        popped = true
        delay(130)
        popped = false
    }

    Row(
        Modifier
            .scale(scale)
            // Flat, like the bubbles they belong to. Yours are tinted with the
            // accent — colour is the "you did this" signal.
            .clip(RoundedCornerShape(Neu.CornerPill))
            .background(if (mine) colors.accentSoft else colors.incoming)
            .softClickable {
                haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                onClick()
            }
            .padding(horizontal = 8.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // A `:name:` key that resolves in this room draws as the image; one
        // that does not falls back to its literal text, which is what every
        // build before custom emoji did anyway.
        val customUrl = CUSTOM_EMOJI_KEY.find(emoji)
            ?.groupValues?.get(1)
            ?.let { LocalCustomEmoji.current[it] }
        if (customUrl != null) {
            AsyncImage(
                model = customUrl,
                contentDescription = emoji,
                modifier = Modifier.size(18.dp),
            )
        } else {
            Text(emoji, style = MaterialTheme.typography.labelMedium)
        }
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

@Composable
private fun StickerBody(message: Message) {
    AsyncImage(
        // The hydrated sticker is the real source — a sticker message carries
        // no attachment, so the old fallback chain resolved to null and drew
        // 132dp of nothing.
        model = message.sticker?.url ?: message.attachments.firstOrNull()?.url ?: message.gif?.url,
        contentDescription = message.sticker?.name ?: "Sticker",
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

/** Whether this is something the media viewer can show. */
private val Attachment.isViewableMedia: Boolean
    get() = mimeType.startsWith("image/") || mimeType.startsWith("video/") ||
        mimeType.startsWith("audio/")

/**
 * Bytes as somebody would say them out loud.
 *
 * One decimal below ten and none above: "8.4 MB" is useful, "847.3 KB" is
 * noise.
 */
private fun humanSize(bytes: Long): String? {
    if (bytes <= 0) return null
    if (bytes < 1000) return "$bytes B"
    var value = bytes.toDouble() / 1000
    val units = listOf("KB", "MB", "GB")
    var unit = 0
    while (value >= 1000 && unit < units.lastIndex) {
        value /= 1000
        unit++
    }
    val rounded = if (value < 10) String.format("%.1f", value) else value.roundToInt().toString()
    return "$rounded ${units[unit]}"
}

/**
 * The shape of the thing, in one word.
 *
 * Deliberately coarse: a dozen icons for a dozen archive formats is a lot of
 * drawing to repeat what the file extension already said. The label is for the
 * glance that says "document" rather than "photo".
 */
private fun fileLabel(mimeType: String, filename: String?): String {
    val ext = filename?.substringAfterLast('.', "")?.lowercase().orEmpty()
    return when {
        mimeType == "application/pdf" || ext == "pdf" -> "PDF"
        mimeType == "application/zip" || ext in listOf("zip", "rar", "7z", "tar", "gz") -> "Archive"
        mimeType.startsWith("text/") || ext in listOf("txt", "md", "csv", "log") -> "Text"
        ext.isNotEmpty() -> ext.uppercase()
        else -> "File"
    }
}

/**
 * A file that is not a photo, a video, or a voice note.
 *
 * What it is, how big it is, and one obvious action. Size earns its place:
 * the difference between a 40 KB contract and a 180 MB archive decides whether
 * somebody taps it on mobile data, and it is the one thing a filename never
 * tells you.
 *
 * Opening hands the URL to the system, which is the honest answer on a phone:
 * whatever app owns PDFs already renders them better than a chat client will,
 * and a download the OS manages is one the person can find again.
 */
@Composable
private fun FileBody(attachment: Attachment, isMine: Boolean) {
    val colors = neuColors
    val uriHandler = LocalUriHandler.current
    val label = fileLabel(attachment.mimeType, attachment.filename)
    val size = humanSize(attachment.size)
    val tint = if (isMine) colors.onOutgoing else colors.accent

    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        modifier = Modifier
            .widthIn(max = 260.dp)
            .clip(RoundedCornerShape(Neu.CornerSmall))
            .softClickable(onClick = { runCatching { uriHandler.openUri(attachment.url) } })
            .padding(vertical = 4.dp),
    ) {
        Box(
            Modifier
                .size(34.dp)
                .clip(RoundedCornerShape(10.dp))
                .background(tint.copy(alpha = 0.14f)),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                Icons.Rounded.InsertDriveFile,
                contentDescription = null,
                tint = tint,
                modifier = Modifier.size(18.dp),
            )
        }

        Column(Modifier.weight(1f, fill = false)) {
            Text(
                attachment.filename ?: "file",
                style = MaterialTheme.typography.bodyMedium,
                color = if (isMine) colors.onOutgoing else colors.textPrimary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                listOfNotNull(label, size).joinToString(" · "),
                style = MaterialTheme.typography.labelSmall,
                color = if (isMine) colors.onOutgoing.copy(alpha = 0.7f) else colors.textTertiary,
            )
        }

        Icon(
            Icons.Rounded.Download,
            contentDescription = "Open",
            tint = if (isMine) colors.onOutgoing.copy(alpha = 0.7f) else colors.textTertiary,
            modifier = Modifier.size(18.dp),
        )
    }
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
                    .background(if (isMine) Color.White.copy(alpha = 0.14f) else colors.veil)
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
private fun SystemLine(message: Message, names: Map<String, String> = emptyMap()) {
    val colors = neuColors
    val system = message.system ?: return

    /**
     * The server's answer first, the roster second.
     *
     * The roster loads after the timeline does, so preferring it meant every
     * system line flashed "Someone added someone" for as long as that request
     * took — and settled there permanently for anyone who had since left, who
     * appears in no roster to look up.
     */
    val name = { id: String -> message.systemNames[id] ?: names[id] }

    /** The actor's name, or a graceful fallback for someone no longer loaded. */
    val actor = system.actorId?.let { name(it) } ?: "Someone"

    /** The targets, joined — "Sam", "Sam and Alex", "Sam and 2 others". */
    val targets = system.targetIds.map { name(it) ?: "someone" }.let { resolved ->
        when (resolved.size) {
            0 -> "someone"
            1 -> resolved[0]
            2 -> "${resolved[0]} and ${resolved[1]}"
            else -> "${resolved[0]} and ${resolved.size - 1} others"
        }
    }

    val text = when (system.event) {
        "conversation_created" -> "$actor created the group"
        "member_added" -> "$actor added $targets"
        "member_joined" -> "$actor joined"
        "member_left" -> "$actor left"
        "member_removed" -> "$actor removed $targets"
        "member_promoted" -> "$actor promoted $targets"
        "member_demoted" -> "$actor demoted $targets"
        "title_changed" -> "$actor renamed the group${system.value?.let { " to \"$it\"" }.orEmpty()}"
        "avatar_changed" -> "$actor changed the group photo"
        "message_pinned" -> "$actor pinned a message"
        // Worth spelling out: someone scrolling up will find the group's whole
        // history above this line and should know why it is here.
        "upgraded_to_space" -> "This group became a space — its history lives here now"
        "channel_created" -> "Channel created${system.value?.let { " · #$it" }.orEmpty()}"
        "disappearing_changed" ->
            if (system.value == "0") "Disappearing messages off" else "Disappearing messages on"
        "campfire_ending" -> "🔥 This campfire is ending soon — say your goodbyes"
        // Deliberately plain. "Took a screenshot" is what happened; anything
        // warier would imply the room was sealed until this moment, and it
        // never was.
        "screenshot_taken" -> "📸 $actor took a screenshot"
        else -> system.event.replace('_', ' ')
    }

    Box(Modifier.fillMaxWidth().padding(vertical = 10.dp), contentAlignment = Alignment.Center) {
        Box(
            Modifier
                .clip(CircleShape)
                .background(colors.veil)
                .padding(horizontal = 14.dp, vertical = 6.dp),
        ) {
            Text(text, style = MaterialTheme.typography.labelSmall, color = colors.textTertiary)
        }
    }
}
