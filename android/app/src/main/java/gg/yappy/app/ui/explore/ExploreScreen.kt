package gg.yappy.app.ui.explore

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import gg.yappy.app.LocalContainer
import gg.yappy.app.data.DiscoverEntry
import gg.yappy.app.ui.components.Avatar
import gg.yappy.app.ui.components.BadgeMark
import gg.yappy.app.ui.components.NeuButton
import gg.yappy.app.ui.components.NeuIconButton
import gg.yappy.app.ui.components.NeuSurface
import gg.yappy.app.ui.components.NeuTextField
import gg.yappy.app.ui.components.SectionLabel
import gg.yappy.app.ui.components.colorForId
import gg.yappy.app.ui.components.flairColor
import gg.yappy.app.ui.theme.Neu
import gg.yappy.app.ui.theme.PlaceShape
import gg.yappy.app.ui.theme.neuColors
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Explore: public places, ranked by warmth.
 *
 * A place-first directory has one question to answer better than "how big is
 * it": *is anyone there right now?* Seven people with three present beats two
 * hundred and nobody home, so the page leads with who is around — the live
 * calls, the here-counts — and lets size be a detail.
 *
 * Every group is drawn as a card wearing its own flair: the gradient and emoji
 * its owner picked in settings, or a tint derived from its id when they never
 * did. A directory of identical grey rows says "database"; a wall of covers
 * says "places".
 */
@Composable
fun ExploreScreen(
    onBack: () -> Unit,
    onOpenChat: (String) -> Unit,
    onStartGroup: () -> Unit,
) {
    val container = LocalContainer.current
    val colors = neuColors
    val scope = rememberCoroutineScope()

    var entries by remember { mutableStateOf<List<DiscoverEntry>?>(null) }
    var joining by remember { mutableStateOf<String?>(null) }
    var query by remember { mutableStateOf("") }

    // Browse loads once; a query re-asks the server, debounced so a fast
    // typist costs one request, not one per letter.
    LaunchedEffect(query) {
        if (query.isNotBlank()) delay(350)
        entries = runCatching { container.repo.discover(query).conversations }.getOrDefault(emptyList())
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

        NeuTextField(
            value = query,
            onValueChange = { query = it },
            placeholder = "Search public groups",
            leading = {
                Icon(Icons.Rounded.Search, null, tint = colors.textTertiary, modifier = Modifier.size(19.dp))
            },
            shape = RoundedCornerShape(Neu.CornerPill),
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
        )
        Spacer(Modifier.height(8.dp))

        val loaded = entries
        when {
            loaded == null -> Box(Modifier.fillMaxSize(), Alignment.Center) {
                CircularProgressIndicator(color = colors.accent)
            }

            loaded.isEmpty() -> EmptyExplore(
                searching = query.isNotBlank(),
                onStartGroup = onStartGroup,
            )

            else -> {
                /**
                 * Sectioned by what matters, in order: the vouched-for, the
                 * warm, the fresh, then everything else. A group appears once,
                 * in the strongest section it qualifies for.
                 */
                val (verified, rest1) = loaded.partition { it.badge != null }
                val (buzzing, rest2) = rest1.partition { it.hereCount > 0 || it.live }
                val (fresh, others) = rest2.partition { isNew(it.createdAt) }

                val doJoin: (DiscoverEntry) -> Unit = { entry ->
                    if (joining == null) {
                        joining = entry.id
                        scope.launch {
                            runCatching { container.repo.joinPublic(entry.id).conversation.id }
                                .onSuccess(onOpenChat)
                            joining = null
                        }
                    }
                }

                LazyColumn(
                    contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 40.dp, top = 6.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    section("Verified", verified) { PlaceCard(it, joining, doJoin) }
                    section("Buzzing now", buzzing) { PlaceCard(it, joining, doJoin) }
                    section("New places", fresh) { PlaceCard(it, joining, doJoin) }
                    section(
                        if (verified.isEmpty() && buzzing.isEmpty() && fresh.isEmpty()) null else "More places",
                        others,
                    ) { PlaceCard(it, joining, doJoin) }
                }
            }
        }
    }
}

/** Under two weeks old — young enough that joining still means shaping it. */
private fun isNew(createdAt: String?): Boolean {
    createdAt ?: return false
    val created = runCatching { java.time.Instant.parse(createdAt) }.getOrNull() ?: return false
    return created.isAfter(java.time.Instant.now().minus(java.time.Duration.ofDays(14)))
}

private fun androidx.compose.foundation.lazy.LazyListScope.section(
    label: String?,
    items: List<DiscoverEntry>,
    card: @Composable (DiscoverEntry) -> Unit,
) {
    if (items.isEmpty()) return
    label?.let {
        item(key = "label-$it") {
            SectionLabel(it, Modifier.padding(start = 8.dp, top = 8.dp))
        }
    }
    items(items, key = { it.id }) { entry -> card(entry) }
}

