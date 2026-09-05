package gg.yappy.app.ui.chat

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.video.FileOutputOptions
import androidx.camera.video.Quality
import androidx.camera.video.QualitySelector
import androidx.camera.video.Recorder
import androidx.camera.video.Recording
import androidx.camera.video.VideoCapture
import androidx.camera.video.VideoRecordEvent
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.ArrowUpward
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.PlayArrow
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.VideoSize
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import coil.compose.AsyncImage
import gg.yappy.app.data.Message
import gg.yappy.app.ui.components.softClickable
import gg.yappy.app.ui.theme.Neu
import gg.yappy.app.ui.theme.neuColors
import kotlinx.coroutines.delay
import java.io.File
import java.util.UUID

/**
 * A recorded round video note, told apart from a video *file* by the filename
 * its recorder stamps — the same marker every yappy client uses.
 */
fun Message.isVideoNote(): Boolean =
    type == "video" && attachments.firstOrNull()?.filename?.startsWith("video-note") == true

/** The name that marks one. Written here so both ends agree in one place. */
fun newVideoNoteFilename(): String = "video-note-${UUID.randomUUID()}.mp4"

// ── Recorder screen ──────────────────────────────────────────────────────────

/**
 * Full-screen video-note recording: a live circle, a timer, cancel and send.
 *
 * Recording starts the moment permission lands — the person tapped a camera
 * button to get here; a second "start" button would be ceremony.
 *
 * VGA on purpose: a video note is a face in a circle, and 640 pixels is already
 * more than the 200dp bubble will ever show. It also keeps a full-length note
 * to a few megabytes, which matters more than fidelity on the cellular link
 * most of these are sent over.
 */
