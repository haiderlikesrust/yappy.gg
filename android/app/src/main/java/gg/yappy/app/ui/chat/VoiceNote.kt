package gg.yappy.app.ui.chat

import android.content.Context
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.os.Build
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Pause
import androidx.compose.material.icons.rounded.PlayArrow
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.unit.dp
import gg.yappy.app.data.Message
import gg.yappy.app.ui.components.softClickable
import gg.yappy.app.ui.theme.neuColors
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import java.io.File
import java.util.UUID
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

// ── Recording ────────────────────────────────────────────────────────────────

/** A finished recording, ready to send. */
data class RecordedVoice(
    val bytes: ByteArray,
    val durationMs: Int,
    /** Amplitude samples, 0–100, for the bubble to draw before the server has
     *  generated its own. */
    val waveform: List<Int>,
) {
    // ByteArray in a data class means the generated equals compares references,
    // which is wrong in a way that bites silently. The id-like fields are what
    // actually distinguish two recordings.
    override fun equals(other: Any?): Boolean =
        other is RecordedVoice && other.durationMs == durationMs && other.bytes.contentEquals(bytes)

    override fun hashCode(): Int = 31 * durationMs + bytes.contentHashCode()
}

/**
 * Records a voice note as AAC in an .m4a container.
 *
 * AAC mono at 32 kbps, because a voice note is speech: a minute costs about a
 * quarter of a megabyte, which uploads fast on cellular and is transparent for
 * a voice. The server's accept list has `audio/mp4` at up to 50 MB, so the
 * format needs no server work at all.
 */
class VoiceRecorder(private val context: Context) {

    private val _recording = MutableStateFlow(false)
    val recording: StateFlow<Boolean> = _recording.asStateFlow()

    private val _elapsedMs = MutableStateFlow(0L)
    val elapsedMs: StateFlow<Long> = _elapsedMs.asStateFlow()

    /** Live level, 0–1, so the composer can pulse while someone talks. */
    private val _level = MutableStateFlow(0f)
    val level: StateFlow<Float> = _level.asStateFlow()

    private var recorder: MediaRecorder? = null
    private var file: File? = null
    private var ticker: Job? = null
    private var startedAt = 0L

    /** Sampled while recording, so the sent bubble has a real shape from the
     *  first frame rather than the placeholder one derived from its id. */
    private val amplitudes = mutableListOf<Int>()

    fun start(scope: CoroutineScope): Boolean {
        if (_recording.value) return true

        val target = File(context.cacheDir, "voice-${UUID.randomUUID()}.m4a")
        val created = runCatching {
            @Suppress("DEPRECATION")
            val instance = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                MediaRecorder(context)
            } else {
                MediaRecorder()
            }
            instance.apply {
                setAudioSource(MediaRecorder.AudioSource.MIC)
                setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
                setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
                setAudioChannels(1)
                setAudioSamplingRate(24_000)
                setAudioEncodingBitRate(32_000)
                setOutputFile(target.absolutePath)
                prepare()
                start()
            }
        }.getOrNull() ?: run {
            target.delete()
            return false
        }

        recorder = created
        file = target
        startedAt = System.currentTimeMillis()
        amplitudes.clear()
        _recording.value = true
        _elapsedMs.value = 0

        ticker = scope.launch {
            while (_recording.value) {
                delay(100)
                val elapsed = System.currentTimeMillis() - startedAt
                _elapsedMs.value = elapsed

                // 0–32767 from the OS; the ear is closer to logarithmic than
                // the meter is, but a linear scale is honest enough for bars a
                // centimetre tall.
                val amplitude = runCatching { created.maxAmplitude }.getOrDefault(0)
                val normalised = (amplitude / 32_767f).coerceIn(0f, 1f)
                _level.value = normalised
                // One sample every other tick: 34 bars is what the bubble draws,
                // and ten minutes at 5/s would be three thousand.
                if (amplitudes.size < 240) amplitudes.add((normalised * 100).toInt())

                // A cap keeps a pocket recording from becoming a 50 MB upload;
                // ten minutes of speech is a podcast, not a message.
                if (elapsed >= 600_000) break
            }
        }
        return true
    }

    /**
     * Stop and hand back the bytes, or null when there is nothing worth
     * sending — recordings under half a second are always a slipped finger.
     */
    suspend fun finish(): RecordedVoice? = withContext(Dispatchers.IO) {
        val target = file
        val duration = System.currentTimeMillis() - startedAt
        val samples = amplitudes.toList()
        teardown()

        if (target == null) return@withContext null
        try {
            if (duration < 500) return@withContext null
            val bytes = runCatching { target.readBytes() }.getOrNull() ?: return@withContext null
            if (bytes.isEmpty()) return@withContext null
            RecordedVoice(bytes, duration.toInt(), downsample(samples, 34))
        } finally {
            target.delete()
        }
    }

    fun cancel() {
        val target = file
        teardown()
        target?.delete()
    }

    private fun teardown() {
        ticker?.cancel()
        ticker = null
        _recording.value = false
        _elapsedMs.value = 0
        _level.value = 0f
        runCatching {
            recorder?.stop()
        }
        runCatching { recorder?.release() }
        recorder = null
        file = null
    }

    /** Squeeze however many samples were taken into the bars the bubble draws. */
    private fun downsample(samples: List<Int>, buckets: Int): List<Int> {
        if (samples.isEmpty()) return emptyList()
        if (samples.size <= buckets) return samples
        val perBucket = samples.size.toFloat() / buckets
        return (0 until buckets).map { index ->
            val from = (index * perBucket).toInt()
            val to = min(((index + 1) * perBucket).toInt(), samples.size)
            if (to <= from) samples[from] else samples.subList(from, to).average().toInt()
        }
    }
}

