package gg.yappy.app.ui.media

import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Download
import androidx.compose.material.icons.rounded.Share
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.FileProvider
import coil.compose.AsyncImage
import gg.yappy.app.AppContainer
import gg.yappy.app.BuildConfig
import gg.yappy.app.LocalContainer
import gg.yappy.app.ui.components.softClickable
import java.io.File
import java.io.OutputStream
import kotlin.math.abs
import kotlin.math.roundToInt
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Request

private enum class SaveState { Idle, Saving, Saved }

/** A display name the gallery and the share sheet can both live with. */
private fun ViewerItem.safeName(): String =
    filename?.substringAfterLast('/')?.takeIf { it.isNotBlank() }
        ?: "yappy-${System.currentTimeMillis()}.jpg"

private fun mimeFor(name: String): String = when (name.substringAfterLast('.', "").lowercase()) {
    "png" -> "image/png"
    "gif" -> "image/gif"
    "webp" -> "image/webp"
    else -> "image/jpeg"
}

/**
 * Pull the bytes through the app's own client.
 *
 * Attachments live in a private bucket behind an authorised route, so a bare
 * `java.net.URL` got a 401 and a zero-byte "photo". This mirrors what the Coil
 * loader does for every image on screen: the API's OkHttp client (shared pool,
 * shared timeouts), the in-memory token — never a DataStore read on a network
 * thread — and the header only for our own hosts, so a Tenor GIF or a bot's
 * icon never sees the session.
 */
private fun fetchTo(container: AppContainer, url: String, output: OutputStream): Boolean {
    val parsed = url.toHttpUrlOrNull() ?: return false
    val apiHosts = listOfNotNull(
        BuildConfig.API_URL.toHttpUrlOrNull()?.host,
        BuildConfig.API_URL_ALT.takeIf { it.isNotBlank() }?.toHttpUrlOrNull()?.host,
    )
    val ours = parsed.host in apiHosts
    // The server names itself "localhost"; from inside the emulator that is a
    // different machine entirely. Same rewrite the image loader applies.
    val target = if (BuildConfig.DEBUG && (parsed.host == "localhost" || parsed.host == "127.0.0.1")) {
        parsed.newBuilder().host("10.0.2.2").build()
    } else {
        parsed
    }
    val request = Request.Builder().url(target).apply {
        if (ours) container.session.cachedAccess?.let { header("Authorization", "Bearer $it") }
    }.build()
    container.api.http.newCall(request).execute().use { response ->
        if (!response.isSuccessful) return false
        val body = response.body ?: return false
        body.byteStream().use { input -> input.copyTo(output) }
    }
    return true
}

/**
 * Download the bytes and register them with MediaStore under Pictures/yappy.
 * API 29+ only (checked by the caller): scoped storage means no permission,
 * and IS_PENDING keeps half-written files out of the gallery.
 */
private suspend fun saveToGallery(
    context: Context,
    container: AppContainer,
    item: ViewerItem,
): Boolean = withContext(Dispatchers.IO) {
    runCatching {
        val name = item.safeName()
        val values = android.content.ContentValues().apply {
            put(android.provider.MediaStore.Images.Media.DISPLAY_NAME, name)
            put(android.provider.MediaStore.Images.Media.MIME_TYPE, mimeFor(name))
            put(android.provider.MediaStore.Images.Media.RELATIVE_PATH, "Pictures/yappy")
            put(android.provider.MediaStore.Images.Media.IS_PENDING, 1)
        }
        val resolver = context.contentResolver
        val uri = resolver.insert(
            android.provider.MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
            values,
        ) ?: return@runCatching false

        val ok = resolver.openOutputStream(uri)?.use { output -> fetchTo(container, item.url, output) }
            ?: false
        if (!ok) {
            // Never leave a pending, empty row behind: it would sit in the
            // gallery's database as a photo that never appears.
            resolver.delete(uri, null, null)
            return@runCatching false
        }
        values.clear()
        values.put(android.provider.MediaStore.Images.Media.IS_PENDING, 0)
        resolver.update(uri, values, null, null)
        true
    }.getOrDefault(false)
}

/**
 * Stage a copy under `cache/shared/` and hand out a content URI for it.
 *
 * Sharing the *bytes* rather than the link: the link only resolves for a
 * signed-in member, so pasted into another app it was a URL that opened to a
 * 401 for everyone it was sent to. The FileProvider authority is
 * `<applicationId>.files` with `shared/` as its cache path; if the provider is
 * not declared this returns null and the caller falls back to the link.
 */
