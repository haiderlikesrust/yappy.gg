package gg.yappy.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.layout.ContentScale
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
) {
    Box(modifier = modifier.size(size), contentAlignment = Alignment.BottomEnd) {
        Box(
            Modifier.size(size).clip(shape),
            contentAlignment = Alignment.Center,
        ) {
            if (url != null) {
                AsyncImage(
                    model = url,
                    contentDescription = name,
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.size(size).clip(shape),
                )
            } else {
                Box(
                    Modifier
                        .size(size)
                        .background(colorForId(id), shape),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        initialsOf(name),
                        color = Color.White,
                        style = MaterialTheme.typography.titleMedium.copy(
                            fontSize = (size.value / 2.6f).sp,
                        ),
                    )
                }
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
            )
        }
    }
}
