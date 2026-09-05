package gg.yappy.app.ui.conversations

import gg.yappy.app.BuildConfig
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonPrimitive
import androidx.activity.compose.BackHandler
import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.exclude
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Archive
import androidx.compose.material.icons.rounded.Call
import androidx.compose.material.icons.rounded.CloudOff
import androidx.compose.material.icons.rounded.DoneAll
import androidx.compose.material.icons.rounded.Explore
import androidx.compose.material.icons.rounded.Info
import androidx.compose.material.icons.rounded.Link
import androidx.compose.material.icons.rounded.LocalFireDepartment
import androidx.compose.material.icons.rounded.Lock
import androidx.compose.material.icons.rounded.Notifications
import androidx.compose.material.icons.rounded.NotificationsOff
import androidx.compose.material.icons.rounded.Person
import androidx.compose.material.icons.rounded.Public
import androidx.compose.material.icons.rounded.PushPin
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material.icons.rounded.Unarchive
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.material.icons.rounded.Close
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.rememberCoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import gg.yappy.app.LocalContainer
import gg.yappy.app.data.Conversation
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import gg.yappy.app.ui.components.ActionRow
import gg.yappy.app.ui.components.Avatar
import gg.yappy.app.ui.components.BadgeMark
import gg.yappy.app.ui.components.FlairAvatar
import gg.yappy.app.ui.components.LocalSnackbar
import gg.yappy.app.ui.components.LocalSnackbarClearance
import gg.yappy.app.ui.components.PixelPet
import gg.yappy.app.ui.components.IdentityMarks
import gg.yappy.app.ui.components.LogoMarkGradient
import gg.yappy.app.ui.components.NeuButton
import gg.yappy.app.ui.components.NeuIconButton
import gg.yappy.app.ui.components.RefreshBox
import gg.yappy.app.ui.components.SectionLabel
import gg.yappy.app.ui.components.petDescription
import gg.yappy.app.ui.components.gradientFill
import gg.yappy.app.ui.components.softClickable
import gg.yappy.app.ui.components.titleColor
import gg.yappy.app.ui.components.NeuSurface
import gg.yappy.app.ui.components.NeuTextField
import gg.yappy.app.ui.theme.Neu
import gg.yappy.app.ui.theme.NeuState
import gg.yappy.app.ui.theme.PlaceShape
import gg.yappy.app.ui.theme.neu
import gg.yappy.app.ui.theme.neuColors
import gg.yappy.app.ui.util.relativeTime
import androidx.compose.material.icons.rounded.AlternateEmail
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.Logout