// ── Playback ─────────────────────────────────────────────────────────────────

/**
 * One shared player, because two voice notes talking over each other is never
 * what anyone wants — starting one stops the other, WhatsApp-style.
 *
 * Fetch-then-play rather than streaming. Message attachments are private and
 * need the bearer token, and `MediaPlayer.setDataSource(Context, Uri, headers)`
 * is unreliable across OEM builds — the request 401s and the item dies with no
 * error while the button sits on "pause" and nothing plays. A voice note is a
 * few hundred kilobytes; downloading it through the same authorised OkHttp
 * client everything else uses is both reliable and gives a duration
 * synchronously for the scrubber.
 */
class VoiceNotePlayer(
    private val context: Context,
    private val scope: CoroutineScope,
    private val http: okhttp3.OkHttpClient,
    private val tokenProvider: suspend () -> String?,
    private val apiHosts: Set<String>,
) {

    private val _playingId = MutableStateFlow<String?>(null)

    /** Attachment id currently playing, or null. */
    val playingId: StateFlow<String?> = _playingId.asStateFlow()

    private val _loadingId = MutableStateFlow<String?>(null)
    val loadingId: StateFlow<String?> = _loadingId.asStateFlow()

    private val _progress = MutableStateFlow(0f)
    val progress: StateFlow<Float> = _progress.asStateFlow()

    private var player: MediaPlayer? = null
    private var ticker: Job? = null
    private var fetch: Job? = null
    private var localFile: File? = null

    fun toggle(id: String, url: String) {
        if (_playingId.value == id || _loadingId.value == id) {
            stop()
            return
        }
        stop()
        _loadingId.value = id

        fetch = scope.launch {
            val file = download(url)
            if (file == null || _loadingId.value != id) {
                if (_loadingId.value == id) _loadingId.value = null
                return@launch
            }
            play(id, file)
        }
    }

    private suspend fun download(url: String): File? = withContext(Dispatchers.IO) {
        runCatching {
            // A note that is still uploading plays from its local copy.
            if (url.startsWith("file://") || url.startsWith("/")) {
                return@runCatching File(url.removePrefix("file://"))
            }

            val builder = okhttp3.Request.Builder().url(url)
            // The token goes only to our own hosts. Attaching it to a Tenor URL
            // or a bot's icon would hand the session to a third party.
            val host = url.toHttpUrlOrNull()?.host
            if (host != null && host in apiHosts) {
                tokenProvider()?.let { builder.header("Authorization", "Bearer $it") }
            }

            val target = File(context.cacheDir, "vn-${abs(url.hashCode())}.m4a")
            if (target.exists() && target.length() > 0) return@runCatching target

            http.newCall(builder.build()).execute().use { response ->
                if (!response.isSuccessful) return@runCatching null
                val body = response.body ?: return@runCatching null
                target.outputStream().use { out -> body.byteStream().copyTo(out) }
            }
            target
        }.getOrNull()
    }

    private fun play(id: String, file: File) {
        val created = runCatching {
            MediaPlayer().apply {
                setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build(),
                )
                setDataSource(file.absolutePath)
                prepare()
                start()
            }
        }.getOrNull()

        if (created == null) {
            _loadingId.value = null
            return
        }

        created.setOnCompletionListener { stop() }
        player = created
        localFile = file
        _loadingId.value = null
        _playingId.value = id
        _progress.value = 0f

        ticker = scope.launch {
            while (_playingId.value == id) {
                delay(100)
                val current = runCatching { created.currentPosition }.getOrDefault(0)
                val total = runCatching { created.duration }.getOrDefault(0)
                if (total > 0) _progress.value = (current.toFloat() / total).coerceIn(0f, 1f)
            }
        }
    }

    fun stop() {
        fetch?.cancel()
        fetch = null
        ticker?.cancel()
        ticker = null
        runCatching { player?.stop() }
        runCatching { player?.release() }
        player = null
        localFile = null
        _playingId.value = null
        _loadingId.value = null
        _progress.value = 0f
    }
}

