package gg.yappy.app.ui.explore

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import gg.yappy.app.LocalContainer
import gg.yappy.app.data.DiscoverEntry
import gg.yappy.app.ui.components.Avatar
import gg.yappy.app.ui.components.NeuButton
import gg.yappy.app.ui.components.NeuIconButton
import gg.yappy.app.ui.components.NeuSurface
import gg.yappy.app.ui.theme.Neu
import gg.yappy.app.ui.theme.neuColors
import kotlinx.coroutines.launch

/**
 * Explore: public groups anyone can join.
 *
 * This is what makes the "public" toggle in group settings mean something — a
 * flipped switch is only a promise until strangers can actually find the room.
 */
@Composable
fun ExploreScreen(onBack: () -> Unit, onOpenChat: (String) -> Unit) {
    val container = LocalContainer.current
    val colors = neuColors
    val scope = rememberCoroutineScope()

    var entries by remember { mutableStateOf<List<DiscoverEntry>?>(null) }
    var joining by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        entries = runCatching { container.repo.discover().conversations }.getOrDefault(emptyList())
    }

    Column(Modifier.fillMaxSize().statusBarsPadding()) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            NeuIconButton(Icons.AutoMirrored.Rounded.ArrowBack, "Back", onBack, size = 42.dp, iconSize = 19.dp)
            Spacer(Modifier.width(14.dp))
            Text("Explore", style = MaterialTheme.typography.headlineSmall, color = colors.textPrimary)
        }

        when {
            entries == null -> Box(Modifier.fillMaxSize(), Alignment.Center) {
                CircularProgressIndicator(color = colors.accent)
            }

            entries!!.isEmpty() -> Box(Modifier.fillMaxSize(), Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(
                        "Nothing public yet",
                        style = MaterialTheme.typography.titleMedium,
                        color = colors.textSecondary,
                    )
                    Spacer(Modifier.height(6.dp))
                    Text(
                        "Make one of your groups public and it will show up here.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = colors.textTertiary,
                    )
                }
            }

            else -> LazyColumn(
                contentPadding = androidx.compose.foundation.layout.PaddingValues(
                    start = 16.dp, end = 16.dp, bottom = 40.dp, top = 6.dp,
                ),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                items(entries!!, key = { it.id }) { entry ->
                    NeuSurface(
                        modifier = Modifier.fillMaxWidth(),
                        shape = RoundedCornerShape(Neu.CornerMedium),
                        contentPadding = 14.dp,
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Avatar(
                                entry.avatarUrl, entry.title, entry.id, size = 50.dp,
                                shape = gg.yappy.app.ui.theme.PlaceShape,
                            )
                            Spacer(Modifier.width(13.dp))
                            Column(Modifier.weight(1f)) {
                                Text(
                                    entry.title ?: "Group",
                                    style = MaterialTheme.typography.titleMedium,
                                    color = colors.textPrimary,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                                Text(
                                    buildString {
                                        append("${entry.memberCount} members")
                                        entry.handle?.let { append(" · @$it") }
                                    },
                                    style = MaterialTheme.typography.labelSmall,
                                    color = colors.textTertiary,
                                )
                                entry.description?.takeIf { it.isNotBlank() }?.let {
                                    Spacer(Modifier.height(3.dp))
                                    Text(
                                        it,
                                        style = MaterialTheme.typography.bodyMedium,
                                        color = colors.textSecondary,
                                        maxLines = 2,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                }
                            }
                            Spacer(Modifier.width(10.dp))
                            NeuButton(
                                onClick = {
                                    if (joining != null) return@NeuButton
                                    joining = entry.id
                                    scope.launch {
                                        runCatching { container.repo.joinPublic(entry.id).conversation.id }
                                            .onSuccess(onOpenChat)
                                        joining = null
                                    }
                                },
                                accent = true,
                                enabled = joining == null,
                            ) {
                                Text(
                                    if (joining == entry.id) "…" else "Join",
                                    style = MaterialTheme.typography.labelLarge,
                                    color = colors.onAccent,
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}