@OptIn(ExperimentalFoundationApi::class, ExperimentalMaterial3Api::class)
@Composable
fun ConversationsScreen(
    onOpenChat: (String) -> Unit,
    /** A space opens its channel list; it has no timeline of its own. */
    onOpenSpace: (String) -> Unit,
    onNewChat: () -> Unit,
    onSettings: () -> Unit,
    onExplore: () -> Unit,
    onOpenProfile: (String) -> Unit = {},
    /** Everywhere you were called, in one list. */
    onOpenMentions: () -> Unit = {},
    /**
     * The group's own page, from the row's long-press sheet. Optional so the
     * sheet can leave the row out entirely rather than offer a door that
     * opens onto nothing.
     */
    onOpenGroup: ((String) -> Unit)? = null,
) {
    val container = LocalContainer.current
    val vm: ConversationsViewModel = viewModel(factory = ConversationsViewModel.factory(container))
    val state by vm.state.collectAsStateWithLifecycle()
    val colors = neuColors
    val scope = rememberCoroutineScope()
    val snackbar = LocalSnackbar.current
    val clipboard = LocalClipboardManager.current
    val listState = rememberLazyListState()

    // The bottom inset the list keys off. On 3-button navigation it is the
    // bar's height; on gesture navigation it is a sliver — either way the
    // last row clears it by exactly the design gap, rather than floating
    // 34dp above nothing on one phone and sitting under the bar on the next.
    //
    // Less the keyboard: the list box already pads for the IME, and the IME
    // covers the bar, so while search has the keyboard up the bar's height
    // was being added a second time under the last row. `exclude` follows
    // the keyboard's own animation rather than snapping when it lands.
    val navBottom = WindowInsets.navigationBars.exclude(WindowInsets.ime)
        .asPaddingValues().calculateBottomPadding()

    // Starts hidden and appears once the answer is known. The other way round
    // shows the card for a frame to somebody who dismissed it a week ago, which
    // is a worse first impression than never having offered it.
    var starterDismissed by remember { mutableStateOf(true) }
    LaunchedEffect(Unit) { starterDismissed = container.session.dismissedStarter() }

    /*
     * System Back unwinds the screen's own modes before it leaves the screen.
     *
     * A search and the archive are both states you enter in place, and Back
     * used to ignore them and quit the app — the one gesture every Android
     * thumb reaches for, answered with the home screen. Query first, then the
     * field's focus, then the archive, because that is the order they were
     * entered in.
     *
     * Focus is a mode too. Clearing the query left the field focused — the
     * violet ring stayed on an empty well — so three Backs walked out of the
     * app with the search still lit as if it were waiting for something.
     * Clearing the text now drops the focus with it, and a focused empty
     * field gives up its ring before the screen gives up the app.
     */
    var searchFocused by remember { mutableStateOf(false) }
    val focusManager = LocalFocusManager.current
    BackHandler(enabled = state.query.isNotBlank() || searchFocused || state.showArchived) {
        when {
            state.query.isNotBlank() -> {
                vm.setQuery("")
                focusManager.clearFocus()
            }
            searchFocused -> focusManager.clearFocus()
            else -> vm.toggleArchived()
        }
    }

    /*
     * The second hand for "now" / "3m".
     *
     * Each row's relative time was computed once per composition, so a list
     * left open read "now" until something else happened to recompose it.
     * One tick, aligned to the minute boundary, and every row re-derives its
     * label from it — cheap, because rows are otherwise skippable.
     */
    val minute by produceState(0L) {
        while (true) {
            delay(60_000 - System.currentTimeMillis() % 60_000)
            value++
        }
    }

    // The long-press sheet's subject. One sheet for the screen rather than
    // one menu per row: a row is a row, and the sheet is the same object
    // whichever row summoned it.
    var sheetFor by remember { mutableStateOf<Conversation?>(null) }

    /*
     * Archive with a way back.
     *
     * The swipe fired on release and the row vanished; the only route home
     * was the Archived foot, three taps away. A short Undo is what the
     * gesture's speed owes the thumb that slipped.
     */
    fun archiveWithUndo(conversation: Conversation) {
        val restoring = state.showArchived
        val index = vm.archive(conversation)
        scope.launch {
            // The newer Undo replaces the older one. The host queues by
            // default, so a second archive's Undo waited behind the first
            // for the rest of its four seconds — the one that had just
            // happened was the one you could not yet take back.
            snackbar.currentSnackbarData?.dismiss()
            val result = snackbar.showSnackbar(
                message = (if (restoring) "Restored " else "Archived ") + conversation.displayName,
                actionLabel = "Undo",
                duration = SnackbarDuration.Short,
            )
            if (result == SnackbarResult.ActionPerformed) vm.unarchive(conversation, index)
        }
    }

    fun muteWithUndo(conversation: Conversation, message: String, mutate: () -> Unit) {
        mutate()
        scope.launch {
            // Same as the archive: the latest Undo is the one on screen.
            snackbar.currentSnackbarData?.dismiss()
            val result = snackbar.showSnackbar(
                message = message,
                actionLabel = "Undo",
                duration = SnackbarDuration.Short,
            )
            if (result == SnackbarResult.ActionPerformed) vm.restoreMuteState(conversation)
        }
    }

    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().statusBarsPadding()) {

            Row(
                Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 14.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    // The lockup is the one place the app says its own name:
                    // mark then wordmark, both in the brand gradient so they
                    // read as one object rather than a logo next to a title.
                    // Tapping it runs the list back to the top — the same
                    // promise a tab-bar icon makes on iOS, kept by the thing
                    // that sits where a tab bar would.
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier
                            .clip(RoundedCornerShape(Neu.CornerPill))
                            .softClickable { scope.launch { listState.animateScrollToItem(0) } }
                            .semantics { contentDescription = "yappy, back to top" },
                    ) {
                        LogoMarkGradient(height = 22.dp)
                        Spacer(Modifier.width(9.dp))
                        Text(
                            "yappy",
                            style = MaterialTheme.typography.headlineMedium.copy(fontWeight = FontWeight.ExtraBold),
                            color = colors.textPrimary,
                            modifier = Modifier.gradientFill(
                                Brush.linearGradient(listOf(colors.accent, Color(0xFF00CEC9))),
                            ),
                        )
                    }
                    // A quiet status line instead of a banner: it matters, but
                    // not enough to steal a row from the list.
                    when {
                        /*
                         * The way out of the archive, and the only one.
                         *
                         * The foot of the list used to be enough, until the
                         * archive was empty — then there is no list, so there
                         * was no row, so there was no way back. A mode you can
                         * enter and not leave is a trap, and the exit belongs
                         * where the mode is announced.
                         */
                        state.showArchived -> Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier
                                .clip(RoundedCornerShape(Neu.CornerPill))
                                .softClickable(onClick = vm::toggleArchived)
                                .padding(horizontal = 6.dp, vertical = 2.dp),
                        ) {
                            Icon(
                                Icons.AutoMirrored.Rounded.ArrowBack,
                                null,
                                tint = colors.accent,
                                modifier = Modifier.size(13.dp),
                            )
                            Spacer(Modifier.width(4.dp))
                            Text(
                                "Archived",
                                style = MaterialTheme.typography.labelSmall,
                                color = colors.accent,
                            )
                        }
                        // Connection state used to be whispered here under the
                        // wordmark; the shell's connection strip across the
                        // top says it now, pushing every screen down by its
                        // own height, so the header keeps to what it is for.
                    }
                }

                /*
                 * The count is summed from the same per-room mention counts
                 * the cards below already carry, rather than a second number
                 * fetched for the purpose: the two would then have to agree,
                 * and the one that went stale would be this one.
                 *
                 * A number rather than a dot, because "you were called" and
                 * "you were called eleven times" are different situations and
                 * only one of them is worth stopping for. Muted rooms count by
                 * default — muting says "do not interrupt me", not "I was not
                 * called" — and the `mutedBadge` setting is the way out for
                 * anyone whose muted room is exactly the one spamming them.
                 */
                Box {
                    NeuIconButton(Icons.Rounded.AlternateEmail, "Mentions", onOpenMentions)
                    /*
                     * `mutedBadge` off excludes rooms this account has muted.
                     * Judged on the top-level row only — a muted channel inside
                     * an unmuted space is folded into the space's roll-up
                     * before any client sees it — which is the right precision:
                     * the person reaching for this switch is muting rooms, not
                     * single channels.
                     */
                    val countMuted = state.me?.notifications
                        ?.get("mutedBadge")?.jsonPrimitive?.booleanOrNull != false
                    val mentions = state.conversations.sumOf { conv ->
                        val muted = conv.self?.notificationLevel == "none" ||
                            (conv.self?.mutedUntil?.let { runCatching { java.time.Instant.parse(it) }.getOrNull() }
                                ?.isAfter(java.time.Instant.now()) == true)
                        if (muted && !countMuted) 0 else (conv.self?.mentionCount ?: 0)
                    }
                    if (mentions > 0) {
                        /*
                         * Tucked into the corner rather than sitting beyond it.
                         *
                         * A pill aligned to TopEnd hangs off the outside of the
                         * button and reads as a second object floating next to
                         * it. Offset back over the edge and given a ring of the
                         * surface it sits on, it reads as part of the button —
                         * a hole punched in the corner rather than a sticker
                         * stuck to it.
                         *
                         * The ring, not a border: a border would grow the pill,
                         * and this has to stay small enough that two digits do
                         * not swamp a 46dp button.
                         */
                        Box(
                            Modifier
                                .align(Alignment.TopEnd)
                                .offset(x = 3.dp, y = (-3).dp)
                                .clip(RoundedCornerShape(Neu.CornerPill))
                                .background(colors.surface)
                                .padding(2.dp),
                        ) {
                            // Yellow, like every mention marker: one colour
                            // means one thing across the whole app.
                            Box(
                                Modifier
                                    .defaultMinSize(minWidth = 16.dp, minHeight = 16.dp)
                                    .clip(RoundedCornerShape(Neu.CornerPill))
                                    .background(colors.mention)
                                    .padding(horizontal = 4.dp),
                                contentAlignment = Alignment.Center,
                            ) {
                                Text(
                                    if (mentions > 99) "99+" else mentions.toString(),
                                    style = MaterialTheme.typography.labelSmall.copy(
                                        fontSize = 10.sp,
                                        lineHeight = 10.sp,
                                    ),
                                    color = colors.onMention,
                                )
                            }
                        }
                    }
                }
                Spacer(Modifier.width(10.dp))
                NeuIconButton(Icons.Rounded.Explore, "Explore public groups", onExplore)
                Spacer(Modifier.width(10.dp))
                // Your own face is the door to settings — apps have profiles,
                // yappy has people.
                Box(Modifier.softClickable(onClick = onSettings)) {
                    Avatar(
                        url = state.me?.avatarUrl,
                        name = state.me?.displayName,
                        id = state.me?.id ?: "me",
                        size = 44.dp,
                        presence = "online",
                    )
                }
            }

            // The list filters as you type, so the keyboard's Search key has
            // nothing left to search — its job is to get out of the way.
            val keyboard = LocalSoftwareKeyboardController.current
            NeuTextField(
                value = state.query,
                onValueChange = vm::setQuery,
                placeholder = "Search",
                keyboardActions = KeyboardActions(onSearch = { keyboard?.hide() }),
                leading = {
                    Icon(Icons.Rounded.Search, null, tint = colors.textTertiary, modifier = Modifier.size(19.dp))
                },
                // A search field with something in it needs a way to empty
                // it that is not fourteen backspaces. Absent while empty, so
                // the field does not advertise a control with nothing to do.
                trailing = if (state.query.isNotEmpty()) ({
                    NeuIconButton(
                        Icons.Rounded.Close,
                        "Clear search",
                        { vm.setQuery("") },
                        size = 28.dp,
                        iconSize = 14.dp,
                        // At its drawn size: the 48dp reservation grew the
                        // field by 25dp the moment a letter was typed, and
                        // the list under it jumped with it.
                        reserveTarget = false,
                    )
                }) else null,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                shape = RoundedCornerShape(Neu.CornerPill),
                // Tracked for Back, which treats a lit field as a mode to
                // leave before it leaves the screen.
                onFocusChanged = { searchFocused = it.isFocused },
                modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp),
            )

            // ── Active now: friends online, one tap from a conversation ──────
            if (state.online.isNotEmpty() && !state.showArchived) {
                Spacer(Modifier.height(14.dp))
                LazyRow(
                    contentPadding = PaddingValues(horizontal = 20.dp),
                    horizontalArrangement = Arrangement.spacedBy(14.dp),
                ) {
                    items(state.online, key = { it.user.id }) { entry ->
                        Column(
                            horizontalAlignment = Alignment.CenterHorizontally,
                            modifier = Modifier.softClickable { vm.startDm(entry.user.id, onOpenChat) },
                        ) {
                            Avatar(
                                url = entry.user.avatarUrl,
                                name = entry.user.label,
                                id = entry.user.id,
                                size = 54.dp,
                                presence = entry.status,
                            )
                            Spacer(Modifier.height(4.dp))
                            Text(
                                entry.user.displayName?.substringBefore(' ') ?: entry.user.label,
                                style = MaterialTheme.typography.labelSmall,
                                color = colors.textSecondary,
                                maxLines = 1,
                            )
                        }
                    }
                }
            }

            Spacer(Modifier.height(12.dp))

            // Group-first, structurally: places are cards, people are rows.
            // The home screen argues the product's thesis.
            //
            // `visible` is a computed property — filter plus sort — and it was
            // being evaluated twice per recomposition, of which this screen has
            // many: every message, every presence change, every typing tick.
            // Once, remembered, split in a single pass.
            val (groups, dms) = remember(state.conversations, state.query) {
                state.visible.partition { it.type != "dm" }
            }

            /*
             * Pull to refresh, with the brand on the end of the string.
             *
             * The refresh existed — the gateway ran it on every reconnect —
             * but no gesture reached it, so the only way to make the list
             * re-ask was to kill the socket. The disc is the shared one the
             * places use: this screen drew its own, a size smaller and
             * winding a different angle, with a spin clock that ran whether
             * or not anything was fetching. One disc, one angle, and the
             * transition only exists while the fetch is out.
             */
            RefreshBox(
                refreshing = state.pulled,
                onRefresh = vm::refreshFromPull,
                underStatusBar = false,
                // The keyboard, when search summons it, must not sit on the
                // results it was summoned to filter.
                modifier = Modifier.weight(1f).fillMaxWidth().imePadding(),
            ) {
                /*
                 * A skeleton, and rarely.
                 *
                 * Loading used to be a full-screen spinner, which is the
                 * screen admitting it has nothing — and on a cold start it
                 * usually did, because the disk snapshot was never read. Now
                 * the snapshot paints first, and the skeleton is only for the
                 * account that has never loaded, or the moment of crossing
                 * into the archive, where the skeleton is the shape of the
                 * thing about to arrive.
                 */
                Crossfade(
                    targetState = state.loading || state.switching,
                    label = "home-veil",
                ) { veiled ->
                    when {
                        veiled -> SkeletonList()

                        // A failed fetch used to fall through to "Nobody here
                        // yet" — the emptiest screen in the app, shown to
                        // somebody with forty chats and no signal.
                        state.error != null && state.conversations.isEmpty() -> ErrorState(
                            message = state.error,
                            // Not load(): that cleared the error with nothing
                            // drawn behind it, and the Crossfade fell through
                            // to "Nobody here yet" until the answer came.
                            onRetry = vm::retry,
                        )

                        // Server results count as results: "Nothing matches that" over
                        // a list of matching messages was reachable before, because
                        // the emptiness check only looked at conversation rows.
                        groups.isEmpty() && dms.isEmpty() &&
                            state.searchHits.isEmpty() && state.searchPeople.isEmpty() -> EmptyState(
                            archived = state.showArchived,
                            searching = state.query.isNotBlank(),
                        )

                        else -> LazyColumn(
                            state = listState,
                            // Enough for the FAB to clear the last row, then
                            // the bar, whatever the bar is on this phone.
                            contentPadding = PaddingValues(start = 12.dp, end = 12.dp, bottom = 102.dp + navBottom),
                            verticalArrangement = Arrangement.spacedBy(2.dp),
                        ) {
                            if (groups.isNotEmpty()) {
                                // Sticky, on the sheet colour, so the label
                                // names what is scrolling under it instead
                                // of leaving with the first card.
                                stickyHeader(key = "places-label") {
                                    Box(Modifier.fillMaxWidth().background(colors.surface)) {
                                        SectionLabel("Places", Modifier.padding(start = 12.dp, top = 4.dp))
                                    }
                                }
                                // contentType lets a scrolled-out card's slot be reused
                                // for the next card rather than composed fresh — cards
                                // and flat people-rows are different shapes.
                                items(groups, key = { it.id }, contentType = { "card" }) { conversation ->
                                    Box(Modifier.animateItem().padding(vertical = 5.dp)) {
                                        SwipeRow(
                                            pinned = conversation.self?.isPinned == true,
                                            onPin = { vm.togglePin(conversation) },
                                            onArchive = { archiveWithUndo(conversation) },
                                        ) {
                                            ConversationRow(
                                                conversation = conversation,
                                                isTyping = state.isTyping(conversation.id),
                                                asCard = true,
                                                minute = minute,
                                                onClick = {
                                                    if (conversation.isSpace) onOpenSpace(conversation.id)
                                                    else onOpenChat(conversation.id)
                                                },
                                                onLongClick = { sheetFor = conversation },
                                            )
                                        }
                                    }
                                }
                            }

                            if (dms.isNotEmpty()) {
                                stickyHeader(key = "people-label") {
                                    Box(Modifier.fillMaxWidth().background(colors.surface)) {
                                        SectionLabel(
                                            "People",
                                            Modifier.padding(start = 12.dp, top = if (groups.isEmpty()) 4.dp else 14.dp),
                                        )
                                    }
                                }
                                items(dms, key = { it.id }, contentType = { "row" }) { conversation ->
                                    Box(Modifier.animateItem()) {
                                        SwipeRow(
                                            pinned = conversation.self?.isPinned == true,
                                            onPin = { vm.togglePin(conversation) },
                                            onArchive = { archiveWithUndo(conversation) },
                                        ) {
                                            ConversationRow(
                                                conversation = conversation,
                                                isTyping = state.isTyping(conversation.id),
                                                asCard = false,
                                                minute = minute,
                                                onClick = { onOpenChat(conversation.id) },
                                                onLongClick = { sheetFor = conversation },
                                            )
                                        }
                                    }
                                }
                            }

                            /**
                             * No places yet, on a screen whose whole argument is that
                             * places are the product.
                             *
                             * The empty state below only fires at *zero* rows, so an
                             * account with one bot DM and no groups got a single row
                             * and then a screen of nothing — the emptiest surface in
                             * the app was the one that should be selling hardest.
                             * Hidden while searching, where a prompt to start a group
                             * is an answer to a question nobody asked.
                             */
                            if (groups.isEmpty() && !state.showArchived && state.query.isBlank() && !starterDismissed) {
                                item(key = "start-here") {
                                    StarterCard(
                                        onNewGroup = onNewChat,
                                        onExplore = onExplore,
                                        onDismiss = {
                                            starterDismissed = true
                                            scope.launch { container.session.setDismissedStarter() }
                                        },
                                        modifier = Modifier.padding(top = if (dms.isEmpty()) 4.dp else 18.dp),
                                    )
                                }
                            }

                            // People on yappy who match — the half of search the local
                            // filter can never answer, since it only sees your own list.
                            if (state.query.isNotBlank() && state.searchPeople.isNotEmpty()) {
                                item(key = "people-search-header") {
                                    SectionLabel(
                                        "People on yappy",
                                        Modifier.padding(start = 12.dp, top = 16.dp),
                                    )
                                }
                                items(state.searchPeople, key = { "person-${it.id}" }) { person ->
                                    Row(
                                        Modifier
                                            .fillMaxWidth()
                                            .clip(RoundedCornerShape(Neu.CornerSmall))
                                            .softClickable { onOpenProfile(person.id) }
                                            .padding(horizontal = 10.dp, vertical = 8.dp),
                                        verticalAlignment = Alignment.CenterVertically,
                                    ) {
                                        Avatar(person.avatarUrl, person.displayName, person.id, size = 40.dp)
                                        Spacer(Modifier.width(12.dp))
                                        Column(Modifier.weight(1f)) {
                                            Row(verticalAlignment = Alignment.CenterVertically) {
                                                Text(
                                                    person.displayName ?: person.username ?: "Someone",
                                                    style = MaterialTheme.typography.titleSmall,
                                                    color = colors.textPrimary,
                                                    maxLines = 1,
                                                    overflow = TextOverflow.Ellipsis,
                                                )
                                                if (person.badge != null || person.affiliation != null) {
                                                    Spacer(Modifier.width(5.dp))
                                                    IdentityMarks(person, size = 13.dp)
                                                }
                                            }
                                            person.username?.let {
                                                Text(
                                                    "@$it",
                                                    style = MaterialTheme.typography.labelSmall,
                                                    color = colors.textTertiary,
                                                )
                                            }
                                        }
                                    }
                                }
                            }

                            // Server-side message search under the local filter results.
                            if (state.query.isNotBlank() && state.searchHits.isNotEmpty()) {
                                item(key = "search-header") {
                                    SectionLabel(
                                        "Messages",
                                        Modifier.padding(start = 12.dp, top = 16.dp),
                                    )
                                }
                                items(state.searchHits, key = { "hit-${it.messageId}" }) { hit ->
                                    val conv = state.conversations.find { it.id == hit.conversationId }
                                    Row(
                                        Modifier
                                            .fillMaxWidth()
                                            .clip(RoundedCornerShape(Neu.CornerSmall))
                                            .softClickable { onOpenChat(hit.conversationId) }
                                            .padding(horizontal = 10.dp, vertical = 8.dp),
                                        verticalAlignment = Alignment.CenterVertically,
                                    ) {
                                        Column(Modifier.weight(1f)) {
                                            Text(
                                                conv?.displayName ?: "Conversation",
                                                style = MaterialTheme.typography.labelMedium,
                                                color = colors.textTertiary,
                                            )
                                            Text(
                                                snippetStyled(hit.snippet, colors.accent),
                                                style = MaterialTheme.typography.bodyMedium,
                                                color = colors.textPrimary,
                                                maxLines = 2,
                                                overflow = TextOverflow.Ellipsis,
                                            )
                                        }
                                        Spacer(Modifier.width(8.dp))
                                        Text(
                                            remember(minute, hit.createdAt) { relativeTime(hit.createdAt) },
                                            style = MaterialTheme.typography.labelSmall,
                                            color = colors.textTertiary,
                                        )
                                    }
                                }
                            }

                            /*
                             * Archived, at the foot of the list rather than as a
                             * fourth circle in the header.
                             *
                             * It is the one of the four you press least — a place
                             * you put things to stop thinking about them is not a
                             * place you visit often — and it was competing for the
                             * eye with the three that matter. This is also where the
                             * web has always kept it.
                             *
                             * Hidden while searching: a filtered list has an end
                             * that means something else. Hidden inside the archive
                             * too — the header already announces the mode and
                             * offers the way out, and two exits to one room is a
                             * room that looks unsure of itself.
                             */
                            if (state.query.isBlank() && !state.showArchived) {
                                item(key = "archived-foot") {
                                    Row(
                                        Modifier
                                            .fillMaxWidth()
                                            .padding(top = 18.dp)
                                            .clip(RoundedCornerShape(Neu.CornerMedium))
                                            .softClickable(onClick = vm::toggleArchived)
                                            .padding(horizontal = 12.dp, vertical = 12.dp),
                                        verticalAlignment = Alignment.CenterVertically,
                                    ) {
                                        Icon(
                                            Icons.Rounded.Archive,
                                            null,
                                            tint = colors.textTertiary,
                                            modifier = Modifier.size(18.dp),
                                        )
                                        Spacer(Modifier.width(10.dp))
                                        Text(
                                            "Archived",
                                            style = MaterialTheme.typography.titleSmall,
                                            color = colors.textSecondary,
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // The shell measures its snackbar; the button lifts out from under it
        // by that much, the way Material's scaffold lifts a FAB. Without this
        // an "Archived · Undo" sat across the lower half of the button, and
        // a tap meant for New chat landed on Undo. Measured rather than
        // guessed, so a two-line message lifts it further, and it stays up
        // through the pill's exit fade. A spring so it glides rather than
        // jumps — but a critically damped one: the first cut bounced, and
        // on the way back down the overshoot took the lift below zero, which
        // padding refuses with a crash. The floor is belt and braces for the
        // same reason.
        val fabLift by animateDpAsState(
            targetValue = LocalSnackbarClearance.current,
            animationSpec = spring(stiffness = Spring.StiffnessMediumLow, dampingRatio = Spring.DampingRatioNoBouncy),
            label = "fab-snackbar-lift",
        )
        NeuIconButton(
            icon = Icons.Rounded.Add,
            contentDescription = "New chat",
            onClick = onNewChat,
            accent = true,
            size = 62.dp,
            iconSize = 27.dp,
            modifier = Modifier
                .align(Alignment.BottomEnd)
                .navigationBarsPadding()
                .padding(bottom = fabLift.coerceAtLeast(0.dp))
                .padding(end = 22.dp, bottom = 20.dp),
        )
    }

    sheetFor?.let { conversation ->
        ConversationSheet(
            conversation = conversation,
            showArchived = state.showArchived,
            onDismiss = { sheetFor = null },
            onMarkRead = { vm.markRead(conversation) },
            onPin = { vm.togglePin(conversation) },
            onUnmute = {
                muteWithUndo(conversation, "Unmuted ${conversation.displayName}") { vm.toggleMute(conversation) }
            },
            onMuteFor = { duration ->
                val label = when {
                    duration == null -> "Muted ${conversation.displayName}"
                    // Plural agrees with the pill that was tapped: "1 hour"
                    // used to come back as "Muted for 1 hours".
                    duration.toHours() >= 1 -> {
                        val h = duration.toHours()
                        "Muted for $h ${if (h == 1L) "hour" else "hours"}"
                    }
                    else -> {
                        val m = duration.toMinutes()
                        "Muted for $m ${if (m == 1L) "minute" else "minutes"}"
                    }
                }
                muteWithUndo(conversation, label) {
                    if (duration == null) vm.toggleMute(conversation) else vm.muteFor(conversation, duration)
                }
            },
            onOpenGroup = onOpenGroup?.let { open -> { open(conversation.id) } },
            onViewProfile = conversation.otherUser?.id?.let { id -> { onOpenProfile(id) } },
            onCopyLink = {
                scope.launch {
                    val url = runCatching {
                        container.repo.invites(conversation.id).invites.firstOrNull()?.url
                    }.getOrNull()
                    if (url != null) clipboard.setText(AnnotatedString(url))
                    snackbar.showSnackbar(
                        if (url != null) "Link copied" else "No invite link yet — make one in group settings",
                        duration = SnackbarDuration.Short,
                    )
                }
            },
            onArchive = { archiveWithUndo(conversation) },
            onLeave = { vm.leave(conversation) },
        )
    }
}

/**
 * The row's long-press menu, as the sheet the rest of the app uses.
 *
 * This was a DropdownMenu anchored to the row's top-left corner — three
 * words in a floating panel, in a place the thumb was not. The message
 * action sheet already established the pattern: a header saying what is
 * being acted on, then rows, with the dangerous one last.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
private fun ConversationSheet(
    conversation: Conversation,
    showArchived: Boolean,
    onDismiss: () -> Unit,
    onMarkRead: () -> Unit,
    onPin: () -> Unit,
    onUnmute: () -> Unit,
    /** Null duration means until it is turned back on. */
    onMuteFor: (java.time.Duration?) -> Unit,
    onOpenGroup: (() -> Unit)?,
    onViewProfile: (() -> Unit)?,
    onCopyLink: () -> Unit,
    onArchive: () -> Unit,
    onLeave: () -> Unit,
) {
    val colors = neuColors
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    val isDm = conversation.type == "dm"

    // Leaving has no undo, so the row asks twice — the same "tap again"
    // the group settings use for converting to a space.
    var leaveArmed by remember(conversation.id) { mutableStateOf(false) }

    // Dismiss first, act second: the snackbar an action raises should land
    // on the screen, not under a sheet on its way out.
    fun act(action: () -> Unit) {
        onDismiss()
        action()
    }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = colors.surface,
        contentColor = colors.textPrimary,
    ) {
        Column(Modifier.padding(horizontal = 16.dp).padding(bottom = 28.dp)) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.padding(horizontal = 6.dp, vertical = 4.dp),
            ) {
                FlairAvatar(
                    appearance = conversation.appearance,
                    url = conversation.displayAvatar,
                    name = conversation.displayName,
                    id = conversation.avatarSeed,
                    size = 48.dp,
                    shape = if (isDm) CircleShape else PlaceShape,
                )
                Spacer(Modifier.width(13.dp))
                Column(Modifier.weight(1f)) {
                    Text(
                        conversation.displayName,
                        style = MaterialTheme.typography.titleMedium,
                        color = colors.textPrimary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        if (isDm) conversation.otherUser?.username?.let { "@$it" } ?: "Direct message"
                        else memberCount(conversation.memberCount),
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.textTertiary,
                    )
                }
            }
            Spacer(Modifier.height(8.dp))

            if (conversation.unread > 0) {
                ActionRow(Icons.Rounded.DoneAll, "Mark as read") { act(onMarkRead) }
            }
            ActionRow(
                Icons.Rounded.PushPin,
                if (conversation.self?.isPinned == true) "Unpin" else "Pin to top",
            ) { act(onPin) }

            if (conversation.isMuted) {
                ActionRow(Icons.Rounded.Notifications, "Unmute") { act(onUnmute) }
            } else {
                // Three durations rather than one switch, because "quiet for
                // the evening" and "quiet forever" are different wishes and
                // a toggle can only grant the second.
                Row(
                    Modifier.fillMaxWidth().padding(vertical = 10.dp, horizontal = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        Icons.Rounded.NotificationsOff,
                        null,
                        tint = colors.textSecondary,
                        modifier = Modifier.size(19.dp),
                    )
                    Spacer(Modifier.width(14.dp))
                    Text("Mute", style = MaterialTheme.typography.bodyLarge, color = colors.textPrimary)
                }
                // Pills, not chips. NeuChip is a choice that stays on screen
                // and says so to the reader — "radio button, not selected" —
                // but these are three doors out of the sheet, each a single
                // tap that closes it. A button is what they are.
                //
                // Wraps rather than squeezes — the same reason the composer's
                // attach chips are a FlowRow: a plain Row hands the last pill
                // whatever width is left, and one font-size notch up on a
                // 360dp phone broke "Until I turn it on" across two lines
                // inside a pill taller than its siblings.
                FlowRow(
                    Modifier.padding(start = 39.dp, bottom = 6.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    MutePill("1 hour") { act { onMuteFor(java.time.Duration.ofHours(1)) } }
                    MutePill("8 hours") { act { onMuteFor(java.time.Duration.ofHours(8)) } }
                    MutePill("Until I turn it on") { act { onMuteFor(null) } }
                }
            }

            if (isDm) {
                onViewProfile?.let { ActionRow(Icons.Rounded.Person, "View profile") { act(it) } }
            } else {
                onOpenGroup?.let { ActionRow(Icons.Rounded.Info, "Group info") { act(it) } }
                if (conversation.isPublic) {
                    ActionRow(Icons.Rounded.Link, "Copy invite link") { act(onCopyLink) }
                }
            }

            ActionRow(
                if (showArchived) Icons.Rounded.Unarchive else Icons.Rounded.Archive,
                if (showArchived) "Restore" else "Archive",
            ) { act(onArchive) }

            if (!isDm) {
                ActionRow(
                    Icons.AutoMirrored.Rounded.Logout,
                    if (leaveArmed) "Tap again to leave" else "Leave",
                    danger = true,
                ) {
                    if (leaveArmed) act(onLeave) else leaveArmed = true
                }
            }

            // Debug builds only, and one-to-one only. It lives on the row
            // rather than in Settings because it is a property of one
            // conversation — and it is absent on a group because the fan-out
            // only knows how to find the other person in a DM. Offered there,
            // it would seal to nobody but your own devices and post a message
            // the rest of the room could never read.
            if (BuildConfig.DEBUG && isDm) {
                val container = LocalContainer.current
                var privateMode by remember(conversation.id) { mutableStateOf(false) }
                LaunchedEffect(conversation.id) {
                    privateMode = container.e2e.isPrivate(conversation.id)
                }
                ActionRow(
                    Icons.Rounded.Lock,
                    if (privateMode) "Stop encrypting (dev)" else "Encrypt new messages (dev)",
                ) {
                    onDismiss()
                    scope.launch {
                        container.e2e.setPrivate(conversation.id, !privateMode)
                        privateMode = !privateMode
                    }
                }
            }
        }
    }
}

/**
 * A mute duration: the chip's pill and type, on a plain button. Built on
 * `clickable` rather than `selectable` on purpose — a selected-state
 * semantics node is announced as checkable whatever role it is given, and
 * "not selected" is a lie about a control that fires once and is gone.
 */
@Composable
private fun MutePill(label: String, onClick: () -> Unit) {
    val colors = neuColors
    val shape = RoundedCornerShape(Neu.CornerPill)
    Box(
        Modifier
            .neu(shape, colors, NeuState.Raised, 5.dp)
            .clip(shape)
            .softClickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 8.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label,
            style = MaterialTheme.typography.labelMedium,
            color = colors.textSecondary,
            // A pill is its single-line width, never taller than the one
            // beside it; the row above wraps whole pills instead.
            softWrap = false,
            maxLines = 1,
        )
    }
}

/** "1 member", not "1 members". The plural lives here until strings.xml does. */
private fun memberCount(n: Int): String = if (n == 1) "1 member" else "$n members"

@Composable
private fun ConversationRow(
    conversation: Conversation,
    isTyping: Boolean,
    asCard: Boolean,
    /** The screen's minute tick; only read so the label re-derives on it. */
    minute: Long,
    onClick: () -> Unit,
    onLongClick: () -> Unit,
) {
    val colors = neuColors
    val unread = conversation.unread

    // Places are raised cards — they are the few raised elements the "few
    // raised elements" rule budgets for. People stay flat rows.
    NeuSurface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(Neu.CornerMedium),
        state = if (asCard) NeuState.Raised else NeuState.Flat,
        elevation = if (asCard) 5.dp else 0.dp,
        contentPadding = if (asCard) 14.dp else 12.dp,
        onClick = onClick,
        onLongClick = onLongClick,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            /*
             * The pet lives on the door, not in the title.
             *
             * It sat fifth in the title row's line of ornaments, 22dp tall,
             * after the badge, the emoji and the public glyph — the product
             * bet, filed as decoration. Peeking from the corner of the
             * squircle inside a ring of the sheet, it reads the way a
             * presence dot does on a face: something alive about this place.
             */
            Box(contentAlignment = Alignment.BottomEnd) {
                FlairAvatar(
                    appearance = conversation.appearance,
                    url = conversation.displayAvatar,
                    name = conversation.displayName,
                    id = conversation.avatarSeed,
                    size = if (asCard) 54.dp else 48.dp,
                    shape = if (asCard) PlaceShape else CircleShape,
                )
                conversation.pet?.let { pet ->
                    Box(
                        Modifier
                            .offset(x = 5.dp, y = 5.dp)
                            .background(colors.surface, CircleShape)
                            .padding(2.dp),
                    ) {
                        // One voice: the pet describes itself, in the
                        // app's own words ("Mochi, kid, peckish"). The ring
                        // used to carry a second description in the raw
                        // enum vocabulary, so the reader heard the pip twice
                        // and differently.
                        PixelPet(
                            conversationId = conversation.id,
                            stage = pet.stage,
                            mood = pet.mood,
                            size = 24.dp,
                            contentDescription = petDescription(pet.stage, pet.mood, pet.name),
                        )
                    }
                }
            }

            Spacer(Modifier.width(13.dp))

            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        conversation.displayName,
                        style = MaterialTheme.typography.titleMedium.copy(
                            fontWeight = if (unread > 0) FontWeight.Bold else FontWeight.SemiBold,
                        ),
                        color = conversation.appearance?.titleColor() ?: colors.textPrimary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                    // A DM row shows the *person's* marks; a group row shows
                    // the group's own. Same slot either way, because the
                    // row is always answering "who is this".
                    if (conversation.type == "dm") {
                        conversation.otherUser?.let { other ->
                            if (other.badge != null || other.affiliation != null) {
                                Spacer(Modifier.width(5.dp))
                                IdentityMarks(other, size = 14.dp)
                            }
                        }
                    } else if (conversation.badge != null) {
                        Spacer(Modifier.width(5.dp))
                        BadgeMark(conversation.badge, size = 14.dp)
                    }
                    conversation.appearance?.emoji?.let {
                        Spacer(Modifier.width(5.dp))
                        Text(it, style = MaterialTheme.typography.titleSmall)
                    }
                    if (conversation.isPublic) {
                        Spacer(Modifier.width(6.dp))
                        Icon(
                            Icons.Rounded.Public,
                            "Public group",
                            tint = conversation.appearance?.titleColor() ?: colors.textTertiary,
                            modifier = Modifier.size(13.dp),
                        )
                    }
                    /*
                     * The pulse moved down to the subtitle.
                     *
                     * As a tinted pill beside the title it appeared on
                     * every card at once — and a signal that is always
                     * on is not a signal, it is a texture. Worse, it sat
                     * in the title line, so seven of them read as seven
                     * things demanding attention when the usual count is
                     * one, and the one is you.
                     */
                    // A campfire announces its own end. On the card, not
                    // just inside the chat — a place that is burning down
                    // should look different from one that will keep.
                    conversation.endsAt?.let { ends ->
                        val remaining = remember(ends, minute) {
                            runCatching {
                                java.time.Duration.between(
                                    java.time.Instant.now(),
                                    java.time.Instant.parse(ends),
                                )
                            }.getOrNull()
                        }
                        if (remaining != null && !remaining.isNegative) {
                            val urgent = remaining.toHours() < 1
                            val label = when {
                                remaining.toDays() >= 1 -> "${remaining.toDays()}d"
                                remaining.toHours() >= 1 -> "${remaining.toHours()}h"
                                else -> "${maxOf(remaining.toMinutes(), 1)}m"
                            }
                            Spacer(Modifier.width(7.dp))
                            Row(
                                Modifier
                                    .clip(RoundedCornerShape(Neu.CornerPill))
                                    .background(
                                        (if (urgent) colors.danger else colors.warning)
                                            .copy(alpha = 0.14f),
                                    )
                                    .padding(horizontal = 7.dp, vertical = 2.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                // A drawn flame, tinted like the label:
                                // emoji is content on this sheet, never
                                // chrome, and a glyph the platform colours
                                // for us cannot say "urgent" in our red.
                                Icon(
                                    Icons.Rounded.LocalFireDepartment,
                                    null,
                                    tint = if (urgent) colors.danger else colors.warning,
                                    modifier = Modifier.size(12.dp),
                                )
                                Spacer(Modifier.width(3.dp))
                                Text(
                                    label,
                                    style = MaterialTheme.typography.labelSmall,
                                    color = if (urgent) colors.danger else colors.warning,
                                )
                            }
                        }
                    }
                }

                if (asCard) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            memberCount(conversation.memberCount),
                            style = MaterialTheme.typography.labelSmall,
                            color = colors.textTertiary,
                        )
                        // Still green, still a dot, just no longer
                        // shouting from the title line.
                        if (conversation.hereCount > 0 && conversation.type != "dm") {
                            Spacer(Modifier.width(6.dp))
                            Box(
                                Modifier
                                    .size(5.dp)
                                    .background(colors.success, CircleShape),
                            )
                            Spacer(Modifier.width(4.dp))
                            Text(
                                "${conversation.hereCount} here",
                                style = MaterialTheme.typography.labelSmall,
                                color = colors.success,
                            )
                        }
                    }
                }

                Spacer(Modifier.height(3.dp))

                /*
                 * The pet's complaint takes the subtitle when there is
                 * nothing newer to say. Only a quiet card — no unread,
                 * nobody typing — because "Peckish" over an unread message
                 * would be the pet talking over a person. Warning, not
                 * danger: the group is not in trouble, the pet is hungry.
                 */
                val moodLine = conversation.pet
                    ?.takeIf { asCard && unread == 0 && it.mood != "happy" }
                    ?.let { pet ->
                        when (pet.mood) {
                            "hungry" -> "Peckish — say something"
                            "sad" -> "Lonely — it has been quiet in here"
                            "gone" -> "Wandered off — talk and it comes back"
                            else -> null
                        }
                    }
                when {
                    isTyping -> Text(
                        "typing…",
                        style = MaterialTheme.typography.bodyMedium.copy(fontStyle = FontStyle.Italic),
                        color = colors.accent,
                    )
                    moodLine != null -> Text(
                        moodLine,
                        style = MaterialTheme.typography.bodyMedium,
                        color = colors.warning,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    else -> Text(
                        conversation.lastMessage?.preview ?: "No messages yet",
                        style = MaterialTheme.typography.bodyMedium,
                        color = if (unread > 0) colors.textSecondary else colors.textTertiary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }

            Spacer(Modifier.width(10.dp))

            Column(horizontalAlignment = Alignment.End) {
                Text(
                    remember(minute, conversation.lastMessageAt) { relativeTime(conversation.lastMessageAt) },
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.textTertiary,
                )
                // Pinned and muted are facts about *your* relationship to the
                // room, so they sit in your column with the time, not in the
                // title line among the room's own marks.
                val pinned = conversation.self?.isPinned == true
                if (pinned || conversation.isMuted) {
                    Spacer(Modifier.height(4.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        if (pinned) {
                            Icon(
                                Icons.Rounded.PushPin,
                                "Pinned",
                                tint = colors.textTertiary,
                                modifier = Modifier.size(12.dp),
                            )
                        }
                        if (conversation.isMuted) {
                            Icon(
                                Icons.Rounded.NotificationsOff,
                                "Muted",
                                tint = colors.textTertiary,
                                modifier = Modifier.size(12.dp),
                            )
                        }
                    }
                }
                Spacer(Modifier.height(6.dp))
                /*
                 * One badge, not two.
                 *
                 * This drew a bare red @ circle *beside* the violet count
                 * — two mismatched shapes crowding one corner, with red
                 * borrowing the alarm register for the most ordinary
                 * reason to open the app. Mentions outrank a plain unread
                 * count, so when there are any the one badge is theirs:
                 * "@4" in the brand yellow. Otherwise the unread count in
                 * the accent, as before.
                 */
                val cardMentions = conversation.self?.mentionCount ?: 0
                if (cardMentions > 0) {
                    Box(
                        Modifier
                            .clip(RoundedCornerShape(Neu.CornerPill))
                            .background(colors.mention)
                            .padding(horizontal = 7.dp, vertical = 3.dp),
                    ) {
                        Text(
                            "@" + (if (cardMentions > 99) "99+" else cardMentions.toString()),
                            style = MaterialTheme.typography.labelSmall,
                            color = colors.onMention,
                        )
                    }
                } else if (unread > 0) {
                    Box(
                        Modifier
                            .clip(CircleShape)
                            .background(colors.accent)
                            .padding(horizontal = if (unread > 9) 7.dp else 8.dp, vertical = 3.dp),
                    ) {
                        Text(
                            if (unread > 99) "99+" else unread.toString(),
                            style = MaterialTheme.typography.labelSmall,
                            color = colors.onAccent,
                        )
                    }
                }
                if (conversation.activeCall != null) {
                    Spacer(Modifier.height(5.dp))
                    Row(
                        Modifier
                            .clip(RoundedCornerShape(Neu.CornerPill))
                            .background(colors.success.copy(alpha = 0.16f))
                            .padding(horizontal = 7.dp, vertical = 2.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(
                            Icons.Rounded.Call,
                            null,
                            tint = colors.success,
                            modifier = Modifier.size(10.dp),
                        )
                        Spacer(Modifier.width(3.dp))
                        Text("Live", style = MaterialTheme.typography.labelSmall, color = colors.success)
                    }
                }
            }
        }
    }
}

/** Postgres ts_headline marks matches with <em> tags; render them as accents. */
private fun snippetStyled(snippet: String, highlight: Color) =
    androidx.compose.ui.text.buildAnnotatedString {
        var rest = snippet
        while (true) {
            val start = rest.indexOf("<em>")
            if (start < 0) { append(rest); break }
            append(rest.substring(0, start))
            val end = rest.indexOf("</em>", start)
            if (end < 0) { append(rest.substring(start + 4)); break }
            withStyle(
                androidx.compose.ui.text.SpanStyle(color = highlight, fontWeight = FontWeight.SemiBold),
            ) { append(rest.substring(start + 4, end)) }
            rest = rest.substring(end + 5)
        }
    }

/**
 * A full-height, centred panel that still counts as scrollable.
 *
 * The empty and error states have nothing to scroll, but they sit inside
 * the pull-to-refresh box and a pull on "No connection" is the most natural
 * retry there is. A plain Box would swallow the gesture; a scroll container
 * with no travel passes every pixel of it up to the box. Sized to the
 * viewport explicitly because a scroll container measures its child with
 * unbounded height, which is how "centre this" quietly becomes "top-align
 * this". The bar inset comes off the inside so the centre is the centre of
 * the safe area, not of the window.
 */
@Composable
private fun CentredPanel(content: @Composable () -> Unit) {
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val viewport = maxHeight
        Box(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .height(viewport)
                .navigationBarsPadding(),
            contentAlignment = Alignment.Center,
        ) { content() }
    }
}