@Composable
fun VideoNoteRecorderScreen(
    onSend: (File, Int) -> Unit,
    onDismiss: () -> Unit,
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val colors = neuColors

    var granted by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
                PackageManager.PERMISSION_GRANTED &&
                ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
                PackageManager.PERMISSION_GRANTED,
        )
    }
    var denied by remember { mutableStateOf(false) }
    var unavailable by remember { mutableStateOf(false) }
    var elapsedMs by remember { mutableStateOf(0L) }
    var recording by remember { mutableStateOf<Recording?>(null) }
    var target by remember { mutableStateOf<File?>(null) }
    /** Cancelled mid-recording: the finalize callback should discard the file. */
    var discard by remember { mutableStateOf(false) }

    val previewView = remember { PreviewView(context).apply { scaleType = PreviewView.ScaleType.FILL_CENTER } }

    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { result ->
        val ok = result[Manifest.permission.CAMERA] == true &&
            result[Manifest.permission.RECORD_AUDIO] == true
        granted = ok
        denied = !ok
    }

    LaunchedEffect(Unit) {
        if (!granted) {
            permissionLauncher.launch(
                arrayOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO),
            )
        }
    }

    // Bind the camera, then start rolling. Both halves are here because the
    // recording cannot begin until the use case is bound to a lifecycle.
    LaunchedEffect(granted) {
        if (!granted) return@LaunchedEffect

        val bound: VideoCapture<Recorder>? = runCatching {
            val provider = ProcessCameraProvider.getInstance(context).get()
            val preview = androidx.camera.core.Preview.Builder().build().also {
                it.setSurfaceProvider(previewView.surfaceProvider)
            }
            val recorder = Recorder.Builder()
                .setQualitySelector(QualitySelector.from(Quality.SD))
                .build()
            val videoCapture = VideoCapture.withOutput(recorder)

            provider.unbindAll()
            provider.bindToLifecycle(
                lifecycleOwner,
                CameraSelector.DEFAULT_FRONT_CAMERA,
                preview,
                videoCapture,
            )
            videoCapture
        }.getOrNull()

        if (bound == null) {
            unavailable = true
            return@LaunchedEffect
        }

        val file = File(context.cacheDir, newVideoNoteFilename())
        target = file
        val started = System.currentTimeMillis()

        recording = runCatching {
            bound.output
                .prepareRecording(context, FileOutputOptions.Builder(file).build())
                .withAudioEnabled()
                .start(ContextCompat.getMainExecutor(context)) { event ->
                    if (event is VideoRecordEvent.Finalize) {
                        val duration = (System.currentTimeMillis() - started).toInt()
                        if (discard || event.hasError() || duration < 500) {
                            file.delete()
                        } else {
                            onSend(file, duration)
                        }
                        onDismiss()
                    }
                }
        }.getOrNull()

        if (recording == null) {
            unavailable = true
            file.delete()
        }
    }

    LaunchedEffect(recording) {
        while (recording != null) {
            delay(100)
            elapsedMs += 100
            // A minute, like everyone else's video notes — past that it is a
            // video, and the library picker exists for those.
            if (elapsedMs >= 60_000) {
                recording?.stop()
                recording = null
            }
        }
    }

    /**
     * Give up on the note.
     *
     * Stopping a live recording finalises asynchronously, so the discard flag
     * is raised first and the Finalize callback does the deleting and the
     * dismissing; with nothing rolling there is no callback coming, and the
     * screen closes itself.
     */
    val cancel = {
        discard = true
        val active = recording
        recording = null
        if (active != null) {
            active.stop()
        } else {
            target?.delete()
            onDismiss()
        }
    }

    // Back is cancel. Without this it popped the whole chat, the camera was
    // unbound underneath a live recording, and Finalize — seeing no discard —
    // posted whatever half a note had been captured.
    BackHandler(onBack = cancel)

    DisposableEffect(Unit) {
        onDispose {
            // Leaving by any other door is a discard too: unbinding stops the
            // recording, and a Finalize that arrives after the screen has gone
            // must delete the file rather than send it.
            discard = true
            runCatching { ProcessCameraProvider.getInstance(context).get().unbindAll() }
        }
    }

    Box(Modifier.fillMaxSize().background(Color.Black)) {
        Column(
            Modifier.fillMaxSize().padding(vertical = 48.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.SpaceBetween,
        ) {
            Spacer(Modifier.size(1.dp))

            Box(contentAlignment = Alignment.Center) {
                AndroidView(
                    factory = { previewView },
                    modifier = Modifier.size(280.dp).clip(CircleShape),
                )

                if (denied || unavailable) {
                    Box(
                        Modifier.size(280.dp).clip(CircleShape).background(Color.White.copy(alpha = 0.08f)),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            if (denied) {
                                "Allow camera and microphone access to record a video note"
                            } else {
                                "No camera available on this device"
                            },
                            style = MaterialTheme.typography.bodyMedium,
                            color = Color.White.copy(alpha = 0.8f),
                            textAlign = TextAlign.Center,
                            modifier = Modifier.width(200.dp),
                        )
                    }
                }
            }

            Row(verticalAlignment = Alignment.CenterVertically) {
                if (recording != null) {
                    Box(Modifier.size(8.dp).clip(CircleShape).background(colors.danger))
                    Spacer(Modifier.width(8.dp))
                }
                Text(
                    "%d:%02d".format((elapsedMs / 1000) / 60, (elapsedMs / 1000) % 60),
                    style = MaterialTheme.typography.titleMedium,
                    color = Color.White,
                )
            }

            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.Center,
            ) {
                Box(
                    Modifier
                        .size(56.dp)
                        .clip(CircleShape)
                        .background(Color.White.copy(alpha = 0.15f))
                        .softClickable(onClick = cancel),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(Icons.Rounded.Close, "Cancel", tint = Color.White, modifier = Modifier.size(22.dp))
                }

                Spacer(Modifier.width(60.dp))

                Box(
                    Modifier
                        .size(68.dp)
                        .clip(CircleShape)
                        .background(if (recording != null) Color.White else Color.White.copy(alpha = 0.4f))
                        .softClickable(enabled = recording != null) {
                            val active = recording
                            recording = null
                            active?.stop()
                        },
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        Icons.Rounded.ArrowUpward,
                        "Send",
                        tint = Color.Black,
                        modifier = Modifier.size(26.dp),
                    )
                }
            }
        }
    }
}

// ── Bubble bodies ────────────────────────────────────────────────────────────

