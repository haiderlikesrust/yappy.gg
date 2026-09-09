package gg.yappy.app.ui.chat

import android.annotation.SuppressLint
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material.icons.rounded.PlayArrow
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Campaign
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import gg.yappy.app.data.Embed
import gg.yappy.app.ui.components.flairColor
import gg.yappy.app.ui.components.softClickable
import gg.yappy.app.ui.theme.neuColors

/**
 * A rich card, Discord-shaped.
 *
 * Flat, like every other piece of *content* in this app — the accent bar down
 * the left edge does the work a shadow would do elsewhere, and it is the one
 * place an author-chosen colour is allowed to land.
 *
 * Deliberately not clickable as a whole: a card whose every pixel is a link is
 * how people get phished. Only the title opens the URL.
 *
 * @param trusted whether the *sender* is a badged first-party bot.
 *
 *   The gate on [Embed.kind], and it is not paranoia for its own sake. `kind`
 *   changes how the card is treated, not merely how it looks: an announcement
 *   drops the eight-line cap, and that cap is what stops an untrusted bot
 *   filling somebody's screen. Rendering on the field alone would let any app
 *   author mint something that looks like a notice from us. The server already
 *   strips `kind` from non-badged senders; this is the second, independent
 *   check, so a bug in either one is not enough on its own.
 */