@Composable
private fun EmptyState(archived: Boolean, searching: Boolean) {
    val colors = neuColors
    CentredPanel {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier.padding(40.dp),
        ) {
            Box(
                Modifier
                    .size(88.dp)
                    .neu(CircleShape, colors, NeuState.Pressed, 8.dp),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    if (archived) Icons.Rounded.Archive else Icons.Rounded.Add,
                    null,
                    tint = colors.textTertiary,
                    modifier = Modifier.size(34.dp),
                )
            }
            Spacer(Modifier.height(18.dp))
            Text(
                when {
                    searching -> "Nothing matches that"
                    archived -> "No archived chats"
                    else -> "Nobody here yet"
                },
                style = MaterialTheme.typography.titleMedium,
                color = colors.textSecondary,
            )
            Spacer(Modifier.height(6.dp))
            Text(
                when {
                    searching -> "Try a different search."
                    archived -> "Chats you archive will show up here."
                    // Not "start a conversation" — with whom? Somebody who has
                    // just arrived knows nobody here, so the one action the
                    // screen used to offer was the one they could not take.
                    else -> "Make a group and send the link to your friends. Tap +, or ask @yapper."
                },
                style = MaterialTheme.typography.bodyMedium,
                color = colors.textTertiary,
            )
        }
    }
}

