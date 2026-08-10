package gg.yappy.app.ui.settings

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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.AutoAwesome
import androidx.compose.material.icons.rounded.BugReport
import androidx.compose.material.icons.rounded.Bolt
import androidx.compose.material.icons.rounded.Brush
import androidx.compose.material.icons.rounded.Call
import androidx.compose.material.icons.rounded.Chat
import androidx.compose.material.icons.rounded.Lock
import androidx.compose.material.icons.rounded.Notifications
import androidx.compose.material.icons.rounded.Speed
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush as GfxBrush
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import gg.yappy.app.data.ReleaseNote
import gg.yappy.app.data.ReleaseNoteItem
import gg.yappy.app.data.ReleaseNoteSection
import gg.yappy.app.data.SessionStore
import gg.yappy.app.data.YappyRepository
import gg.yappy.app.ui.components.LogoMark
import gg.yappy.app.ui.components.NeuButton
import gg.yappy.app.ui.theme.Neu
import gg.yappy.app.ui.theme.neuColors
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * Release notes.
 *
 * The hard part of a What's New screen is not drawing it, it is deciding when
 * *not* to show it. [WhatsNewGate] owns that decision and nothing else does —
 * see the rules on [WhatsNewGate.check].
 */
class WhatsNewGate(
    private val store: SessionStore,
    private val repo: YappyRepository,
) {

    /** Non-empty when there is something to show and the moment is right. */
    var pending: List<ReleaseNote> = emptyList()
        private set

    private var checked = false

    /**
     * Rules, in order:
     *
     * 1. Once per launch, never on a timer.
     * 2. A fresh install records where it came in and shows nothing — nothing
     *    is "new" to someone who has never seen the old version.
     * 3. Only notes newer than the last one shown, which the server decides.
     * 4. Marked seen the moment it is dismissed, so a crash mid-read means it
     *    comes back rather than being lost.
     *
     * Rule 2 is the subtle one. "No marker" does not mean "new here": it is
     * also what every upgrader looks like on the first run of the build that
     * *introduced* the marker, and treating those as fresh installs swallows
     * the notes for exactly the audience they were written for. A session that
     * already existed when the process started is the tell.
     */
    suspend fun check(): List<ReleaseNote> {
        if (checked) return pending
        checked = true

        val seen = store.seenRelease()
        val feed = runCatching { repo.changelog(since = seen) }.getOrNull() ?: return emptyList()

        if (seen == null && !store.hadSessionAtLaunch) {
            // Genuinely new here. Record where they came in, show nothing.
            feed.latestId?.let { store.setSeenRelease(it) }
            return emptyList()
        }

        // An upgrader with no marker gets the newest note only. The whole back
        // catalogue would be a wall of text about releases they lived through.
        pending = if (seen == null) feed.notes.take(1) else feed.notes
        return pending
    }

    /** Called on dismiss, and by the Settings entry, which must not re-arm it. */
    suspend fun markSeen() {
        pending.firstOrNull()?.id?.let { store.setSeenRelease(it) }
        pending = emptyList()
    }
}

/**
 * The server names icons as SF Symbols, since iOS was the first client to draw
 * these. Rather than add a second field to the wire format for one platform,
 * Android maps the small generic set the notes actually use and draws nothing
 * for anything it does not recognise.
 */
fun releaseIcon(name: String?): ImageVector? = when (name) {
    "sparkles", "wand.and.stars" -> Icons.Rounded.AutoAwesome
    "bolt", "bolt.fill" -> Icons.Rounded.Bolt
    "paintbrush", "paintpalette" -> Icons.Rounded.Brush
    "phone", "phone.fill", "video" -> Icons.Rounded.Call
    "bubble.left", "message" -> Icons.Rounded.Chat
    "lock", "lock.shield" -> Icons.Rounded.Lock
    "bell", "bell.badge" -> Icons.Rounded.Notifications
    "speedometer", "gauge" -> Icons.Rounded.Speed
    "ladybug", "ant" -> Icons.Rounded.BugReport
    else -> null
}

// ── The sheet ────────────────────────────────────────────────────────────────

