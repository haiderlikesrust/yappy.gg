package gg.yappy.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
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
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import kotlin.math.absoluteValue

/**
 * Avatars are flat, clipped circles — they are content, not chrome, and a
 * screen that is mostly a list of them cannot afford a shadow treatment on
 * every one.
 *
 * The fallback is a deterministic colour derived from the user id, so the same
 * person is always the same colour on every device without the server having to
 * store one.
 */
private val FALLBACK_COLORS = listOf(
    Color(0xFF6C5CE7), Color(0xFF00B894), Color(0xFFE17055), Color(0xFF0984E3),
    Color(0xFFD63031), Color(0xFF6D4C41), Color(0xFF00838F), Color(0xFF8E24AA),
)

fun colorForId(id: String): Color =
    FALLBACK_COLORS[(id.hashCode().absoluteValue) % FALLBACK_COLORS.size]

fun initialsOf(name: String?): String {
    val trimmed = name?.trim().orEmpty()
    if (trimmed.isEmpty()) return "?"
    val parts = trimmed.split(' ', '_', '.').filter { it.isNotBlank() }
    return when {
        parts.size >= 2 -> "${parts[0].first()}${parts[1].first()}".uppercase()
        else -> trimmed.take(2).uppercase()
    }
}

@Composable
fun Avatar(
    url: String?,
    name: String?,
    id: String,
    modifier: Modifier = Modifier,
    size: Dp = 48.dp,
    presence: String? = null,
    /** Circles are people; pass [gg.yappy.app.ui.theme.PlaceShape] for groups. */
    shape: Shape = CircleShape,
    /**
     * What a screen reader should call this face — normally nothing.
     *
     * Almost every avatar sits beside a Text that already names whoever it
     * shows, and a labelled one made the row read "Ada. Ada. see you at six":
     * a merged row speaks its picture's description and then its own text.
     * So the face is decorative by default and named only where it is the one
     * thing identifying the person — a stack of group faces, a grouped bubble
     * with the sender's name folded away, the typing dots.
     */
    contentDescription: String? = null,
) {
    // A picture that never arrives — a stale link, a dev bucket without the
    // object — left the slot blank: the yapper bot in People was an empty
    // circle. Once the load fails the image is not composed again, so a
    // broken picture can never sit over the initials. Keyed on the url so a
    // corrected link gets its chance.
    var failed by remember(url) { mutableStateOf(false) }
    var loaded by remember(url) { mutableStateOf(false) }

    Box(
        modifier = modifier
            .size(size)
            // One name for the reader, on the outer element, whichever layer
            // is showing — the picture and the initials are the same person,
            // and two descriptions would have it read twice.
            .then(
                if (contentDescription != null) {
                    Modifier.semantics { this.contentDescription = contentDescription }
                } else {
                    Modifier
                },
            ),
        contentAlignment = Alignment.BottomEnd,
    ) {
        Box(
            Modifier.size(size).clip(shape),
            contentAlignment = Alignment.Center,
        ) {
            // The initials disc sits under the picture rather than standing in
            // for it: it shows while the image loads and is still there if the
            // load fails, so a directory row with a dead link gets a coloured
            // disc with a name on it instead of a hole. Gone once the picture
            // has landed — a transparent avatar showed the disc and two
            // letters through its clear parts.
            if (url == null || failed || !loaded) {
                Box(
                    Modifier.size(size).background(colorForId(id), shape),
                    contentAlignment = Alignment.Center,
                ) {
                    // Never spoken: two letters come out as two letters spelt.
                    Text(
                        initialsOf(name),
                        modifier = Modifier.clearAndSetSemantics {},
                        color = Color.White,
                        style = MaterialTheme.typography.titleMedium.copy(
                            fontSize = (size.value / 2.6f).sp,
                        ),
                    )
                }
            }
            if (url != null && !failed) {
                AsyncImage(
                    model = url,
                    // The outer element already carries the name.
                    contentDescription = null,
                    contentScale = ContentScale.Crop,
                    onSuccess = { loaded = true },
                    onError = { failed = true },
                    modifier = Modifier.size(size).clip(shape),
                )
            }
        }

        if (presence != null && presence != "offline") {
            PresenceDot(presence, size = (size.value / 3.6f).coerceIn(10f, 16f).dp)
        }
    }
}

/** Overlapping faces for a group row. */
@Composable
fun AvatarStack(
    people: List<Triple<String, String?, String?>>, // id, name, url
    modifier: Modifier = Modifier,
    size: Dp = 48.dp,
) {
    val shown = people.take(3)
    Box(modifier.size(size), contentAlignment = Alignment.Center) {
        shown.forEachIndexed { index, (id, name, url) ->
            val small = size * 0.62f
            val step = (size - small) / (shown.size - 1).coerceAtLeast(1)
            // Fanned along the diagonal so each face stays identifiable.
            Avatar(
                url = url,
                name = name,
                id = id,
                size = small,
                modifier = Modifier.offset(x = step * index - step, y = step * index - step),
                // The only place these three people are named: the row beside
                // the stack says "5 members", not who they are.
                contentDescription = name,
            )
        }
    }
}