/** A video note in the timeline: a circle that plays in place when tapped. */
@Composable
fun VideoNoteBody(message: Message, mediaFactory: MediaFactory) {
    var playing by remember(message.id) { mutableStateOf(false) }
    // The player has actually put a frame on screen. Until then the poster
    // stays up — swapping to the player at tap time showed two seconds of
    // dark nothing while ExoPlayer buffered, which read as broken.
    var rendered by remember(message.id) { mutableStateOf(false) }
    val attachment = message.attachments.firstOrNull()

    Box(
        Modifier.size(200.dp).clip(CircleShape).background(Color.Black.copy(alpha = 0.85f)),
        contentAlignment = Alignment.Center,
    ) {
        if (playing && attachment?.url != null) {
            InlineVideo(
                url = attachment.url,
                mediaFactory = mediaFactory,
                loop = false,
                onFirstFrame = { rendered = true },
                onEnded = {
                    playing = false
                    rendered = false
                },
                modifier = Modifier.fillMaxSize(),
            )
        }
        if (!playing || !rendered) {
            // No server thumbnail for video yet, so the poster is a frame Coil
            // pulls from the file itself — the same trick the media wall uses.
            AsyncImage(
                model = attachment?.thumbnailUrl ?: attachment?.url,
                contentDescription = "Video note",
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize(),
            )
        }

        if (message.isPending) {
            Box(
                Modifier.size(44.dp).clip(CircleShape).background(Color.Black.copy(alpha = 0.45f)),
                contentAlignment = Alignment.Center,
            ) {
                CircularProgressIndicator(color = Color.White, strokeWidth = 2.dp, modifier = Modifier.size(22.dp))
            }
        } else if (!playing) {
            Box(
                Modifier
                    .size(44.dp)
                    .clip(CircleShape)
                    .background(Color.Black.copy(alpha = 0.45f))
                    .softClickable(enabled = attachment?.url != null) { playing = true },
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Rounded.PlayArrow, "Play", tint = Color.White, modifier = Modifier.size(24.dp))
            }
        }
    }
}

/**
 * A video *file*: poster with a play badge; tapping opens the full-screen
 * player. Video notes are drawn as circles instead — see [VideoNoteBody].
 */
@Composable
fun VideoBody(message: Message, isMine: Boolean, onOpen: () -> Unit) {
    val colors = neuColors
    val attachment = message.attachments.firstOrNull()
    val ratio = attachment
        ?.let { a -> a.width?.let { w -> a.height?.let { h -> if (h > 0) w.toFloat() / h else null } } }
        ?.coerceIn(0.6f, 1.8f)
        ?: 1.33f

    Column {
        Box(contentAlignment = Alignment.Center) {
            Box(
                Modifier
                    .size(width = 240.dp, height = (240f / ratio).dp)
                    .clip(androidx.compose.foundation.shape.RoundedCornerShape(Neu.CornerSmall))
                    .background(Color.Black.copy(alpha = 0.85f)),
            ) {
                AsyncImage(
                    model = attachment?.thumbnailUrl ?: attachment?.url,
                    contentDescription = attachment?.filename ?: "Video",
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.fillMaxSize(),
                )
            }

            Box(
                Modifier
                    .size(44.dp)
                    .clip(CircleShape)
                    .background(Color.Black.copy(alpha = 0.45f))
                    .softClickable(enabled = !message.isPending && attachment?.url != null, onClick = onOpen),
                contentAlignment = Alignment.Center,
            ) {
                if (message.isPending) {
                    CircularProgressIndicator(color = Color.White, strokeWidth = 2.dp, modifier = Modifier.size(22.dp))
                } else {
                    Icon(Icons.Rounded.PlayArrow, "Play", tint = Color.White, modifier = Modifier.size(24.dp))
                }
            }
        }

        if (!message.content.isNullOrBlank()) {
            Spacer(Modifier.size(6.dp))
            Text(
                message.content,
                style = MaterialTheme.typography.bodyMedium,
                color = if (isMine) colors.onOutgoing else colors.textPrimary,
            )
        }
    }
}