private suspend fun stageForShare(
    context: Context,
    container: AppContainer,
    item: ViewerItem,
): Uri? = withContext(Dispatchers.IO) {
    runCatching {
        val dir = File(context.cacheDir, "shared").apply { mkdirs() }
        val file = File(dir, item.safeName())
        val ok = file.outputStream().use { output -> fetchTo(container, item.url, output) }
        if (!ok) {
            file.delete()
            return@runCatching null
        }
        FileProvider.getUriForFile(context, "${context.packageName}.files", file)
    }.getOrNull()
}

/**
 * One image in the viewer, plus the context needed to caption and share it.
 *
 * A plain data class rather than passing `Message` around: the viewer opens
 * from the timeline *and* from the media wall, and those carry different
 * shapes. Flattening at the call site keeps the viewer from knowing about
 * either.
 */
data class ViewerItem(
    val url: String,
    val caption: String? = null,
    val senderName: String? = null,
    val filename: String? = null,
)

/**
 * Full-screen media.
 *
 * A `Dialog` rather than a nav destination on purpose: it opens from the
 * timeline, the media wall and (later) profiles, and routing it would mean
 * every one of those needing a route argument big enough to carry a list of
 * images. As an overlay it composes over whatever is already on screen and the
 * back stack is untouched.
 *
 * Gestures follow what every photo viewer does, because this is the one place
 * where being unsurprising beats being distinctive:
 *   · pinch to zoom, drag to pan while zoomed
 *   · double-tap toggles 1× and 2.5×
 *   · drag down at 1× dismisses, with the background fading as you go
 */