@Composable
fun EmbedCard(
    embed: Embed,
    onOpenUrl: (String) -> Unit,
    modifier: Modifier = Modifier,
    trusted: Boolean = false,
    /** The message's own long-press, so holding the card reaches the same sheet as holding the bubble. */
    onLongPress: (() -> Unit)? = null,
) {
    val colors = neuColors
    val accent = flairColor(embed.color) ?: colors.accent
    val announcement = trusted && embed.kind == "announcement"

    if (announcement) {
        AnnouncementCard(embed, accent, modifier)
        return
    }

    // A pasted link is not a bot's card and should not dress like one. It
    // reads as a page: picture first, then where it is from, then what it is.
    if (embed.type == "link") {
        LinkCard(embed, onOpenUrl, onLongPress, modifier)
        return
    }

    Row(
        modifier
            .widthIn(max = 300.dp)
            // Intrinsic min height lets the accent bar match the content's
            // height; without it `fillMaxHeight` inside a Row has nothing to
            // measure against and the bar collapses.
            .height(IntrinsicSize.Min)
            .clip(RoundedCornerShape(12.dp))
            .background(colors.incoming),
    ) {
        Box(Modifier.width(4.dp).fillMaxHeight().background(accent))
        Column(Modifier.padding(horizontal = 12.dp, vertical = 10.dp)) {

            embed.author?.let { author ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    author.iconUrl?.let {
                        AsyncImage(
                            model = it,
                            contentDescription = null,
                            modifier = Modifier.size(18.dp).clip(CircleShape),
                        )
                        Spacer(Modifier.width(6.dp))
                    }
                    Text(
                        author.name,
                        style = MaterialTheme.typography.labelMedium,
                        color = colors.textSecondary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                Spacer(Modifier.height(4.dp))
            }

            embed.provider?.takeIf { embed.author == null }?.let {
                Text(it, style = MaterialTheme.typography.labelSmall, color = colors.textTertiary)
                Spacer(Modifier.height(3.dp))
            }

            embed.title?.let { title ->
                Text(
                    title,
                    style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.SemiBold),
                    color = if (embed.url != null) accent else colors.textPrimary,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    modifier = if (embed.url != null) {
                        Modifier.softClickable { onOpenUrl(embed.url) }
                    } else {
                        Modifier
                    },
                )
                Spacer(Modifier.height(4.dp))
            }

            embed.description?.let { text ->
                /**
                 * Capped, but not locked. The eight-line ceiling exists so an
                 * untrusted bot cannot fill the screen — that stands. What it
                 * must not do is *hide* the rest with no way in, which is what
                 * an ellipsis with no affordance was: the reader could see
                 * there was more and had no way to get it. Now the cap is the
                 * default and a tap is the consent.
                 */
                var expanded by remember(text) { mutableStateOf(false) }
                var clipped by remember(text) { mutableStateOf(false) }
                Text(
                    text,
                    style = MaterialTheme.typography.bodyMedium,
                    color = colors.textSecondary,
                    maxLines = if (expanded) Int.MAX_VALUE else 8,
                    overflow = TextOverflow.Ellipsis,
                    onTextLayout = { if (it.hasVisualOverflow) clipped = true },
                )
                if (clipped || expanded) {
                    Text(
                        if (expanded) "Show less" else "Show more",
                        style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.SemiBold),
                        color = accent,
                        modifier = Modifier
                            .padding(top = 3.dp)
                            .softClickable { expanded = !expanded },
                    )
                }
            }

            // The chart, when the card carries one. Below the description on
            // purpose: the text is the numbers, the chart is their shape.
            embed.chart?.let { chart ->
                Spacer(Modifier.height(8.dp))
                ChartView(chart)
            }

            if (embed.fields.isNotEmpty()) {
                Spacer(Modifier.height(8.dp))
                // Inline fields sit two-up; block fields take the full width.
                // Chunking rather than a grid keeps the order authors expect.
                val rows = mutableListOf<List<gg.yappy.app.data.EmbedField>>()
                var run = mutableListOf<gg.yappy.app.data.EmbedField>()
                for (field in embed.fields) {
                    if (field.inline) {
                        run.add(field)
                        if (run.size == 2) { rows.add(run); run = mutableListOf() }
                    } else {
                        if (run.isNotEmpty()) { rows.add(run); run = mutableListOf() }
                        rows.add(listOf(field))
                    }
                }
                if (run.isNotEmpty()) rows.add(run)

                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    rows.forEach { rowFields ->
                        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            rowFields.forEach { field ->
                                Column(Modifier.weight(1f)) {
                                    Text(
                                        field.name,
                                        style = MaterialTheme.typography.labelSmall.copy(
                                            fontWeight = FontWeight.SemiBold,
                                        ),
                                        color = colors.textPrimary,
                                    )
                                    Text(
                                        field.value,
                                        style = MaterialTheme.typography.bodyMedium,
                                        color = colors.textSecondary,
                                    )
                                }
                            }
                            if (rowFields.size == 1 && rowFields[0].inline) {
                                Spacer(Modifier.weight(1f))
                            }
                        }
                    }
                }
            }

            embed.image?.let {
                Spacer(Modifier.height(8.dp))
                AsyncImage(
                    model = it.url,
                    contentDescription = embed.title,
                    contentScale = ContentScale.Crop,
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(150.dp)
                        .clip(RoundedCornerShape(8.dp)),
                )
            }

            embed.footer?.let { footer ->
                Spacer(Modifier.height(8.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    footer.iconUrl?.let {
                        AsyncImage(
                            model = it,
                            contentDescription = null,
                            modifier = Modifier.size(14.dp).clip(CircleShape),
                        )
                        Spacer(Modifier.width(5.dp))
                    }
                    Text(
                        footer.text,
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.textTertiary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}

/**
 * A link preview.
 *
 * Two layouts, chosen from the picture's shape before it loads, so the card
 * never reflows under the reader:
 *
 *  - **Wide** (an article, a video) — the picture is a hero across the top
 *    and the words sit under it. This is what a shared link *is* in every
 *    messenger people already use, and it is the layout the unfurl was
 *    always meant to produce before the picture was thrown away.
 *  - **Square-ish** (an album, a repo, a profile) — a thumbnail on the right
 *    of the text. A square stretched into a hero is a cropped face.
 *
 * No accent bar. The bar is the grammar of "a bot said something"; this is
 * a page somebody pointed at, and the picture is its identity.
 *
 * The whole card opens the link, unlike the rich card above: the URL here is
 * the one that was pasted and is right there in the message, so there is
 * nothing for a tap to be tricked into. When the link is a video, a tap on
 * the picture plays it *here* instead, and the words still open the page.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun LinkCard(
    embed: Embed,
    onOpenUrl: (String) -> Unit,
    onLongPress: (() -> Unit)?,
    modifier: Modifier = Modifier,
) {
    val colors = neuColors
    val url = embed.url
    val image = embed.image
    val open: () -> Unit = { if (url != null) onOpenUrl(url) }
    // A tap opens, a hold is the message's hold. The card used to be only
    // tappable, so holding it — the gesture every other part of a message
    // answers with the action sheet — opened the browser instead.
    fun Modifier.tapOrHold(onTap: () -> Unit): Modifier = combinedClickable(
        interactionSource = null,
        indication = null,
        onLongClick = onLongPress,
        onClick = onTap,
    )
    // Older servers sent the picture without a size; treat that as wide, which
    // is what most `og:image`s are.
    val wide = image != null && (image.width == null || image.height == null || image.width >= image.height * 1.25f)
    var playing by remember(embed.video?.url) { mutableStateOf(false) }

    Column(
        modifier
            .widthIn(max = 300.dp)
            .clip(RoundedCornerShape(14.dp))
            .background(colors.incoming),
    ) {
        if (image != null && wide) {
            val video = embed.video
            // The stored copy's ratio, kept within reason: a 3:1 banner as a
            // hero is a strip, and a 5:4 frame is a wall.
            val ratio = if (image.width != null && image.height != null) {
                (image.width.toFloat() / image.height).coerceIn(1.25f, 2.1f)
            } else 1.91f

            if (playing && video != null) {
                InlinePlayer(video.url, ratio = 16f / 9f, onOpenUrl = onOpenUrl)
            } else {
                Box(
                    Modifier
                        .fillMaxWidth()
                        .aspectRatio(ratio)
                        .tapOrHold { if (video != null) playing = true else open() },
                    contentAlignment = Alignment.Center,
                ) {
                    AsyncImage(
                        model = image.url,
                        contentDescription = embed.title,
                        contentScale = ContentScale.Crop,
                        modifier = Modifier.fillMaxSize(),
                    )
                    if (video != null) {
                        // A play glyph on a scrim, the size a thumb expects. The
                        // picture alone says "a video" to nobody.
                        Box(
                            Modifier
                                .size(52.dp)
                                .clip(CircleShape)
                                .background(Color.Black.copy(alpha = 0.55f)),
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(
                                Icons.Rounded.PlayArrow,
                                contentDescription = "Play",
                                tint = Color.White,
                                modifier = Modifier.size(32.dp),
                            )
                        }
                    }
                }
            }
        }

        Row(
            Modifier
                .fillMaxWidth()
                .tapOrHold(open)
                .padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                (embed.provider ?: url?.let { hostOf(it) })?.let {
                    Text(
                        it,
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.textTertiary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Spacer(Modifier.height(2.dp))
                }
                embed.title?.let {
                    Text(
                        it,
                        style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.SemiBold),
                        color = colors.textPrimary,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                embed.description?.let {
                    Spacer(Modifier.height(3.dp))
                    Text(
                        it,
                        style = MaterialTheme.typography.bodySmall,
                        color = colors.textSecondary,
                        // Three lines. The page has the rest; the card is the
                        // reason to go there, not a copy of it.
                        maxLines = if (image != null && wide) 2 else 3,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            if (image != null && !wide) {
                Spacer(Modifier.width(12.dp))
                Box(
                    Modifier
                        .size(64.dp)
                        .clip(RoundedCornerShape(10.dp))
                        .tapOrHold { if (embed.video != null) playing = true else open() },
                    contentAlignment = Alignment.Center,
                ) {
                    AsyncImage(
                        model = image.url,
                        contentDescription = null,
                        contentScale = ContentScale.Crop,
                        modifier = Modifier.fillMaxSize(),
                    )
                    if (embed.video != null && !playing) {
                        Icon(
                            Icons.Rounded.PlayArrow,
                            contentDescription = "Play",
                            tint = Color.White,
                            modifier = Modifier
                                .size(28.dp)
                                .clip(CircleShape)
                                .background(Color.Black.copy(alpha = 0.55f))
                                .padding(3.dp),
                        )
                    }
                }
            }
        }

        // A square-thumbnail video (Spotify) plays underneath the words: the
        // player is wide whatever the cover was.
        val video = embed.video
        if (playing && video != null && !(image != null && wide)) {
            InlinePlayer(video.url, ratio = if (video.provider == "spotify") 300f / 152f else 16f / 9f, onOpenUrl = onOpenUrl)
        }
    }
}

/**
 * The provider's own embed page, in a WebView the size of the picture it
 * replaces.
 *
 * Framed in a one-line host page served from our own origin rather than
 * loaded bare. YouTube refuses an embed with no referrer ("error 153") and
 * every provider's allow-list is written in terms of the *embedding* site,
 * which a bare `loadUrl` has no way to be. So the WebView is yappy.gg for a
 * moment, holding an iframe, exactly as the web client is.
 *
 * Locked to that page: any top-level navigation the player tries — a "watch
 * on YouTube" title tap, an ad — leaves the card and opens in the browser,
 * so a WebView inside the chat never becomes a browser inside the chat.
 * Destroyed when the card leaves the screen, which also stops the sound; a
 * player that kept singing from a scrolled-away card would be the first
 * thing anybody complained about.
 */
@SuppressLint("SetJavaScriptEnabled")
@Composable
private fun InlinePlayer(url: String, ratio: Float, onOpenUrl: (String) -> Unit) {
    val page = remember(url) {
        val src = url.replace("&", "&amp;").replace("\"", "&quot;")
        """<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
        <body style="margin:0;background:#000;overflow:hidden">
        <iframe src="$src" style="position:fixed;inset:0;width:100%;height:100%;border:0"
          allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe></body></html>"""
    }
    AndroidView(
        modifier = Modifier
            .fillMaxWidth()
            .aspectRatio(ratio)
            .background(Color.Black),
        factory = { context ->
            WebView(context).apply {
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = true
                // The tap on the thumbnail *was* the gesture; the page must
                // not demand a second one.
                settings.mediaPlaybackRequiresUserGesture = false
                setBackgroundColor(android.graphics.Color.BLACK)
                webChromeClient = WebChromeClient()
                webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                        // The frame may do as it likes inside itself; only a
                        // navigation of the *page* — the player trying to
                        // take over the WebView — is a link out.
                        if (!request.isForMainFrame) return false
                        onOpenUrl(request.url.toString())
                        return true
                    }
                }
                loadDataWithBaseURL("https://yappy.gg/", page, "text/html", "utf-8", null)
            }
        },
        onRelease = { it.stopLoading(); it.destroy() },
    )
}

/** "github.com" from a URL, for a preview the scrape gave no site name. */
private fun hostOf(url: String): String? =
    runCatching { android.net.Uri.parse(url).host?.removePrefix("www.") }.getOrNull()

/**
 * A staff announcement.
 *
 * Reads as a notice rather than a bot card, and the differences are deliberate
 * rather than decorative:
 *
 *  - **A header band instead of a 4dp left bar.** The bar is the visual grammar
 *    of "some bot said something". This is the app talking, and it should not
 *    be scannable past.
 *  - **No line cap on the body.** The eight-line cap exists to stop an
 *    untrusted bot filling the screen; a staff notice is not untrusted, and
 *    truncating the one message everybody is meant to read was the bug that
 *    started this. Only reachable when [EmbedCard.trusted] is true.
 *  - **A timestamp.** "Posted 2:37 AM" is what a service notice wants, and it
 *    beats a hand-typed date in the footer that nobody remembers to update.
 */
@Composable
private fun AnnouncementCard(embed: Embed, accent: Color, modifier: Modifier = Modifier) {
    val colors = neuColors

    Column(
        modifier
            .widthIn(max = 320.dp)
            .clip(RoundedCornerShape(14.dp))
            .background(colors.incoming),
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .background(accent.copy(alpha = 0.16f))
                .padding(horizontal = 12.dp, vertical = 7.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // The same megaphone the space screen uses for announcement
            // channels — one symbol for one concept. An icon over the emoji
            // because it takes the accent tint; the emoji drew itself in its
            // own colours whatever the card's accent said.
            Icon(
                Icons.Rounded.Campaign,
                contentDescription = null,
                tint = accent,
                modifier = Modifier.size(16.dp),
            )
            Spacer(Modifier.width(7.dp))
            Text(
                embed.author?.name ?: "Announcement",
                style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.SemiBold),
                color = accent,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Spacer(Modifier.weight(1f))
            embed.timestamp?.let {
                Text(
                    shortTime(it),
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.textTertiary,
                    maxLines = 1,
                )
            }
        }

        Column(Modifier.padding(horizontal = 14.dp, vertical = 12.dp)) {
            embed.title?.let {
                Text(
                    it,
                    style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.SemiBold),
                    color = colors.textPrimary,
                )
                Spacer(Modifier.height(6.dp))
            }

            embed.description?.let {
                // No maxLines. See the note above: this is the whole point.
                Text(
                    it,
                    style = MaterialTheme.typography.bodyMedium,
                    color = colors.textSecondary,
                )
            }

            embed.footer?.let {
                Spacer(Modifier.height(10.dp))
                Text(
                    it.text,
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.textTertiary,
                )
            }
        }
    }
}

/** "2:37 AM" from an ISO timestamp, or nothing if it will not parse. */
private fun shortTime(iso: String): String =
    runCatching {
        java.time.format.DateTimeFormatter
            .ofPattern("h:mm a")
            .withZone(java.time.ZoneId.systemDefault())
            .format(java.time.Instant.parse(iso))
    }.getOrDefault("")