/**
 * One public group, drawn as a cover.
 *
 * The band at the top wears the group's own flair gradient — the identity its
 * owner chose in settings — falling back to the deterministic id-colour every
 * avatar already uses, so no two groups without flair look the same either.
 */
@Composable
private fun PlaceCard(entry: DiscoverEntry, joining: String?, onJoin: (DiscoverEntry) -> Unit) {
    val colors = neuColors

    val stops = entry.appearance?.gradient
        ?.mapNotNull { flairColor(it) }
        ?.takeIf { it.size >= 2 }
        ?: listOf(colorForId(entry.id).copy(alpha = 0.85f), colorForId(entry.id).copy(alpha = 0.3f))

    NeuSurface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(Neu.CornerMedium),
        contentPadding = 0.dp,
    ) {
        Column {
            // The cover band. Short on purpose: it is a banner, not a poster,
            // and four of these should fit a screen.
            Box(
                Modifier
                    .fillMaxWidth()
                    .height(54.dp)
                    .clip(RoundedCornerShape(topStart = Neu.CornerMedium, topEnd = Neu.CornerMedium))
                    .background(Brush.linearGradient(stops)),
            ) {
                entry.appearance?.emoji?.let {
                    Text(
                        it,
                        style = MaterialTheme.typography.titleLarge,
                        modifier = Modifier.align(Alignment.CenterEnd).padding(end = 16.dp),
                    )
                }
                if (entry.live) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier
                            .align(Alignment.TopStart)
                            .padding(10.dp)
                            .clip(CircleShape)
                            .background(Color(0xAA000000))
                            .padding(horizontal = 8.dp, vertical = 3.dp),
                    ) {
                        Box(Modifier.size(6.dp).clip(CircleShape).background(Color(0xFFFF5252)))
                        Spacer(Modifier.width(5.dp))
                        Text(
                            "LIVE",
                            style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.Bold),
                            color = Color.White,
                        )
                    }
                }
            }

            Row(
                Modifier.padding(start = 14.dp, end = 14.dp, bottom = 14.dp),
                verticalAlignment = Alignment.Bottom,
            ) {
                // The squircle straddles the band's lower edge, the same trick
                // the profile page uses to make an avatar sit *on* a banner.
                Box(Modifier.padding(top = 0.dp)) {
                    Box(
                        Modifier
                            .clip(PlaceShape)
                            .background(colors.surface)
                            .padding(3.dp),
                    ) {
                        Avatar(entry.avatarUrl, entry.title, entry.id, size = 52.dp, shape = PlaceShape)
                    }
                }
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f).padding(top = 10.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            entry.title ?: "Group",
                            style = MaterialTheme.typography.titleMedium,
                            color = colors.textPrimary,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f, fill = false),
                        )
                        entry.badge?.let {
                            Spacer(Modifier.width(5.dp))
                            BadgeMark(it, size = 15.dp)
                        }
                    }
                    Text(
                        buildString {
                            if (entry.hereCount > 0) append("${entry.hereCount} here now · ")
                            append("${entry.memberCount} ${if (entry.memberCount == 1) "member" else "members"}")
                            entry.handle?.let { append(" · @$it") }
                        },
                        style = MaterialTheme.typography.labelSmall,
                        color = if (entry.hereCount > 0) colors.success else colors.textTertiary,
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
                NeuButton(onClick = { onJoin(entry) }, accent = true, enabled = joining == null) {
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

/**
 * Empty, with doors. Advice without a way to act on it is the old version's
 * mistake — "make a group public" with nowhere to tap. Both paths people can
 * actually take from here are buttons.
 */
@Composable
private fun EmptyExplore(searching: Boolean, onStartGroup: () -> Unit) {
    val colors = neuColors
    Box(Modifier.fillMaxSize().padding(horizontal = 40.dp), Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Box(
                Modifier
                    .size(64.dp)
                    .clip(PlaceShape)
                    .background(
                        Brush.linearGradient(
                            listOf(Color(0xFF8B7CFF).copy(alpha = 0.4f), Color(0xFF00CEC9).copy(alpha = 0.25f)),
                        ),
                    ),
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Rounded.Search, null, tint = colors.textSecondary, modifier = Modifier.size(26.dp))
            }
            Spacer(Modifier.height(16.dp))
            Text(
                if (searching) "Nothing matches" else "No public places yet",
                style = MaterialTheme.typography.titleMedium,
                color = colors.textPrimary,
            )
            Spacer(Modifier.height(6.dp))
            Text(
                if (searching) {
                    "Try another name — or start the group you were looking for."
                } else {
                    "Public groups show up here for anyone to walk into. Yours could be first: make a group, then flip it to public in its settings."
                },
                style = MaterialTheme.typography.bodyMedium,
                color = colors.textTertiary,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(20.dp))
            NeuButton(onClick = onStartGroup, accent = true) {
                Text("Start a group", style = MaterialTheme.typography.labelLarge, color = colors.onAccent)
            }
        }
    }
}