/**
 * The honest version of a failed first fetch. Same dish as the empty state,
 * so the two read as siblings, but the glyph says "no signal" and the
 * button says what to do about it.
 */
@Composable
private fun ErrorState(message: String?, onRetry: () -> Unit) {
    val colors = neuColors
    CentredPanel {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier.padding(40.dp),
        ) {
            Box(
                Modifier
                    .size(88.dp)
                    .neu(CircleShape, colors, NeuState.Pressed, 8.dp),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    Icons.Rounded.CloudOff,
                    null,
                    tint = colors.textTertiary,
                    modifier = Modifier.size(34.dp),
                )
            }
            Spacer(Modifier.height(18.dp))
            Text(
                "Couldn't load your chats",
                style = MaterialTheme.typography.titleMedium,
                color = colors.textSecondary,
            )
            Spacer(Modifier.height(6.dp))
            Text(
                message?.takeIf { it.isNotBlank() } ?: "Check your connection and try again.",
                style = MaterialTheme.typography.bodyMedium,
                color = colors.textTertiary,
                textAlign = androidx.compose.ui.text.style.TextAlign.Center,
            )
            Spacer(Modifier.height(20.dp))
            NeuButton(onClick = onRetry) {
                Text(
                    "Try again",
                    style = MaterialTheme.typography.labelLarge,
                    color = colors.textPrimary,
                )
            }
        }
    }
}