@Composable
fun WhatsNewSheet(notes: List<ReleaseNote>, onClose: () -> Unit) {
    val colors = neuColors

    Column(
        Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .background(colors.surface)
            .padding(bottom = 40.dp),
    ) {
        notes.forEachIndexed { index, note ->
            if (index > 0) {
                Box(
                    Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 20.dp, vertical = 26.dp)
                        .height(1.dp)
                        .background(colors.hairline),
                )
            }
            NoteBody(note, isFirst = index == 0)
        }

        NeuButton(
            onClick = onClose,
            accent = true,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(top = 30.dp),
        ) {
            Text("Got it", style = MaterialTheme.typography.labelLarge, color = colors.onAccent)
        }
    }
}

@Composable
private fun NoteBody(note: ReleaseNote, isFirst: Boolean) {
    val colors = neuColors

    Column {
        if (isFirst) Hero(note)

        Column(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp)
                .padding(top = if (isFirst) 20.dp else 0.dp),
        ) {
            Text(note.title, style = MaterialTheme.typography.headlineSmall, color = colors.textPrimary)
            Spacer(Modifier.height(4.dp))
            Text(subtitle(note), style = MaterialTheme.typography.labelMedium, color = colors.textTertiary)
        }

        note.intro?.takeIf { it.isNotBlank() }?.let {
            Text(
                it,
                style = MaterialTheme.typography.bodyLarge,
                color = colors.textSecondary,
                modifier = Modifier.padding(horizontal = 20.dp).padding(top = 12.dp),
            )
        }

        note.sections.forEach { SectionView(it) }
    }
}

/**
 * The release's own art when it ships some, and the brand mark on a gradient
 * otherwise.
 *
 * Drawn rather than fetched by default: this sheet is the first thing someone
 * sees after updating, sometimes before the network settles, and a grey
 * rectangle at the top of it is a bad first impression.
 */
@Composable
private fun Hero(note: ReleaseNote) {
    val colors = neuColors

    Box(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 16.dp)
            .height(168.dp)
            .clip(RoundedCornerShape(Neu.CornerLarge))
            .background(GfxBrush.linearGradient(listOf(colors.accent, colors.accentSoft))),
        contentAlignment = Alignment.Center,
    ) {
        if (!note.heroUrl.isNullOrBlank()) {
            AsyncImage(
                model = note.heroUrl,
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxWidth().height(168.dp),
            )
        } else {
            LogoMark(height = 44.dp, tint = colors.onAccent)
        }
    }
}

@Composable
private fun SectionView(section: ReleaseNoteSection) {
    val colors = neuColors

    Row(
        Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(top = 26.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        releaseIcon(section.icon)?.let { icon ->
            Icon(icon, null, tint = colors.accent, modifier = Modifier.size(15.dp))
            Spacer(Modifier.width(8.dp))
        }
        Text(
            section.heading.uppercase(Locale.getDefault()),
            style = MaterialTheme.typography.labelSmall.copy(letterSpacing = 0.6.sp),
            color = colors.accent,
        )
        Spacer(Modifier.width(10.dp))
        Box(Modifier.weight(1f).height(1.dp).background(colors.accent.copy(alpha = 0.25f)))
    }

    Column(
        Modifier.padding(horizontal = 20.dp).padding(top = 14.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        section.items.forEach { ItemView(it) }
    }
}

@Composable
private fun ItemView(item: ReleaseNoteItem) {
    val colors = neuColors

    Row(Modifier.fillMaxWidth()) {
        Box(
            Modifier
                .padding(top = 7.dp)
                .size(5.dp)
                .clip(CircleShape)
                .background(colors.textTertiary.copy(alpha = 0.5f)),
        )
        Spacer(Modifier.width(10.dp))
        // One Text so the bold lead-in and the sentence wrap as a paragraph
        // rather than as two stacked blocks.
        Text(
            buildAnnotatedString {
                withStyle(SpanStyle(color = colors.textPrimary, fontWeight = FontWeight.SemiBold)) {
                    append(item.title)
                }
                append("  ")
                withStyle(SpanStyle(color = colors.textSecondary)) { append(item.body) }
            },
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.weight(1f),
        )
    }
}

/** "Version 1.1.0 · 10 August 2026", degrading to whichever half parses. */
private fun subtitle(note: ReleaseNote): String = buildList {
    if (note.version.isNotBlank()) add("Version ${note.version}")
    prettyDate(note.date)?.let { add(it) }
}.joinToString(" · ")

private val OUTBOUND: DateTimeFormatter =
    DateTimeFormatter.ofPattern("d MMMM yyyy", Locale.getDefault())

private fun prettyDate(raw: String): String? =
    runCatching { LocalDate.parse(raw).format(OUTBOUND) }.getOrNull()