// ── Bubble body ──────────────────────────────────────────────────────────────

/** A voice note: play control, waveform, duration. */
@Composable
fun VoiceNoteBody(
    message: Message,
    isMine: Boolean,
    player: VoiceNotePlayer,
) {
    val colors = neuColors
    val playingId by player.playingId.collectAsState()
    val loadingId by player.loadingId.collectAsState()
    val progress by player.progress.collectAsState()

    val attachment = message.attachments.firstOrNull()
    val playing = playingId == message.id
    val loading = loadingId == message.id
    val onColor = if (isMine) colors.onOutgoing else colors.textPrimary

    val bars = remember(message.id, attachment?.waveform) { barsFor(message) }

    Row(
        Modifier.width(210.dp).padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Box(
            Modifier
                .size(36.dp)
                .clip(CircleShape)
                .background(onColor)
                .softClickable(enabled = !message.isPending && attachment?.url != null) {
                    attachment?.url?.let { player.toggle(message.id, it) }
                },
            contentAlignment = Alignment.Center,
        ) {
            if (loading) {
                CircularProgressIndicator(
                    color = if (isMine) colors.outgoing else colors.onAccent,
                    strokeWidth = 2.dp,
                    modifier = Modifier.size(18.dp),
                )
            } else {
                Icon(
                    if (playing) Icons.Rounded.Pause else Icons.Rounded.PlayArrow,
                    contentDescription = if (playing) "Pause" else "Play",
                    tint = if (isMine) colors.outgoing else colors.onAccent,
                    modifier = Modifier.size(20.dp),
                )
            }
        }

        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
            Waveform(
                bars = bars,
                progress = if (playing) progress else 0f,
                color = onColor,
                modifier = Modifier.fillMaxWidth().height(26.dp),
            )
            Text(
                durationLabel(message),
                style = MaterialTheme.typography.labelSmall,
                color = onColor.copy(alpha = 0.7f),
            )
        }

        if (message.isPending) {
            CircularProgressIndicator(
                color = onColor,
                strokeWidth = 2.dp,
                modifier = Modifier.size(16.dp),
            )
        }
    }
}

/**
 * Real amplitudes when they exist; otherwise a stable set of bars derived from
 * the message id — the same note always draws the same shape, and it never
 * reshuffles on a redraw.
 */
private fun barsFor(message: Message): List<Float> {
    val waveform = message.attachments.firstOrNull()?.waveform
    if (!waveform.isNullOrEmpty()) {
        val peak = waveform.maxOrNull()?.toFloat() ?: 1f
        return waveform.map { if (peak > 0f) (it / peak).coerceIn(0.08f, 1f) else 0.2f }
    }

    var seed = (message.id.hashCode().toLong() or 1L)
    return (0 until 34).map {
        seed = seed * 6_364_136_223_846_793_005L + 1_442_695_040_888_963_407L
        0.25f + ((seed ushr 40) and 0xFF).toFloat() / 255f * 0.75f
    }
}

private fun durationLabel(message: Message): String {
    val ms = message.attachments.firstOrNull()?.durationMs ?: 0
    val seconds = max(ms / 1000, 1)
    return "%d:%02d".format(seconds / 60, seconds % 60)
}

/**
 * The bars. Those up to the play head take the full colour; the rest are
 * dimmed, so the fill reads as progress the same way a scrubber would.
 */
@Composable
private fun Waveform(
    bars: List<Float>,
    progress: Float,
    color: Color,
    modifier: Modifier = Modifier,
) {
    Canvas(modifier.fillMaxSize()) {
        if (bars.isEmpty()) return@Canvas

        val spacing = 2.dp.toPx()
        val barWidth = max((size.width - spacing * (bars.size - 1)) / bars.size, 1f)
        val played = (progress * bars.size).toInt()

        bars.forEachIndexed { index, fraction ->
            val height = max(size.height * fraction, 3f)
            val x = index * (barWidth + spacing) + barWidth / 2
            drawLine(
                color = color.copy(alpha = if (index < played) 1f else 0.3f),
                start = Offset(x, (size.height - height) / 2),
                end = Offset(x, (size.height + height) / 2),
                strokeWidth = barWidth,
                cap = StrokeCap.Round,
            )
        }
    }
}