/**
 * The shape of the list before the list.
 *
 * Three card-sized veils breathing in step, under a label-sized bar, laid
 * out on the same gutters as the real cards so the first real frame lands
 * where the eye already is. Flat surfaces filled with the veil tint rather
 * than raised ones: a skeleton that casts shadows is a skeleton claiming to
 * be furniture. The pulse is read in the draw phase, so nothing recomposes
 * while it breathes.
 */
@Composable
private fun SkeletonList() {
    val colors = neuColors
    val pulse = rememberInfiniteTransition(label = "skeleton").animateFloat(
        initialValue = 0.45f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(900, easing = LinearEasing), RepeatMode.Reverse),
        label = "skeleton-alpha",
    )
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp)
            .graphicsLayer { alpha = pulse.value },
    ) {
        SkeletonBar(width = 52.dp, height = 11.dp, modifier = Modifier.padding(start = 18.dp, top = 4.dp, bottom = 8.dp))
        repeat(3) {
            NeuSurface(
                modifier = Modifier.fillMaxWidth().padding(vertical = 5.dp),
                shape = RoundedCornerShape(Neu.CornerMedium),
                state = NeuState.Flat,
                fill = colors.veil,
                contentPadding = 14.dp,
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(54.dp).background(colors.veil, PlaceShape))
                    Spacer(Modifier.width(13.dp))
                    Column {
                        SkeletonBar(width = 140.dp, height = 14.dp)
                        Spacer(Modifier.height(8.dp))
                        SkeletonBar(width = 72.dp, height = 10.dp)
                        Spacer(Modifier.height(8.dp))
                        SkeletonBar(width = 200.dp, height = 12.dp)
                    }
                }
            }
        }
    }
}