/**
 * ExoPlayer, playing in place.
 *
 * Deliberately per-bubble rather than shared: a note that scrolls away is
 * disposed with its composable, and two playing at once is prevented by the
 * audio focus the player takes.
 */
@androidx.annotation.OptIn(UnstableApi::class)
@Composable
fun InlineVideo(
    url: String,
    mediaFactory: MediaFactory,
    modifier: Modifier = Modifier,
    loop: Boolean = false,
    autoPlay: Boolean = true,
    showControls: Boolean = false,
    /** The first real frame is on screen — safe to drop any poster over this. */
    onFirstFrame: () -> Unit = {},
    onEnded: () -> Unit = {},
) {
    val context = LocalContext.current
    val player = remember(url) { mediaFactory.player(context) }

    DisposableEffect(url) {
        player.setMediaItem(MediaItem.fromUri(url))
        player.repeatMode = if (loop) Player.REPEAT_MODE_ONE else Player.REPEAT_MODE_OFF
        player.prepare()
        player.playWhenReady = autoPlay

        val listener = object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                if (state == Player.STATE_ENDED) onEnded()
            }

            override fun onRenderedFirstFrame() {
                onFirstFrame()
            }
        }
        player.addListener(listener)

        onDispose {
            player.removeListener(listener)
            player.release()
        }
    }

    AndroidView(
        factory = { ctx ->
            if (showControls) {
                // The full-screen player: unclipped on a black page, where a
                // SurfaceView is correct and the built-in controller earns
                // its keep.
                PlayerView(ctx).apply {
                    useController = true
                    // Fit, not zoom: this is a player, and a landscape clip
                    // cropped to a portrait phone loses both ends of the
                    // picture. Zoom stays for the note's circle, where
                    // filling the shape is the point.
                    resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT
                    setShutterBackgroundColor(android.graphics.Color.TRANSPARENT)
                    this.player = player
                }
            } else {
                /**
                 * A TextureView, deliberately not PlayerView. PlayerView's
                 * SurfaceView punches its own hole in the window and ignores
                 * Compose clipping entirely — inside the video note's circle
                 * it composited as a black disc while the audio played
                 * underneath. A TextureView is drawn like any other view, so
                 * the clip holds; the frame around it re-crops to the video's
                 * real aspect once the decoder reports it.
                 */
                AspectRatioFrameLayout(ctx).apply {
                    resizeMode = AspectRatioFrameLayout.RESIZE_MODE_ZOOM
                    val texture = android.view.TextureView(ctx)
                    addView(texture)
                    player.setVideoTextureView(texture)
                    player.addListener(object : Player.Listener {
                        override fun onVideoSizeChanged(size: VideoSize) {
                            if (size.height == 0) return
                            setAspectRatio(size.width * size.pixelWidthHeightRatio / size.height)
                        }
                    })
                }
            }
        },
        modifier = modifier,
    )
}

/**
 * Builds players that can read private attachments.
 *
 * The API serves message media only to members of the conversation it was
 * posted in, so every request needs the bearer token. A bare `MediaItem` URI
 * gets a 401 and a black frame; routing the data source through the app's own
 * authorised OkHttp client is the whole reason this exists rather than an
 * `ExoPlayer.Builder(context)` at each call site.
 */
class MediaFactory(
    private val http: okhttp3.OkHttpClient,
    private val tokenProvider: () -> String?,
    private val apiHosts: Set<String>,
) {

    @androidx.annotation.OptIn(UnstableApi::class)
    fun player(context: Context): ExoPlayer {
        val dataSource = androidx.media3.datasource.okhttp.OkHttpDataSource.Factory(http)

        return ExoPlayer.Builder(context)
            .setMediaSourceFactory(
                androidx.media3.exoplayer.source.DefaultMediaSourceFactory(
                    androidx.media3.datasource.ResolvingDataSource.Factory(dataSource) { spec ->
                        val host = spec.uri.host
                        val token = tokenProvider()
                        if (host != null && host in apiHosts && token != null) {
                            spec.withRequestHeaders(mapOf("Authorization" to "Bearer $token"))
                        } else {
                            spec
                        }
                    },
                ),
            )
            .build()
    }
}
