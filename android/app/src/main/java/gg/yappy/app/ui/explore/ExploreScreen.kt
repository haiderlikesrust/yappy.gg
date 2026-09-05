package gg.yappy.app.ui.explore

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.CloudOff
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.material3.SnackbarDuration
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import gg.yappy.app.LocalContainer
import gg.yappy.app.data.ApiException
import gg.yappy.app.data.DiscoverEntry
import gg.yappy.app.ui.components.Avatar
import gg.yappy.app.ui.components.LocalSnackbar
import gg.yappy.app.ui.components.BadgeMark
import gg.yappy.app.ui.components.NeuButton
import gg.yappy.app.ui.components.NeuIconButton
import gg.yappy.app.ui.components.NeuSurface
import gg.yappy.app.ui.components.NeuTextField
import gg.yappy.app.ui.components.RefreshBox
import gg.yappy.app.ui.components.SectionLabel
import gg.yappy.app.ui.components.colorForId
import gg.yappy.app.ui.components.flairColor
import gg.yappy.app.ui.theme.Neu
import gg.yappy.app.ui.theme.NeuState
import gg.yappy.app.ui.theme.PlaceShape
import gg.yappy.app.ui.theme.neu
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
    /**
     * Into the place just joined; the shell cuts Explore out of the stack, so
     * Back lands on Home rather than on a directory listing a place you are
     * now inside. A card you already belong to goes through [onOpenJoined].
     *
     * Carries whether it is a space because a space has no timeline of its
     * own: this used to hand every id to the chat route, and a joined space
     * opened as an empty conversation instead of its channel list.
     */
    onOpenPlace: (id: String, isSpace: Boolean) -> Unit,
    /**
     * Into a place you already belong to, from its card. Separate from
     * [onOpenPlace] because this one is a peek: the shell leaves Explore
     * underneath so Back comes back to the directory being browsed.
     */
    onOpenJoined: (id: String, isSpace: Boolean) -> Unit,
    onStartGroup: () -> Unit,
) {
    val container = LocalContainer.current
    val colors = neuColors
    val scope = rememberCoroutineScope()
    val snackbar = LocalSnackbar.current

    var entries by remember { mutableStateOf<List<DiscoverEntry>?>(null) }
    /**
     * Whether the last ask failed. Kept apart from an empty answer, because
     * "no public places yet" and "could not reach yappy" call for different
     * next steps and the old screen said the first in both cases.
     */
    var failed by remember { mutableStateOf(false) }
    var joining by remember { mutableStateOf<String?>(null) }
    // Survives a peek into a place and back: "back to the directory" is
    // worth little if the search that found the place is gone.
    var query by rememberSaveable { mutableStateOf("") }
    /** Bumped by a pull; a refresh is a re-run of the same fetch. */
    var refreshKey by remember { mutableIntStateOf(0) }
    var refreshing by remember { mutableStateOf(false) }

    // Browse loads once; a query re-asks the server, debounced so a fast
    // typist costs one request, not one per letter. A pull skips the wait —
    // the gesture already *is* the pause.
    LaunchedEffect(query, refreshKey) {
        if (query.isNotBlank() && !refreshing) delay(350)
        val hadList = entries != null
        val result = runCatching { container.repo.discover(query).conversations }
        result
            .onSuccess {
                entries = it
                failed = false
            }
            .onFailure {
                // A pull that fails keeps what was already drawn. Replacing a
                // full directory with "could not reach yappy" because the
                // refresh timed out throws away the thing being browsed, and
                // the gesture that did it was only meant to check for more.
                failed = !hadList
                if (!hadList) entries = emptyList()
                // On the shell's scope, not this effect's: showSnackbar
                // suspends for as long as the message is up, and the spinner
                // below must not stay spinning for those four seconds.
                if (hadList) scope.launch {
                    snackbar.showSnackbar("Couldn't refresh — showing what loaded last")
                }
            }
        refreshing = false
    }
    val refresh: () -> Unit = {
        refreshing = true
        refreshKey += 1
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
        if (loaded == null) {
            Box(Modifier.fillMaxSize().navigationBarsPadding(), Alignment.Center) {
                CircularProgressIndicator(color = colors.accent)
            }
            return@Column
        }

        // The same raised disc every pullable list in the app uses, so the
        // control does not change size between here, home and a place.
        RefreshBox(
            refreshing = refreshing,
            onRefresh = refresh,
            underStatusBar = false,
            modifier = Modifier.fillMaxSize(),
        ) {
            when {
                loaded.isEmpty() -> EmptyExplore(
                    searching = query.isNotBlank(),
                    failed = failed,
                    onStartGroup = onStartGroup,
                    onRetry = refresh,
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
                                // The joined conversation says what it is; the
                                // directory row's type is only the fallback.
                                val result = runCatching { container.repo.joinPublic(entry.id).conversation }
                                joining = null
                                result
                                    .onSuccess { conv -> onOpenPlace(conv.id, conv.isSpace) }
                                    .onFailure { err ->
                                        // Silent before: the label went "…" and
                                        // back to "Join", and people tapped it
                                        // again and again. The shell's host is
                                        // visible on this route.
                                        val api = err as? ApiException
                                        snackbar.showSnackbar(
                                            when {
                                                api?.status == 429 -> "Too many joins for now — try again in a minute"
                                                api?.status == 403 || api?.status == 404 -> "That place isn't open to join right now"
                                                else -> "Couldn't join — check the connection and try again"
                                            },
                                            duration = SnackbarDuration.Short,
                                        )
                                    }
                            }
                        }
                    }
                    val doOpen: (DiscoverEntry) -> Unit = { entry ->
                        onOpenJoined(entry.id, entry.type == "space")
                    }

                    // The list runs under the transparent navigation bar and
                    // the last card clears it by the bar's real height.
                    val navBottom = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
                    LazyColumn(
                        contentPadding = PaddingValues(
                            start = 16.dp,
                            end = 16.dp,
                            top = 6.dp,
                            bottom = 24.dp + navBottom,
                        ),
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                        modifier = Modifier.fillMaxSize(),
                    ) {
                        section("Verified", verified) { PlaceCard(it, joining, doJoin, doOpen) }
                        section("Buzzing now", buzzing) { PlaceCard(it, joining, doJoin, doOpen) }
                        section("New places", fresh) { PlaceCard(it, joining, doJoin, doOpen) }
                        section(
                            if (verified.isEmpty() && buzzing.isEmpty() && fresh.isEmpty()) null else "More places",
                            others,
                        ) { PlaceCard(it, joining, doJoin, doOpen) }
                    }
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
private fun PlaceCard(
    entry: DiscoverEntry,
    joining: String?,
    onJoin: (DiscoverEntry) -> Unit,
    /** For a place you already belong to: straight in, no join. */
    onOpen: (DiscoverEntry) -> Unit,
) {
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
                    // A pill cut from the sheet itself, not a black scrim: the
                    // band is somebody's flair and a scrim mutes it. The dot
                    // and the word are danger red — the app's one colour for
                    // "live", the same one the call screen uses.
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier
                            .align(Alignment.TopStart)
                            .padding(10.dp)
                            .clip(CircleShape)
                            .background(colors.surface.copy(alpha = 0.88f))
                            .padding(horizontal = 8.dp, vertical = 3.dp),
                    ) {
                        Box(Modifier.size(6.dp).clip(CircleShape).background(colors.danger))
                        Spacer(Modifier.width(5.dp))
                        Text(
                            "LIVE",
                            style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.Bold),
                            color = colors.danger,
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
                            // Said in the meta line rather than as a mark of
                            // its own, so the card's title row stays the
                            // group's — this is a fact about you, not it.
                            if (entry.joined) append("Joined · ")
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
                if (entry.joined) {
                    // Open, not Join, and in the plain key rather than the
                    // accent: the directory used to offer a Join on a place
                    // the person was already standing in, and the server
                    // answered it with "already a member" and the chat —
                    // a door that only worked by accident.
                    NeuButton(onClick = { onOpen(entry) }, enabled = joining == null) {
                        Text(
                            "Open",
                            style = MaterialTheme.typography.labelLarge,
                            color = colors.textPrimary,
                        )
                    }
                } else {
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
}

/**
 * Empty, with doors. Advice without a way to act on it is the old version's
 * mistake — "make a group public" with nowhere to tap. Both paths people can
 * actually take from here are buttons.
 *
 * Scrollable even though it fits, so the pull gesture still works on it: an
 * empty answer is exactly when somebody wants to ask again.
 */
@Composable
private fun EmptyExplore(
    searching: Boolean,
    failed: Boolean,
    onStartGroup: () -> Unit,
    onRetry: () -> Unit,
) {
    val colors = neuColors
    BoxWithConstraints(Modifier.fillMaxSize().navigationBarsPadding()) {
        Column(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .heightIn(min = maxHeight)
                .padding(horizontal = 40.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            if (failed) {
                // A recessed dish, the same one every empty state in the app
                // uses, rather than the brand wash: nothing here is a place
                // yet, and dressing a network failure in flair would say
                // "nobody made one" when the truth is "we could not ask".
                Box(
                    Modifier.size(64.dp).neu(PlaceShape, colors, NeuState.Pressed, 4.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(Icons.Rounded.CloudOff, null, tint = colors.textTertiary, modifier = Modifier.size(26.dp))
                }
            } else {
                Box(
                    Modifier
                        .size(64.dp)
                        .clip(PlaceShape)
                        .background(
                            Brush.linearGradient(
                                listOf(colors.accent.copy(alpha = 0.4f), colors.accentSoft),
                            ),
                        ),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(Icons.Rounded.Search, null, tint = colors.textSecondary, modifier = Modifier.size(26.dp))
                }
            }
            Spacer(Modifier.height(16.dp))
            Text(
                when {
                    failed -> "Couldn't reach yappy"
                    searching -> "Nothing matches"
                    else -> "No public places yet"
                },
                style = MaterialTheme.typography.titleMedium,
                color = colors.textPrimary,
            )
            Spacer(Modifier.height(6.dp))
            Text(
                when {
                    failed -> "Check your connection, then try again."
                    searching -> "Try another name — or start the group you were looking for."
                    else -> "Public groups show up here for anyone to walk into. Yours could be first: make a group, then flip it to public in its settings."
                },
                style = MaterialTheme.typography.bodyMedium,
                color = colors.textTertiary,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(20.dp))
            if (failed) {
                NeuButton(onClick = onRetry, accent = true) {
                    Text("Try again", style = MaterialTheme.typography.labelLarge, color = colors.onAccent)
                }
            } else {
                NeuButton(onClick = onStartGroup, accent = true) {
                    Text("Start a group", style = MaterialTheme.typography.labelLarge, color = colors.onAccent)
                }
            }
        }
    }
}