@Composable
private fun SkeletonBar(width: Dp, height: Dp, modifier: Modifier = Modifier) {
    Box(
        modifier
            .size(width = width, height = height)
            .background(neuColors.veil, RoundedCornerShape(Neu.CornerPill)),
    )
}

/**
 * The nudge for an account with no places yet.
 *
 * Two doors rather than one, because "start a group" only helps someone who
 * already has people to put in it. Anyone arriving alone needs somewhere that
 * is already warm, which is what Explore is for.
 */
@Composable
private fun StarterCard(
    onNewGroup: () -> Unit,
    onExplore: () -> Unit,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = neuColors

    NeuSurface(
        modifier = modifier.fillMaxWidth().padding(horizontal = 4.dp),
        shape = RoundedCornerShape(Neu.CornerLarge),
        contentPadding = 18.dp,
    ) {
        Column {
            Row(verticalAlignment = Alignment.Top) {
                Column(Modifier.weight(1f)) {
                    Text(
                        "Places are the point",
                        style = MaterialTheme.typography.titleMedium,
                        color = colors.textPrimary,
                    )
                    Spacer(Modifier.height(4.dp))
                    Text(
                        "A group in yappy is somewhere you go, not a thread you scroll. " +
                            "It keeps its own pins, photos and whoever is around right now.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = colors.textTertiary,
                    )
                }
                // An argument you cannot put down is a lecture. It has been
                // read by the time it is in the way, and it does not come back.
                Spacer(Modifier.width(8.dp))
                NeuIconButton(
                    Icons.Rounded.Close,
                    "Dismiss",
                    onDismiss,
                    size = 30.dp,
                    iconSize = 15.dp,
                )
            }
            Spacer(Modifier.height(16.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                NeuButton(
                    onClick = onNewGroup,
                    accent = true,
                    modifier = Modifier.weight(1f),
                ) {
                    Text(
                        "Start a group",
                        style = MaterialTheme.typography.labelLarge,
                        color = colors.onAccent,
                    )
                }
                NeuButton(
                    onClick = onExplore,
                    modifier = Modifier.weight(1f),
                ) {
                    Text(
                        "Explore",
                        style = MaterialTheme.typography.labelLarge,
                        color = colors.textPrimary,
                    )
                }
            }
        }
    }
}