@Composable
fun MediaViewer(
    items: List<ViewerItem>,
    initialIndex: Int,
    onDismiss: () -> Unit,
) {
    if (items.isEmpty()) return
    val context = LocalContext.current
    val container = LocalContainer.current
    val scope = rememberCoroutineScope()

    val pagerState = rememberPagerState(
        initialPage = initialIndex.coerceIn(0, items.lastIndex),
        pageCount = { items.size },
    )

    // How far the current page has been dragged down, in pixels. Drives both
    // the dismiss threshold and the scrim's opacity, so the gesture explains
    // itself as it happens.
    var dragY by remember { mutableFloatStateOf(0f) }
    val dismissProgress = (abs(dragY) / 600f).coerceIn(0f, 1f)

    // Hoisted out of the image so the pager can stand down while one is zoomed.
    var zoomed by remember { mutableStateOf(false) }

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(
            usePlatformDefaultWidth = false,
            dismissOnClickOutside = false,
            // Without this the dialog window is inset from the system bars, so
            // the black fill stops short *and* the insets padding below adds a
            // second gap that pushes the caption off screen. A full-screen
            // viewer has to own the whole display and do its own insetting.
            decorFitsSystemWindows = false,
        ),
    ) {
        Box(
            Modifier
                .fillMaxSize()
                .background(Color.Black.copy(alpha = 1f - dismissProgress * 0.7f)),
        ) {
            HorizontalPager(
                state = pagerState,
                // Paging is disabled while an image is zoomed in, otherwise
                // panning left on a zoomed photo flips to the next one.
                userScrollEnabled = !zoomed,
                modifier = Modifier.fillMaxSize(),
            ) { page ->
                ZoomableImage(
                    url = items[page].url,
                    contentDescription = items[page].filename,
                    onDragged = { dragY = it },
                    onZoomChanged = { zoomed = it },
                    onDismiss = onDismiss,
                )
            }

            // ── Chrome ───────────────────────────────────────────────────────
            Row(
                Modifier
                    .fillMaxWidth()
                    // Same reasoning as the caption's bottom padding.
                    .statusBarsPadding()
                    .padding(start = 12.dp, end = 12.dp, top = 34.dp, bottom = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                ViewerButton(Icons.Rounded.Close, "Close", onClick = onDismiss)
                Spacer(Modifier.weight(1f))
                if (items.size > 1) {
                    Text(
                        "${pagerState.currentPage + 1} / ${items.size}",
                        style = MaterialTheme.typography.labelLarge,
                        color = Color.White.copy(alpha = 0.85f),
                    )
                    Spacer(Modifier.weight(1f))
                }
                var sharing by remember { mutableStateOf(false) }
                ViewerButton(Icons.Rounded.Share, "Share", busy = sharing) {
                    if (sharing) return@ViewerButton
                    val item = items[pagerState.currentPage]
                    sharing = true
                    scope.launch {
                        val staged = stageForShare(context, container, item)
                        sharing = false
                        val send = Intent(Intent.ACTION_SEND).apply {
                            if (staged != null) {
                                type = mimeFor(item.safeName())
                                putExtra(Intent.EXTRA_STREAM, staged)
                                // ClipData is what actually carries the grant
                                // to the chooser's target on modern Android;
                                // the flag alone is honoured only for the
                                // intent's own data URI.
                                clipData = ClipData.newRawUri(null, staged)
                                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                            } else {
                                // Could not stage the bytes (offline, or no
                                // provider): the link is still the honest
                                // fallback — it resolves for anyone who may
                                // see the photo.
                                type = "text/plain"
                                putExtra(Intent.EXTRA_TEXT, item.url)
                            }
                        }
                        context.startActivity(Intent.createChooser(send, "Share"))
                    }
                }
                Spacer(Modifier.width(8.dp))
                var saveState by remember { mutableStateOf(SaveState.Idle) }
                ViewerButton(
                    when (saveState) {
                        SaveState.Saved -> Icons.Rounded.Check
                        else -> Icons.Rounded.Download
                    },
                    "Save",
                    busy = saveState == SaveState.Saving,
                ) {
                    if (saveState == SaveState.Saving) return@ViewerButton
                    val item = items[pagerState.currentPage]
                    if (android.os.Build.VERSION.SDK_INT >= 29) {
                        // A real save: the bytes land in Pictures/yappy via
                        // MediaStore, no permission needed on 10+. Below 10
                        // that path wants WRITE_EXTERNAL_STORAGE, which is not
                        // worth carrying for a shrinking sliver of devices —
                        // they get the old view-in-browser behaviour.
                        saveState = SaveState.Saving
                        scope.launch {
                            val ok = saveToGallery(context, container, item)
                            saveState = if (ok) SaveState.Saved else SaveState.Idle
                            if (!ok) {
                                android.widget.Toast
                                    .makeText(context, "Couldn't save that", android.widget.Toast.LENGTH_SHORT)
                                    .show()
                            }
                        }
                    } else {
                        context.startActivity(
                            Intent(Intent.ACTION_VIEW, android.net.Uri.parse(item.url)),
                        )
                    }
                }
            }

            // ── Caption ──────────────────────────────────────────────────────
            val current = items.getOrNull(pagerState.currentPage)
            val caption = current?.caption?.takeIf { it.isNotBlank() }
            if (caption != null || current?.senderName != null) {
                Column(
                    Modifier
                        .align(Alignment.BottomStart)
                        .fillMaxWidth()
                        .background(Color.Black.copy(alpha = 0.45f))
                        // A Dialog is its own window and does not reliably
                        // receive the activity's insets, so `navigationBarsPadding`
                        // can resolve to zero here and drop the caption behind
                        // the gesture bar. The fixed floor is the belt: it is
                        // roughly a gesture bar's height, and on a device that
                        // does dispatch insets the two simply add to a slightly
                        // roomier caption rather than a broken one.
                        .navigationBarsPadding()
                        .padding(start = 18.dp, end = 18.dp, top = 14.dp, bottom = 30.dp),
                    verticalArrangement = Arrangement.spacedBy(3.dp),
                ) {
                    current?.senderName?.let {
                        Text(
                            it,
                            style = MaterialTheme.typography.labelMedium,
                            color = Color.White.copy(alpha = 0.7f),
                        )
                    }
                    caption?.let {
                        Text(
                            it,
                            style = MaterialTheme.typography.bodyLarge,
                            color = Color.White,
                            maxLines = 4,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
        }
    }
}

/**
 * The 40dp disc is the picture; the 48dp box around it is the target. Over a
 * photo the chrome should stay small, but the thumb landing on it should not
 * have to be precise.
 */
@Composable
private fun ViewerButton(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    /** A download in flight: dimmed so a second tap reads as "wait", not "broken". */
    busy: Boolean = false,
    onClick: () -> Unit,
) {
    Box(
        Modifier
            .size(48.dp)
            .semantics { role = Role.Button }
            .softClickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Box(
            Modifier
                .size(40.dp)
                .clip(CircleShape)
                .background(Color.White.copy(alpha = 0.14f))
                .alpha(if (busy) 0.5f else 1f),
            contentAlignment = Alignment.Center,
        ) {
            Icon(icon, label, tint = Color.White, modifier = Modifier.size(20.dp))
        }
    }
}

@Composable
private fun ZoomableImage(
    url: String,
    contentDescription: String?,
    onDragged: (Float) -> Unit,
    onZoomChanged: (Boolean) -> Unit,
    onDismiss: () -> Unit,
) {
    var scale by remember { mutableFloatStateOf(1f) }
    var offsetX by remember { mutableFloatStateOf(0f) }
    var offsetY by remember { mutableFloatStateOf(0f) }
    var dragY by remember { mutableFloatStateOf(0f) }

    // Snapping back is animated so a released pinch settles rather than jumps.
    val animatedScale by animateFloatAsState(scale, label = "zoom")

    Box(
        Modifier
            .fillMaxSize()
            .pointerInput(url) {
                detectTapGestures(
                    onDoubleTap = { tap ->
                        if (scale > 1f) {
                            scale = 1f
                            offsetX = 0f
                            offsetY = 0f
                        } else {
                            scale = 2.5f
                            // Zoom toward the tapped point rather than the
                            // centre, so double-tapping a face centres a face.
                            offsetX = (size.width / 2f - tap.x) * 1.5f
                            offsetY = (size.height / 2f - tap.y) * 1.5f
                        }
                        onZoomChanged(scale > 1f)
                    },
                )
            }
            /**
             * Written with `awaitEachGesture` rather than
             * `detectTransformGestures` because that helper consumes every
             * event it sees — which silently swallows the horizontal drag the
             * pager needs, leaving a photo viewer you cannot swipe through.
             *
             * So consumption is deliberate here: only when this gesture is
             * actually a pinch, a pan on an already-zoomed image, or a vertical
             * drag to dismiss. A plain horizontal drag at 1× is left alone and
             * reaches the pager.
             */
            .pointerInput(url) {
                awaitEachGesture {
                    awaitFirstDown(requireUnconsumed = false)
                    var totalX = 0f
                    var totalY = 0f
                    // Decided once per gesture: flipping mid-drag between
                    // "dismissing" and "paging" feels broken.
                    var claimedVertical = false

                    do {
                        val event = awaitPointerEvent()
                        if (event.changes.any { it.isConsumed } && scale <= 1f && !claimedVertical) break

                        val zoomChange = event.calculateZoom()
                        val pan = event.calculatePan()
                        val pinching = event.changes.count { it.pressed } > 1

                        totalX += pan.x
                        totalY += pan.y

                        when {
                            pinching || scale > 1f -> {
                                val next = (scale * zoomChange).coerceIn(1f, 5f)
                                scale = next
                                if (next > 1f) {
                                    // Clamped to the scaled image's bounds, so
                                    // the picture cannot be dragged off into
                                    // empty space.
                                    val maxX = (size.width * (next - 1)) / 2f
                                    val maxY = (size.height * (next - 1)) / 2f
                                    offsetX = (offsetX + pan.x).coerceIn(-maxX, maxX)
                                    offsetY = (offsetY + pan.y).coerceIn(-maxY, maxY)
                                } else {
                                    offsetX = 0f
                                    offsetY = 0f
                                }
                                onZoomChanged(scale > 1f)
                                event.changes.forEach { it.consume() }
                            }

                            // At 1×, a decisively vertical drag means "put this
                            // away". Anything else belongs to the pager.
                            claimedVertical || abs(totalY) > abs(totalX) * 1.5f && abs(totalY) > 24f -> {
                                claimedVertical = true
                                dragY += pan.y
                                onDragged(dragY)
                                event.changes.forEach { it.consume() }
                                if (dragY > 220f) {
                                    onDismiss()
                                    return@awaitEachGesture
                                }
                            }
                        }
                    } while (event.changes.any { it.pressed })

                    // Released without committing: settle back.
                    if (claimedVertical) {
                        dragY = 0f
                        onDragged(0f)
                    }
                }
            },
        contentAlignment = Alignment.Center,
    ) {
        AsyncImage(
            model = url,
            contentDescription = contentDescription,
            contentScale = ContentScale.Fit,
            modifier = Modifier
                .fillMaxSize()
                .graphicsLayer(
                    scaleX = animatedScale,
                    scaleY = animatedScale,
                    translationX = offsetX,
                    translationY = if (scale > 1f) offsetY else dragY,
                ),
        )
    }
}

/** Reset the drag when a page settles, so a half-swipe does not persist. */
internal fun clampDrag(value: Float): Int = value.roundToInt()
