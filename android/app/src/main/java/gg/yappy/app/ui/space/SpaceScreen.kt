package gg.yappy.app.ui.space

import androidx.compose.material.icons.rounded.PushPin
import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.rounded.List
import androidx.compose.material.icons.automirrored.rounded.VolumeUp
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.AlternateEmail
import androidx.compose.material.icons.rounded.Campaign
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Delete
import androidx.compose.material.icons.rounded.Edit
import androidx.compose.material.icons.rounded.KeyboardArrowDown
import androidx.compose.material.icons.rounded.KeyboardArrowUp
import androidx.compose.material.icons.rounded.Lock
import androidx.compose.material.icons.rounded.Mic
import androidx.compose.material.icons.rounded.MicOff
import androidx.compose.material.icons.rounded.MoreVert
import androidx.compose.material.icons.rounded.Notifications
import androidx.compose.material.icons.rounded.NotificationsOff
import androidx.compose.material.icons.rounded.People
import androidx.compose.material.icons.rounded.Tag
import androidx.compose.material.icons.rounded.Tune
import androidx.compose.material.icons.rounded.Visibility
import androidx.compose.material.icons.rounded.Webhook
import androidx.compose.material.icons.rounded.DoneAll
import androidx.compose.material3.SnackbarDuration
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import gg.yappy.app.ui.components.ActionRow
import gg.yappy.app.ui.components.LocalSnackbar
import gg.yappy.app.ui.group.ChannelAccessEditor
import gg.yappy.app.ui.group.ConfirmDeleteButton
import gg.yappy.app.ui.components.RefreshBox
import kotlinx.coroutines.joinAll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import gg.yappy.app.LocalContainer
import gg.yappy.app.data.ApiException
import gg.yappy.app.data.ChannelCategory
import gg.yappy.app.data.ChannelEntry
import gg.yappy.app.data.Conversation
import gg.yappy.app.data.MediaState
import gg.yappy.app.data.VoiceOccupant
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull
import gg.yappy.app.ui.components.BadgeMark
import gg.yappy.app.ui.components.FlairAvatar
import gg.yappy.app.ui.components.NeuIconButton
import gg.yappy.app.ui.components.NeuSurface
import gg.yappy.app.ui.components.NeuButton
import gg.yappy.app.ui.components.NeuTextField
import gg.yappy.app.ui.components.SectionLabel
import gg.yappy.app.ui.components.softClickable
import gg.yappy.app.ui.components.titleColor
import gg.yappy.app.ui.theme.Neu
import gg.yappy.app.ui.theme.NeuState
import gg.yappy.app.ui.theme.PlaceShape
import gg.yappy.app.ui.theme.neuColors
import kotlinx.coroutines.launch
import androidx.compose.material3.HorizontalDivider
import gg.yappy.app.data.Webhook

/**
 * A space: its channels, and the way into its people and settings.
 *
 * This is the screen that makes a space feel like a *place with rooms* rather
 * than a folder. The channel list is the content — everything else (members,
 * settings, voice) is chrome around it — so the channels get the full-width
 * rows and the accent, and the rest is deliberately quiet.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun SpaceScreen(
    spaceId: String,
    onBack: () -> Unit,
    onOpenChannel: (String) -> Unit,
    onOpenMembers: () -> Unit,
    onOpenSettings: () -> Unit,
) {
    val container = LocalContainer.current
    val colors = neuColors
    val scope = rememberCoroutineScope()
    val haptics = LocalHapticFeedback.current
    val snackbar = LocalSnackbar.current

    // Seeded from the last visit, so walking back into a space paints the
    // rooms in the first frame. The refetch below lands as a correction —
    // `mutableStateOf` compares structurally, so an unchanged answer does not
    // even recompose, which is what makes re-opening flash-free.
    var space by remember {
        mutableStateOf(container.screenSnapshots.get<Conversation>("space_$spaceId"))
    }
    var channels by remember {
        mutableStateOf(
            container.screenSnapshots.get<List<ChannelEntry>>("space_channels_$spaceId") ?: emptyList()
        )
    }
    var categories by remember {
        mutableStateOf(
            container.screenSnapshots.get<List<ChannelCategory>>("space_categories_$spaceId")
                ?: emptyList()
        )
    }
    /**
     * Which dividers this person has folded away.
     *
     * A view preference, not a fact about the space — two people looking at
     * the same sidebar should be able to disagree about it — so it is kept on
     * the device rather than sent to the server. See CollapsedCategories.
     */
    var collapsed by remember { mutableStateOf(CollapsedCategories.load(container)) }
    var loading by remember { mutableStateOf(space == null) }
    var refresh by remember { mutableStateOf(0) }
    /** A pull is out. Only the pull sets it; event-driven refetches stay silent. */
    var refreshing by remember { mutableStateOf(false) }
    /*
     * The create form and the arrange mode are saveable: the activity is
     * recreated on rotation and fold, and a half-named channel with four
     * toggles set is exactly the work that must not vanish for it.
     */
    var creating by rememberSaveable { mutableStateOf(false) }
    var namingCategory by rememberSaveable { mutableStateOf(false) }
    var newCategoryName by rememberSaveable { mutableStateOf("") }
    var renamingCategory by remember { mutableStateOf<String?>(null) }
    var newChannelCategoryId by rememberSaveable { mutableStateOf<String?>(null) }
    /** Long-pressed channel whose action sheet is up. */
    var menuTarget by remember { mutableStateOf<ChannelEntry?>(null) }
    /** Channel being renamed in its own sheet. */
    var renameTarget by remember { mutableStateOf<ChannelEntry?>(null) }

    /**
     * Whether this viewer may create and arrange channels and categories:
     * MANAGE_CONVERSATION, or ADMINISTRATOR, which holds everything. Mirrors
     * the server rather than guessing from the ladder role, because a role
     * overwrite can grant it to somebody who is not an admin.
     */
    val canManage = (space?.permissions?.toLongOrNull() ?: 0L).let {
        it and (1L shl 36) != 0L || it and (1L shl 62) != 0L
    }
    /**
     * Whether this viewer may let a role into a channel: MANAGE_ROLES, or
     * ADMINISTRATOR. Half of what "Who can see it" spends — the role switches
     * are overwrites, which the server gates on this bit, but moving the
     * floor between Everyone and Only-these-roles is a PATCH on the
     * conversation, gated on [canManage] — so that row asks for both.
     * Administrator holds both; a web-made role holding one alone gets no
     * row rather than a sheet where half the controls answer 403.
     */
    val canManageRoles = (space?.permissions?.toLongOrNull() ?: 0L).let {
        it and (1L shl 35) != 0L || it and (1L shl 62) != 0L
    }
    var newTitle by rememberSaveable { mutableStateOf("") }
    var newIsAnnouncement by rememberSaveable { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var reordering by rememberSaveable { mutableStateOf(false) }
    /** Channel whose settings sheet is up, and the part of it that was asked for. */
    var channelSheet by remember { mutableStateOf<Pair<ChannelEntry, ChannelSheet>?>(null) }
    var newIsVoice by rememberSaveable { mutableStateOf(false) }
    var newIsBoard by rememberSaveable { mutableStateOf(false) }
    var newIsForum by rememberSaveable { mutableStateOf(false) }
    var newIsPrivate by rememberSaveable { mutableStateOf(false) }
    /*
     * Surfaced rather than swallowed. Creating a private channel needs
     * MANAGE_ROLES on top of MANAGE_CONVERSATION, and a Create button that
     * silently does nothing is the worst possible way to learn that.
     */
    var createError by remember { mutableStateOf<String?>(null) }

    // ── Voice ────────────────────────────────────────────────────────────────
    val context = LocalContext.current
    val voiceSession by container.voiceChannels.session.collectAsState()
    val voiceMedia by container.voiceChannels.media.collectAsState()
    var pendingVoiceJoin by remember { mutableStateOf<ChannelEntry?>(null) }
    val askMic = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        // Denied is listen-only, not refused entry — same as arriving muted.
        pendingVoiceJoin?.let { ch ->
            scope.launch {
                container.voiceChannels.join(ch.id, spaceId, ch.title ?: "voice", publishAudio = granted)
            }
        }
        pendingVoiceJoin = null
    }

    fun joinVoiceChannel(ch: ChannelEntry) {
        val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED
        if (granted) {
            scope.launch { container.voiceChannels.join(ch.id, spaceId, ch.title ?: "voice") }
        } else {
            pendingVoiceJoin = ch
            askMic.launch(Manifest.permission.RECORD_AUDIO)
        }
    }

    // Live rosters: voice.state snapshots arrive on the space topic; patch the
    // one channel they name. Unknown channels (another space) fall through.
    LaunchedEffect(spaceId) {
        val lenient = Json { ignoreUnknownKeys = true }
        container.gateway.events.collect { ev ->
            if (ev.type != "voice.state") return@collect
            val obj = runCatching { ev.data.jsonObject }.getOrNull() ?: return@collect
            val channelId = obj["channelId"]?.jsonPrimitive?.contentOrNull ?: return@collect
            if (channels.none { it.id == channelId }) return@collect
            val roster = obj["participants"]?.let {
                runCatching {
                    lenient.decodeFromJsonElement(ListSerializer(VoiceOccupant.serializer()), it)
                }.getOrNull()
            } ?: emptyList()
            channels = channels.map { if (it.id == channelId) it.copy(voiceParticipants = roster) else it }
        }
    }

    // Leave each channel's name behind, so tapping one draws its header
    // immediately instead of "…" until the conversation fetch answers. Called
    // from both fetches below because either can finish last, and once more
    // here so cached visits seed without any fetch at all.
    fun seedChannelHeaders() {
        val s = space ?: return
        channels.forEach { container.headerSeeds.remember(it, s) }
    }
    seedChannelHeaders()

    LaunchedEffect(spaceId, refresh) {
        // In parallel, and never wiping what is already drawn: the old code
        // fetched the space, painted, then fetched the channels — two visible
        // pops on every open — and a failed refetch dropped the list back to
        // empty, which read as the screen blinking.
        val fetches = listOf(
            launch {
                runCatching { container.repo.conversation(spaceId).conversation }.getOrNull()?.let {
                    space = it
                    container.screenSnapshots.put("space_$spaceId", it)
                    seedChannelHeaders()
                }
                loading = false
            },
            launch {
                runCatching { container.repo.channels(spaceId) }.getOrNull()?.let { envelope ->
                    val it = envelope.channels
                    channels = it
                    categories = envelope.categories
                    container.screenSnapshots.put("space_categories_$spaceId", envelope.categories)
                    container.screenSnapshots.put("space_channels_$spaceId", it)
                    seedChannelHeaders()
                }
            },
        )
        // The pull indicator waits for both, not the first.
        fetches.joinAll()
        refreshing = false
    }

    RefreshBox(
        refreshing = refreshing,
        onRefresh = {
            refreshing = true
            refresh++
        },
        modifier = Modifier.fillMaxSize(),
    ) {
        Column(
            Modifier
                .fillMaxSize()
                .statusBarsPadding()
                // The inline create form sits low on the page; without this the
                // keyboard covers the field being typed into.
                .imePadding()
                .verticalScroll(rememberScrollState()),
        ) {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                NeuIconButton(Icons.AutoMirrored.Rounded.ArrowBack, "Back", onBack, size = 42.dp, iconSize = 19.dp)
                Spacer(Modifier.weight(1f))
                NeuIconButton(Icons.Rounded.People, "Members", onOpenMembers, size = 42.dp, iconSize = 19.dp)
                Spacer(Modifier.width(10.dp))
                NeuIconButton(Icons.Rounded.Tune, "Space settings", onOpenSettings, size = 42.dp, iconSize = 19.dp)
            }

            val s = space
            if (s == null) {
                Box(Modifier.fillMaxWidth().height(280.dp), Alignment.Center) {
                    if (loading) CircularProgressIndicator(color = colors.accent)
                    else Text("Space not found", color = colors.textTertiary)
                }
                return@Column
            }

            // ── Header ───────────────────────────────────────────────────────────
            Column(
                Modifier.fillMaxWidth().padding(horizontal = 24.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                FlairAvatar(
                    s.appearance, s.displayAvatar, s.displayName, s.avatarSeed,
                    size = 88.dp, shape = PlaceShape,
                )
                Spacer(Modifier.height(12.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        s.displayName,
                        style = MaterialTheme.typography.headlineMedium,
                        color = s.appearance?.titleColor() ?: colors.textPrimary,
                    )
                    if (s.badge != null) {
                        Spacer(Modifier.width(8.dp))
                        BadgeMark(s.badge, size = 19.dp)
                    }
                }
                Spacer(Modifier.height(4.dp))
                Text(
                    "${s.memberCount} members · ${channels.size} " +
                        if (channels.size == 1) "channel" else "channels",
                    style = MaterialTheme.typography.bodyMedium,
                    color = colors.textTertiary,
                )
                s.description?.takeIf { it.isNotBlank() }?.let {
                    Spacer(Modifier.height(8.dp))
                    Text(it, style = MaterialTheme.typography.bodyMedium, color = colors.textSecondary)
                }
            }

            Spacer(Modifier.height(22.dp))

            // ── Connected to voice ───────────────────────────────────────────────
            voiceSession?.takeIf { it.spaceId == spaceId }?.let { vs ->
                NeuSurface(
                    Modifier.fillMaxWidth().padding(horizontal = 16.dp),
                    shape = RoundedCornerShape(Neu.CornerLarge),
                    contentPadding = 12.dp,
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(
                            Icons.AutoMirrored.Rounded.VolumeUp,
                            null,
                            tint = colors.success,
                            modifier = Modifier.size(18.dp),
                        )
                        Spacer(Modifier.width(10.dp))
                        Column(Modifier.weight(1f)) {
                            Text(
                                when (voiceMedia.state) {
                                    MediaState.Connecting -> "Connecting…"
                                    MediaState.Reconnecting -> "Reconnecting…"
                                    MediaState.Failed -> "Connection failed"
                                    else -> "Voice connected"
                                },
                                style = MaterialTheme.typography.labelSmall,
                                color = if (voiceMedia.state == MediaState.Failed) colors.danger else colors.success,
                            )
                            Text(
                                vs.title,
                                style = MaterialTheme.typography.titleSmall,
                                color = colors.textPrimary,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                        NeuIconButton(
                            if (vs.muted) Icons.Rounded.MicOff else Icons.Rounded.Mic,
                            if (vs.muted) "Unmute" else "Mute",
                            { scope.launch { container.voiceChannels.setMuted(!vs.muted) } },
                            size = 38.dp,
                            iconSize = 17.dp,
                        )
                        Spacer(Modifier.width(8.dp))
                        NeuIconButton(
                            Icons.Rounded.Close,
                            "Disconnect",
                            { scope.launch { container.voiceChannels.leave() } },
                            size = 38.dp,
                            iconSize = 17.dp,
                        )
                    }
                }
                Spacer(Modifier.height(14.dp))
            }

            // ── Channels ─────────────────────────────────────────────────────────
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 24.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                SectionLabel("Channels", Modifier.weight(1f))
                if (canManage) {
                    Text(
                        "Category",
                        style = MaterialTheme.typography.labelMedium,
                        color = colors.accent,
                        modifier = Modifier
                            .clip(RoundedCornerShape(Neu.CornerSmall))
                            .softClickable { namingCategory = true }
                            .padding(horizontal = 8.dp, vertical = 4.dp),
                    )
                }
                // Arranging is worth offering as soon as there is more than one
                // thing to arrange — a single channel and two categories is a
                // list that needs sorting just as much as three channels does.
                // Managers only, like Category beside it: a member could enter the
                // mode, reorder, watch the server refuse, and see it snap back.
                if (canManage && (channels.size > 1 || categories.isNotEmpty())) {
                    Text(
                        if (reordering) "Done" else "Arrange",
                        style = MaterialTheme.typography.labelMedium,
                        color = colors.accent,
                        modifier = Modifier
                            .clip(RoundedCornerShape(Neu.CornerSmall))
                            .softClickable { reordering = !reordering }
                            .padding(horizontal = 8.dp, vertical = 4.dp),
                    )
                }
            }
            Spacer(Modifier.height(6.dp))


            /**
             * One row, wherever it is drawn.
             *
             * Categories group the list without being part of it, so a channel's
             * row is identical inside one and outside — the index it reports for
             * the move arrows is its index in the whole space, because that is
             * what the server reorders.
             */
            @Composable
            fun channelRow(channel: ChannelEntry) {
                val index = channels.indexOfFirst { it.id == channel.id }
                ChannelRow(
                    channel = channel,
                    accent = s.appearance?.titleColor(),
                    reordering = reordering,
                    canMoveUp = index > 0,
                    canMoveDown = index < channels.lastIndex,
                    connectedVoice = voiceSession?.channelId == channel.id,
                    categories = categories,
                    onFile = { categoryId ->
                        // Optimistic, and sent as a reorder because that is what
                        // it is: the whole order and the move travel together.
                        channels = channels.map {
                            if (it.id == channel.id) it.copy(categoryId = categoryId) else it
                        }
                        scope.launch {
                            runCatching {
                                container.repo.reorderChannels(
                                    spaceId,
                                    channels.map { it.id },
                                    mapOf(channel.id to categoryId),
                                )
                            }.onFailure { refresh++ }
                        }
                    },
                    onClick = {
                        if (channel.isVoice) joinVoiceChannel(channel) else onOpenChannel(channel.id)
                    },
                    onLongClick = { menuTarget = channel },
                    onMove = { delta ->
                        // Reordered locally first so the list does not jump
                        // under the finger while the round trip completes.
                        if (index < 0) return@ChannelRow
                        val next = channels.toMutableList()
                        val to = index + delta
                        if (to < 0 || to > next.lastIndex) return@ChannelRow
                        next.add(to, next.removeAt(index))
                        channels = next
                        scope.launch {
                            runCatching { container.repo.reorderChannels(spaceId, next.map { it.id }) }
                                .onFailure { refresh++ }
                        }
                    },
                )
            }

            Column(
                Modifier.fillMaxWidth().padding(horizontal = 16.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                // Loose channels first — above every divider, which is where
                // #general belongs. Not under a nameless "Uncategorised".
                channels.filter { it.categoryId == null }.forEach { channelRow(it) }

                // Only categories with something in them, plus — for somebody who
                // can manage the space — the empty ones they are about to fill.
                categories.forEach { category ->
                    val inside = channels.filter { it.categoryId == category.id }
                    if (inside.isEmpty() && !canManage) return@forEach
                    // Folding while rearranging would hide the thing being moved.
                    val folded = collapsed.contains(category.id) && !reordering
                    CategoryHeader(
                        category = category,
                        folded = folded,
                        // Rolled up onto the header: without it, folding hides the
                        // only signal that something inside needs reading, which
                        // trains people not to fold anything.
                        hiddenUnread = if (folded) inside.filter { !it.isMuted }.sumOf { it.unreadCount } else 0,
                        hiddenMentions = if (folded) inside.sumOf { it.mentionCount } else 0,
                        renaming = renamingCategory == category.id,
                        canManage = canManage && reordering,
                        onToggle = { collapsed = CollapsedCategories.toggle(container, category.id) },
                        onStartRename = { renamingCategory = category.id },
                        onRename = { name ->
                            renamingCategory = null
                            if (name.isNotBlank() && name != category.name) {
                                scope.launch {
                                    runCatching { container.repo.renameCategory(spaceId, category.id, name) }
                                    refresh++
                                }
                            }
                        },
                        onDelete = {
                            scope.launch {
                                runCatching { container.repo.deleteCategory(spaceId, category.id) }
                                refresh++
                            }
                        },
                    )
                    // Nothing to keep visible when folded: opening a channel here
                    // pushes a screen rather than selecting in place, so there is no
                    // "the one you are reading" to lose.
                    if (!folded) inside.forEach { channelRow(it) }
                }
            }

            Spacer(Modifier.height(14.dp))

            // ── New channel ──────────────────────────────────────────────────────
            // Inline rather than behind a dialog: creating channels is something
            // people do in bursts while setting a space up.
            if (creating) {
                NeuSurface(
                    Modifier.fillMaxWidth().padding(horizontal = 16.dp),
                    shape = RoundedCornerShape(Neu.CornerLarge),
                    contentPadding = 14.dp,
                ) {
                    Column {
                        NeuTextField(
                            value = newTitle,
                            onValueChange = { newTitle = it },
                            placeholder = "channel-name",
                            modifier = Modifier.fillMaxWidth(),
                        )
                        Spacer(Modifier.height(10.dp))
                        /*
                         * Wraps, because four chips do not fit a phone.
                         *
                         * This was a plain Row holding the chips *and* the two
                         * actions; adding Forum pushed "Voice channel" past the
                         * right edge, where all that showed was a sliver of its
                         * rounded end. The actions are their own row now, which
                         * is where a dialog's buttons belong regardless.
                         */
                        /*
                         * One quiet row where three rows of chips were.
                         *
                         * The four posture chips were radio buttons pretending to
                         * be toggles — exactly one can hold, plus the implicit
                         * "just text" default — and the category chips grew by one
                         * with every category the space had. Ten pills in a small
                         * card reads as clutter before it reads as choices. Each
                         * exclusive set is now a single menu naming its current
                         * choice; only Private stays a chip, because it is the one
                         * genuine on/off in the form.
                         */
                        FlowRow(
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            var typeMenuOpen by remember { mutableStateOf(false) }
                            val typeLabel = when {
                                newIsVoice -> "Voice"
                                newIsBoard -> "Board"
                                newIsForum -> "Forum"
                                newIsAnnouncement -> "Announcements"
                                else -> "Text"
                            }
                            val typeIcon = when {
                                newIsVoice -> Icons.AutoMirrored.Rounded.VolumeUp
                                newIsBoard -> Icons.Rounded.PushPin
                                newIsForum -> Icons.AutoMirrored.Rounded.List
                                newIsAnnouncement -> Icons.Rounded.Campaign
                                else -> Icons.Rounded.Tag
                            }
                            Box {
                                Box(
                                    Modifier
                                        .clip(RoundedCornerShape(Neu.CornerPill))
                                        .background(colors.incoming)
                                        .softClickable { typeMenuOpen = true }
                                        .padding(horizontal = 12.dp, vertical = 7.dp),
                                ) {
                                    Row(verticalAlignment = Alignment.CenterVertically) {
                                        Icon(typeIcon, null, tint = colors.accent, modifier = Modifier.size(16.dp))
                                        Spacer(Modifier.width(6.dp))
                                        Text(typeLabel, style = MaterialTheme.typography.labelMedium, color = colors.textPrimary)
                                        Spacer(Modifier.width(4.dp))
                                        Icon(
                                            Icons.Rounded.KeyboardArrowDown,
                                            "Channel type",
                                            tint = colors.textTertiary,
                                            modifier = Modifier.size(14.dp),
                                        )
                                    }
                                }
                                DropdownMenu(expanded = typeMenuOpen, onDismissRequest = { typeMenuOpen = false }) {
                                    fun pick(
                                        voice: Boolean = false,
                                        board: Boolean = false,
                                        forum: Boolean = false,
                                        announcement: Boolean = false,
                                    ) {
                                        newIsVoice = voice
                                        newIsBoard = board
                                        newIsForum = forum
                                        newIsAnnouncement = announcement
                                        // A call has no timeline to hide, and announcement
                                        // is the same lever as private at a different floor.
                                        if (voice || announcement) newIsPrivate = false
                                        typeMenuOpen = false
                                    }
                                    /*
                                     * Each kind wears the same glyph it wears in the
                                     * channel list, and the current pick is marked —
                                     * a menu of bare words made every option look
                                     * equally foreign, and gave no answer to "which
                                     * one is it now?" without closing it.
                                     */
                                    @Composable
                                    fun kindItem(
                                        label: String,
                                        icon: androidx.compose.ui.graphics.vector.ImageVector,
                                        selected: Boolean,
                                        onPick: () -> Unit,
                                    ) = DropdownMenuItem(
                                        text = {
                                            Text(
                                                label,
                                                style = MaterialTheme.typography.labelLarge,
                                                color = if (selected) colors.accent else colors.textPrimary,
                                            )
                                        },
                                        leadingIcon = {
                                            Icon(
                                                icon,
                                                null,
                                                tint = if (selected) colors.accent else colors.textTertiary,
                                                modifier = Modifier.size(18.dp),
                                            )
                                        },
                                        trailingIcon = {
                                            if (selected) {
                                                Icon(
                                                    Icons.Rounded.Check,
                                                    null,
                                                    tint = colors.accent,
                                                    modifier = Modifier.size(16.dp),
                                                )
                                            }
                                        },
                                        onClick = onPick,
                                    )
                                    kindItem("Text", Icons.Rounded.Tag, typeLabel == "Text") { pick() }
                                    kindItem("Announcements", Icons.Rounded.Campaign, newIsAnnouncement) { pick(announcement = true) }
                                    kindItem("Board", Icons.Rounded.PushPin, newIsBoard) { pick(board = true) }
                                    kindItem("Forum", Icons.AutoMirrored.Rounded.List, newIsForum) { pick(forum = true) }
                                    kindItem("Voice", Icons.AutoMirrored.Rounded.VolumeUp, newIsVoice) { pick(voice = true) }
                                }
                            }

                            // Where it is filed. Loose is the default and the common case.
                            if (categories.isNotEmpty()) {
                                var catMenuOpen by remember { mutableStateOf(false) }
                                Box {
                                    Box(
                                        Modifier
                                            .clip(RoundedCornerShape(Neu.CornerPill))
                                            .background(colors.incoming)
                                            .softClickable { catMenuOpen = true }
                                            .padding(horizontal = 12.dp, vertical = 7.dp),
                                    ) {
                                        Row(verticalAlignment = Alignment.CenterVertically) {
                                            Text(
                                                categories.firstOrNull { it.id == newChannelCategoryId }?.name
                                                    ?: "No category",
                                                style = MaterialTheme.typography.labelMedium,
                                                color = colors.textPrimary,
                                            )
                                            Spacer(Modifier.width(4.dp))
                                            Icon(
                                                Icons.Rounded.KeyboardArrowDown,
                                                "Category",
                                                tint = colors.textTertiary,
                                                modifier = Modifier.size(14.dp),
                                            )
                                        }
                                    }
                                    DropdownMenu(expanded = catMenuOpen, onDismissRequest = { catMenuOpen = false }) {
                                        @Composable
                                        fun catItem(label: String, id: String?) = DropdownMenuItem(
                                            text = {
                                                Text(
                                                    label,
                                                    style = MaterialTheme.typography.labelLarge,
                                                    color = if (newChannelCategoryId == id) colors.accent
                                                    else colors.textPrimary,
                                                )
                                            },
                                            trailingIcon = {
                                                if (newChannelCategoryId == id) {
                                                    Icon(
                                                        Icons.Rounded.Check,
                                                        null,
                                                        tint = colors.accent,
                                                        modifier = Modifier.size(16.dp),
                                                    )
                                                }
                                            },
                                            onClick = { newChannelCategoryId = id; catMenuOpen = false },
                                        )
                                        catItem("No category", null)
                                        categories.forEach { category -> catItem(category.name, category.id) }
                                    }
                                }
                            }

                            // Private stays a chip: the one genuine on/off.
                            Box(
                                Modifier
                                    .clip(RoundedCornerShape(Neu.CornerPill))
                                    .background(if (newIsPrivate) colors.accentSoft else colors.incoming)
                                    .softClickable {
                                        newIsPrivate = !newIsPrivate
                                        if (newIsPrivate) {
                                            newIsVoice = false
                                            newIsAnnouncement = false
                                        }
                                    }
                                    .padding(horizontal = 12.dp, vertical = 7.dp),
                            ) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Icon(
                                        Icons.Rounded.Lock,
                                        null,
                                        tint = if (newIsPrivate) colors.accent else colors.textTertiary,
                                        modifier = Modifier.size(16.dp),
                                    )
                                    Spacer(Modifier.width(6.dp))
                                    Text(
                                        "Private",
                                        style = MaterialTheme.typography.labelMedium,
                                        color = if (newIsPrivate) colors.accent else colors.textTertiary,
                                    )
                                }
                            }
                        }

                        if (newIsPrivate) {
                            Spacer(Modifier.height(8.dp))
                            Text(
                                "Only you and the space's moderators and admins will see this channel.",
                                style = MaterialTheme.typography.labelSmall,
                                color = colors.textTertiary,
                            )
                        }

                        createError?.let { message ->
                            Spacer(Modifier.height(8.dp))
                            Text(
                                message,
                                style = MaterialTheme.typography.labelSmall,
                                color = colors.danger,
                            )
                        }

                        Spacer(Modifier.height(10.dp))

                        Row(
                            Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.End,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                "Cancel",
                                style = MaterialTheme.typography.labelLarge,
                                color = colors.textTertiary,
                                modifier = Modifier
                                    .clip(RoundedCornerShape(Neu.CornerSmall))
                                    .softClickable {
                                        creating = false
                                        newTitle = ""
                                        newIsPrivate = false
                                        createError = null
                                    }
                                    .padding(horizontal = 10.dp, vertical = 6.dp),
                            )
                            Text(
                                if (busy) "Creating…" else "Create",
                                style = MaterialTheme.typography.labelLarge,
                                color = if (newTitle.isBlank()) colors.textTertiary else colors.accent,
                                modifier = Modifier
                                    .clip(RoundedCornerShape(Neu.CornerSmall))
                                    .softClickable {
                                        if (newTitle.isBlank() || busy) return@softClickable
                                        scope.launch {
                                            busy = true
                                            createError = null
                                            val result = runCatching {
                                                container.repo.createChannel(
                                                    spaceId, newTitle.trim(), newIsAnnouncement, channels.size,
                                                    isVoice = newIsVoice,
                                                    isBoard = newIsBoard,
                                                    isForum = newIsForum,
                                                    isPrivate = newIsPrivate,
                                                    // Filed as it is made, so it never appears
                                                    // loose for one paint and then jumps.
                                                    categoryId = newChannelCategoryId,
                                                )
                                            }
                                            busy = false
                                            if (result.isFailure) {
                                                // The form stays open holding what
                                                // was typed: losing a name and four
                                                // toggles to a permission error is
                                                // worse than the error.
                                                createError =
                                                    (result.exceptionOrNull() as? ApiException)?.message
                                                        ?: "Could not create that channel"
                                                return@launch
                                            }
                                            newTitle = ""
                                            newIsAnnouncement = false
                                            newIsVoice = false
                                            newIsBoard = false
                                            newIsForum = false
                                            newIsPrivate = false
                                            newChannelCategoryId = null
                                            creating = false
                                            refresh++
                                        }
                                    }
                                    .padding(horizontal = 10.dp, vertical = 6.dp),
                            )
                        }
                    }
                }
            } else {
                NeuSurface(
                    Modifier.fillMaxWidth().padding(horizontal = 16.dp),
                    shape = RoundedCornerShape(Neu.CornerLarge),
                    contentPadding = 14.dp,
                    onClick = { creating = true },
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Rounded.Add, null, tint = colors.accent, modifier = Modifier.size(20.dp))
                        Spacer(Modifier.width(10.dp))
                        Text(
                            "New channel",
                            style = MaterialTheme.typography.bodyLarge,
                            color = colors.accent,
                        )
                    }
                }
            }

            // The real bar, plus a gap: the fixed 36dp sat under a 3-button bar
            // and floated for no reason over gestures.
            Spacer(Modifier.navigationBarsPadding().height(24.dp))
        }
    }

    /*
     * The channel's menu.
     *
     * A long press used to drop straight into the notifications sheet, which
     * made "hold a channel" mean one thing and hid everything else a channel
     * can do behind it. This is the sheet the rest of the app uses for a
     * held thing: what it is at the top, then what you can do to it, with
     * the manager's tools after a rule and the destructive one last.
     */
    menuTarget?.let { target ->
        val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
        // Deleting a room asks twice, like every other irreversible thing here.
        var confirmDelete by remember(target.id) { mutableStateOf(false) }
        ModalBottomSheet(
            onDismissRequest = { menuTarget = null },
            sheetState = sheetState,
            containerColor = colors.surface,
            contentColor = colors.textPrimary,
        ) {
            Column(Modifier.padding(horizontal = 16.dp).padding(bottom = 30.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(bottom = 10.dp, start = 6.dp)) {
                    Icon(
                        channelGlyph(target),
                        null,
                        tint = colors.textTertiary,
                        modifier = Modifier.size(18.dp),
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(
                        target.title ?: "channel",
                        style = MaterialTheme.typography.titleMedium,
                        color = colors.textPrimary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }

                if (!target.isVoice && (target.unreadCount > 0 || target.mentionCount > 0)) {
                    ActionRow(Icons.Rounded.DoneAll, "Mark as read") {
                        menuTarget = null
                        // Cleared locally first; the receipt round-trips after.
                        channels = channels.map {
                            if (it.id == target.id) it.copy(unreadCount = 0, mentionCount = 0) else it
                        }
                        scope.launch {
                            runCatching { container.repo.markRead(target.id, target.latestSeq) }
                                .onFailure { refresh++ }
                        }
                    }
                }
                ActionRow(Icons.Rounded.Notifications, "Notifications…") {
                    menuTarget = null
                    channelSheet = target to ChannelSheet.Notify
                }

                /*
                 * The manager's tools, each behind the bit the server checks
                 * for it: renaming, webhooks and deleting are
                 * MANAGE_CONVERSATION. "Who can see it" spends two — the
                 * floor is MANAGE_CONVERSATION, the role switches are
                 * MANAGE_ROLES — so it waits for both rather than opening a
                 * sheet where half the controls answer 403. Each row opens
                 * the sheet on the part it names — a door labelled "Webhooks"
                 * that opened onto the notification levels was the old shape.
                 */
                val accessRow = canManage && canManageRoles && !target.isVoice
                if (canManage) {
                    HorizontalDivider(color = colors.hairline, modifier = Modifier.padding(vertical = 8.dp))
                    ActionRow(Icons.Rounded.Edit, "Rename") {
                        menuTarget = null
                        renameTarget = target
                    }
                }
                if (accessRow) {
                    ActionRow(Icons.Rounded.Visibility, "Who can see it") {
                        menuTarget = null
                        channelSheet = target to ChannelSheet.Access
                    }
                }
                if (canManage) {
                    if (!target.isVoice) {
                        ActionRow(Icons.Rounded.Webhook, "Webhooks") {
                            menuTarget = null
                            channelSheet = target to ChannelSheet.Webhooks
                        }
                    }
                    ActionRow(
                        Icons.Rounded.Delete,
                        if (confirmDelete) "Tap again to delete #${target.title ?: "channel"}" else "Delete channel",
                        danger = true,
                    ) {
                        if (!confirmDelete) {
                            confirmDelete = true
                            haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                            return@ActionRow
                        }
                        menuTarget = null
                        scope.launch {
                            val ok = runCatching { container.repo.deleteChannel(spaceId, target.id) }.isSuccess
                            if (ok) {
                                channels = channels.filterNot { it.id == target.id }
                                snackbar.showSnackbar(
                                    "Deleted #${target.title ?: "channel"}",
                                    duration = SnackbarDuration.Short,
                                )
                            } else {
                                snackbar.showSnackbar("Couldn't delete that channel", duration = SnackbarDuration.Short)
                            }
                            refresh++
                        }
                    }
                }
            }
        }
    }

    // ── Rename a channel ─────────────────────────────────────────────────────
    renameTarget?.let { target ->
        val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
        var draft by rememberSaveable(target.id) { mutableStateOf(target.title.orEmpty()) }
        var saving by remember { mutableStateOf(false) }
        // Told inside the sheet, not by the screen's snackbar: a modal sheet is
        // its own window, so a snackbar posted while it is up draws *under*
        // it, and a Save that failed looked like a Save that did nothing.
        var renameError by remember(target.id) { mutableStateOf<String?>(null) }
        ModalBottomSheet(
            onDismissRequest = { renameTarget = null },
            sheetState = sheetState,
            containerColor = colors.surface,
            contentColor = colors.textPrimary,
        ) {
            Column(Modifier.padding(horizontal = 16.dp).padding(bottom = 30.dp).imePadding()) {
                Text(
                    "Rename channel",
                    style = MaterialTheme.typography.titleMedium,
                    color = colors.textPrimary,
                    modifier = Modifier.padding(bottom = 14.dp),
                )
                NeuTextField(
                    value = draft,
                    onValueChange = { draft = it; renameError = null },
                    placeholder = target.title ?: "channel-name",
                    modifier = Modifier.fillMaxWidth(),
                )
                renameError?.let {
                    Text(
                        it,
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.danger,
                        modifier = Modifier.padding(top = 8.dp, start = 4.dp),
                    )
                }
                Spacer(Modifier.height(14.dp))
                NeuButton(
                    onClick = {
                        val name = draft.trim()
                        if (name.isBlank() || saving) return@NeuButton
                        saving = true
                        renameError = null
                        scope.launch {
                            val ok = runCatching { container.repo.updateConversation(target.id, title = name) }.isSuccess
                            saving = false
                            if (ok) {
                                channels = channels.map { if (it.id == target.id) it.copy(title = name) else it }
                                renameTarget = null
                                refresh++
                            } else {
                                renameError = "Couldn't rename that channel. Check the connection and try again."
                            }
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                    enabled = draft.isNotBlank() && draft.trim() != target.title && !saving,
                    accent = true,
                ) {
                    Text(
                        if (saving) "Saving…" else "Save",
                        style = MaterialTheme.typography.labelLarge,
                        color = colors.onAccent,
                    )
                }
            }
        }
    }

    /*
     * Naming a category.
     *
     * A bottom sheet, not an inline form. The inline version was a field and
     * two text buttons materialising between the header and the list — it
     * shoved every row down, belonged visually to nothing, and sat there
     * until dismissed. A sheet is how this screen already asks its one-off
     * questions (notifications, below): the list never moves, and dismissing
     * is a gesture everyone already knows.
     */
    if (namingCategory) {
        val catSheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
        ModalBottomSheet(
            onDismissRequest = { namingCategory = false; newCategoryName = "" },
            sheetState = catSheetState,
            containerColor = colors.surface,
            contentColor = colors.textPrimary,
        ) {
            Column(Modifier.padding(horizontal = 16.dp).padding(bottom = 30.dp).imePadding()) {
                Text(
                    "New category",
                    style = MaterialTheme.typography.titleMedium,
                    color = colors.textPrimary,
                    modifier = Modifier.padding(bottom = 4.dp),
                )
                Text(
                    "A divider that groups channels in the list. It holds no messages and changes nothing about who sees what.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = colors.textTertiary,
                    modifier = Modifier.padding(bottom = 14.dp),
                )
                NeuTextField(
                    value = newCategoryName,
                    onValueChange = { newCategoryName = it },
                    placeholder = "Category name",
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(14.dp))
                NeuButton(
                    onClick = {
                        val name = newCategoryName.trim()
                        if (name.isNotBlank()) {
                            scope.launch {
                                runCatching { container.repo.createCategory(spaceId, name) }
                                newCategoryName = ""
                                namingCategory = false
                                refresh++
                            }
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                    enabled = newCategoryName.isNotBlank(),
                    accent = true,
                ) {
                    Text("Add category")
                }
            }
        }
    }

    /*
     * ── One part of a channel's setup ────────────────────────────────────
     *
     * This sheet is where a channel is configured on a phone — there is no
     * separate channel settings screen. It used to stack all three parts
     * under one another, so every row in the menu landed on the notification
     * levels and the thing you tapped for was two dividers down, or clipped
     * off the bottom of the sheet on a channel with a long role list. Now the
     * menu says which part it wants and the sheet shows that part alone.
     */
    channelSheet?.let { (target, section) ->
        val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
        ModalBottomSheet(
            onDismissRequest = { channelSheet = null },
            sheetState = sheetState,
            containerColor = colors.surface,
            contentColor = colors.textPrimary,
        ) {
            Column(
                Modifier
                    .padding(horizontal = 16.dp)
                    .padding(bottom = 30.dp)
                    // A space with many roles, or a channel with many hooks,
                    // is taller than the sheet; the sheet does not grow past
                    // the window, it clips.
                    .verticalScroll(rememberScrollState()),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(bottom = 4.dp)) {
                    Icon(
                        channelGlyph(target),
                        null,
                        tint = colors.textTertiary,
                        modifier = Modifier.size(18.dp),
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(
                        target.title ?: "channel",
                        style = MaterialTheme.typography.titleMedium,
                        color = colors.textPrimary,
                    )
                }

                when (section) {
                    ChannelSheet.Notify -> {
                        Text(
                            "Applies to this channel only. Muting the whole space still wins.",
                            style = MaterialTheme.typography.labelSmall,
                            color = colors.textTertiary,
                            modifier = Modifier.padding(bottom = 10.dp),
                        )
                        NOTIFY_LEVELS.forEach { (level, label, blurb) ->
                            val picked = !target.isMuted && target.notificationLevel == level
                            Row(
                                Modifier
                                    .fillMaxWidth()
                                    .clip(RoundedCornerShape(Neu.CornerSmall))
                                    .softClickable {
                                        scope.launch {
                                            runCatching { container.repo.setNotificationLevel(target.id, level) }
                                            channelSheet = null
                                            refresh++
                                        }
                                    }
                                    .padding(vertical = 12.dp, horizontal = 8.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Column(Modifier.weight(1f)) {
                                    Text(
                                        label,
                                        style = MaterialTheme.typography.bodyLarge,
                                        color = if (picked) colors.accent else colors.textPrimary,
                                    )
                                    Text(blurb, style = MaterialTheme.typography.labelSmall, color = colors.textTertiary)
                                }
                                if (picked) {
                                    Icon(
                                        Icons.Rounded.Check,
                                        null,
                                        tint = colors.accent,
                                        modifier = Modifier.size(20.dp),
                                    )
                                }
                            }
                        }
                    }

                    // Offered only to someone holding both bits the editor
                    // spends (see the menu), so no second gate here. What no
                    // gate can know ahead — a role trimmed while the sheet is
                    // open, a dropped connection — the editor says under its
                    // chips.
                    ChannelSheet.Access -> {
                        Text(
                            "Who can see this channel",
                            style = MaterialTheme.typography.titleSmall,
                            color = colors.textPrimary,
                            modifier = Modifier.padding(horizontal = 8.dp).padding(top = 6.dp, bottom = 6.dp),
                        )
                        ChannelAccessEditor(
                            conversationId = target.id,
                            spaceId = spaceId,
                            gated = target.isPrivate,
                            onGatedChanged = { refresh++ },
                            onChanged = { refresh++ },
                            horizontalPadding = 8.dp,
                        )
                    }

                    // Likewise MANAGE_CONVERSATION, which is what the server
                    // asks of a webhook's maker.
                    ChannelSheet.Webhooks -> {
                        Spacer(Modifier.height(6.dp))
                        WebhookRows(conversationId = target.id)
                    }
                }
            }
        }
    }
}

/** The part of a channel's setup the long-press menu asked the sheet to open on. */
private enum class ChannelSheet { Notify, Access, Webhooks }

/**
 * Incoming webhooks for one channel: a URL that posts into it.
 *
 * The URL appears exactly once, at creation — the same discipline as bot
 * tokens, because a retrievable credential is a better target than the
 * systems it posts for. It is copied to the clipboard and shown selectable
 * until the sheet closes; the list afterwards shows names and last-used.
 */
@Composable
private fun WebhookRows(conversationId: String) {
    val container = LocalContainer.current
    val colors = neuColors
    val scope = rememberCoroutineScope()
    val clipboard = androidx.compose.ui.platform.LocalClipboardManager.current

    var hooks by remember(conversationId) { mutableStateOf<List<Webhook>>(emptyList()) }
    var minted by remember { mutableStateOf<Webhook?>(null) }
    var busy by remember { mutableStateOf(false) }

    LaunchedEffect(conversationId) {
        hooks = runCatching { container.repo.webhooks(conversationId).webhooks }
            .getOrDefault(emptyList())
    }

    Text(
        "Webhooks",
        style = MaterialTheme.typography.titleSmall,
        color = colors.textPrimary,
        modifier = Modifier.padding(horizontal = 8.dp),
    )
    Text(
        "A URL that posts into this channel — paste it into GitHub, Grafana, or a cron job.",
        style = MaterialTheme.typography.labelSmall,
        color = colors.textTertiary,
        modifier = Modifier.padding(horizontal = 8.dp).padding(bottom = 8.dp),
    )

    minted?.let { hook ->
        Column(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 8.dp)
                .clip(RoundedCornerShape(Neu.CornerSmall))
                .background(colors.accentSoft)
                .padding(10.dp),
        ) {
            Text(
                "${hook.name} — copied to your clipboard. It will not be shown again.",
                style = MaterialTheme.typography.labelSmall,
                color = colors.textPrimary,
            )
            Spacer(Modifier.height(4.dp))
            Text(
                hook.url ?: "",
                style = MaterialTheme.typography.labelSmall,
                color = colors.textSecondary,
            )
        }
        Spacer(Modifier.height(8.dp))
    }

    // Keyed on the hook, not the slot: a new hook goes in front, and by
    // position the armed red bin of the row that was first would land on
    // it — one tap from deleting the webhook whose URL was just minted.
    hooks.forEach { hook ->
        key(hook.id) {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 7.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    hook.name,
                    style = MaterialTheme.typography.bodyLarge,
                    color = colors.textPrimary,
                    modifier = Modifier.weight(1f),
                )
                ConfirmDeleteButton(
                    action = "remove the ${hook.name} webhook",
                    size = 38.dp,
                    enabled = !busy,
                    onConfirmed = {
                        busy = true
                        scope.launch {
                            runCatching { container.repo.deleteWebhook(conversationId, hook.id) }
                            hooks = hooks.filterNot { it.id == hook.id }
                            if (minted?.id == hook.id) minted = null
                            busy = false
                        }
                    },
                )
            }
        }
    }

    Text(
        if (busy) "Working…" else "New webhook",
        style = MaterialTheme.typography.labelLarge,
        color = colors.accent,
        modifier = Modifier
            .padding(horizontal = 8.dp)
            .clip(RoundedCornerShape(Neu.CornerSmall))
            .softClickable(enabled = !busy) {
                busy = true
                scope.launch {
                    runCatching {
                        // Named after the channel by default; renameable on web.
                        container.repo.createWebhook(conversationId, "webhook").webhook
                    }.onSuccess { hook ->
                        minted = hook
                        hooks = listOf(hook.copy(url = null)) + hooks
                        hook.url?.let {
                            clipboard.setText(androidx.compose.ui.text.AnnotatedString(it))
                        }
                    }
                    busy = false
                }
            }
            .padding(8.dp),
    )
}

/** The glyph a channel wears in the list, its sheets and its menu — one each. */
private fun channelGlyph(channel: ChannelEntry): ImageVector = when {
    channel.isVoice -> Icons.AutoMirrored.Rounded.VolumeUp
    // Before the announcement case: a board is announcement-floored, and left
    // to the megaphone it reads as "an announcement channel" everywhere.
    channel.isBoard -> Icons.Rounded.PushPin
    channel.isForum -> Icons.AutoMirrored.Rounded.List
    channel.isAnnouncement -> Icons.Rounded.Campaign
    else -> Icons.Rounded.Tag
}

/** level, label, and what it actually means — the third column is the point. */
private val NOTIFY_LEVELS = listOf(
    Triple("all", "Everything", "Every message in this channel"),
    Triple("mentions", "Only mentions", "When someone names you"),
    Triple("none", "Nothing", "Still unread, just silent"),
)

/**
 * A divider in the channel list.
 *
 * Quiet type and a chevron, with the channels under it indented — it reads as
 * a label over a group, not as a row you can open. The only things it ever
 * shows besides its name are the unread it is hiding while folded, and the
 * rename and delete controls, which appear only while arranging.
 */
@Composable
private fun CategoryHeader(
    category: ChannelCategory,
    folded: Boolean,
    hiddenUnread: Int,
    hiddenMentions: Int,
    renaming: Boolean,
    canManage: Boolean,
    onToggle: () -> Unit,
    onStartRename: () -> Unit,
    onRename: (String) -> Unit,
    onDelete: () -> Unit,
) {
    val colors = neuColors
    var draft by remember(category.id, renaming) { mutableStateOf(category.name) }
    Row(
        Modifier.fillMaxWidth().padding(top = 6.dp, start = 4.dp, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (renaming) {
            NeuTextField(
                value = draft,
                onValueChange = { draft = it },
                placeholder = category.name,
                modifier = Modifier.weight(1f),
            )
            Spacer(Modifier.width(8.dp))
            Text(
                "Save",
                style = MaterialTheme.typography.labelMedium,
                color = colors.accent,
                modifier = Modifier
                    .clip(RoundedCornerShape(Neu.CornerSmall))
                    .softClickable { onRename(draft.trim()) }
                    .padding(horizontal = 8.dp, vertical = 4.dp),
            )
            return@Row
        }

        Row(
            Modifier
                .weight(1f)
                .clip(RoundedCornerShape(Neu.CornerSmall))
                .softClickable { onToggle() }
                .padding(vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                if (folded) Icons.AutoMirrored.Rounded.KeyboardArrowRight
                else Icons.Rounded.KeyboardArrowDown,
                if (folded) "Expand ${category.name}" else "Collapse ${category.name}",
                tint = colors.textTertiary,
                modifier = Modifier.size(18.dp),
            )
            Spacer(Modifier.width(2.dp))
            Text(
                category.name.uppercase(),
                style = MaterialTheme.typography.labelMedium,
                color = colors.textTertiary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }

        // Rolled up while folded, so collapsing never swallows the reason to look.
        if (hiddenMentions > 0) {
            Text(
                "@${if (hiddenMentions > 99) "99+" else hiddenMentions.toString()}",
                style = MaterialTheme.typography.labelSmall,
                color = colors.onMention,
                modifier = Modifier
                    .clip(RoundedCornerShape(Neu.CornerPill))
                    .background(colors.mention)
                    .padding(horizontal = 7.dp, vertical = 2.dp),
            )
        } else if (hiddenUnread > 0) {
            Text(
                if (hiddenUnread > 99) "99+" else hiddenUnread.toString(),
                style = MaterialTheme.typography.labelSmall,
                color = colors.accent,
                modifier = Modifier
                    .clip(RoundedCornerShape(Neu.CornerPill))
                    .background(colors.accentSoft)
                    .padding(horizontal = 7.dp, vertical = 2.dp),
            )
        }

        if (canManage) {
            Icon(
                Icons.Rounded.Edit,
                "Rename ${category.name}",
                tint = colors.textTertiary,
                modifier = Modifier
                    .size(28.dp)
                    .clip(CircleShape)
                    .softClickable { onStartRename() }
                    .padding(6.dp),
            )
            // Two taps, and the first turns the bin red: a category's
            // channels survive its deletion, but the grouping does not, and
            // the icon sits a thumb-width from Rename.
            var confirmDelete by remember(category.id) { mutableStateOf(false) }
            LaunchedEffect(confirmDelete) {
                if (confirmDelete) {
                    kotlinx.coroutines.delay(3_000)
                    confirmDelete = false
                }
            }
            Icon(
                Icons.Rounded.Delete,
                if (confirmDelete) "Tap again to delete ${category.name}" else "Delete ${category.name}",
                tint = if (confirmDelete) colors.danger else colors.textTertiary,
                modifier = Modifier
                    .size(28.dp)
                    .clip(CircleShape)
                    .softClickable {
                        if (confirmDelete) {
                            confirmDelete = false
                            onDelete()
                        } else {
                            confirmDelete = true
                        }
                    }
                    .padding(6.dp),
            )
        }
    }
}

@Composable
private fun ChannelRow(
    channel: ChannelEntry,
    accent: androidx.compose.ui.graphics.Color?,
    reordering: Boolean,
    canMoveUp: Boolean,
    canMoveDown: Boolean,
    onClick: () -> Unit,
    onLongClick: () -> Unit,
    onMove: (Int) -> Unit,
    connectedVoice: Boolean = false,
    /** For the "file this under" menu, only shown while rearranging. */
    categories: List<ChannelCategory> = emptyList(),
    onFile: (String?) -> Unit = {},
) {
    val colors = neuColors
    // A muted channel does not get to shout: the unread state is still tracked,
    // it just stops driving the row's emphasis.
    val silenced = channel.isMuted || channel.notificationLevel == "none"
    val unread = if (silenced || channel.isVoice) 0 else channel.unreadCount
    NeuSurface(
        Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(Neu.CornerLarge),
        state = if (unread > 0) NeuState.Raised else NeuState.Flat,
        elevation = if (unread > 0) 4.dp else 0.dp,
        contentPadding = 13.dp,
        // The body stays a way in while arranging — the arrows live on the
        // trailing edge, so there is no reason to lock people out of every
        // room until they find Done.
        onClick = onClick,
        onLongClick = if (reordering) null else onLongClick,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(
                channelGlyph(channel),
                null,
                // An unread channel takes the space's own accent — the same
                // signal the conversation list uses, so it reads the same way.
                // A connected voice channel takes the success green instead.
                tint = when {
                    connectedVoice -> colors.success
                    unread > 0 -> accent ?: colors.accent
                    else -> colors.textTertiary
                },
                modifier = Modifier.size(19.dp),
            )
            Spacer(Modifier.width(11.dp))
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        channel.title ?: "channel",
                        style = MaterialTheme.typography.titleSmall.copy(
                            fontWeight = if (unread > 0) FontWeight.Bold else FontWeight.Medium,
                        ),
                        color = if (connectedVoice) colors.success else colors.textPrimary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                    /*
                     * A lock, because "why can I see this and Sam cannot" is a
                     * question the list should answer without being opened. It
                     * sits after the name rather than replacing the kind glyph:
                     * a board, a forum and a voice room can all be private too,
                     * and their own glyph is the more useful of the two.
                     */
                    if (channel.isPrivate) {
                        Spacer(Modifier.width(5.dp))
                        Icon(
                            Icons.Rounded.Lock,
                            "Private channel",
                            tint = colors.textTertiary,
                            modifier = Modifier.size(12.dp),
                        )
                    }
                }
                if (channel.isVoice) {
                    // Who is inside, not what was said — a voice room's preview.
                    val roster = channel.voiceParticipants
                    Text(
                        if (roster.isEmpty()) "Tap to join"
                        else roster.joinToString(", ") { it.label },
                        style = MaterialTheme.typography.bodyMedium,
                        color = if (roster.isEmpty()) colors.textTertiary else colors.textSecondary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                } else {
                    channel.lastMessagePreview?.takeIf { it.isNotBlank() }?.let {
                        Text(
                            it,
                            style = MaterialTheme.typography.bodyMedium,
                            color = colors.textTertiary,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
                if (channel.isVoice && channel.voiceParticipants.isNotEmpty()) {
                    Text(
                        "${channel.voiceParticipants.size} in voice",
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.success,
                    )
                }
            }

            if (reordering) {
                // Explicit arrows rather than drag-to-reorder: a list this
                // short does not need a gesture, and arrows work for anyone
                // who cannot hold and drag.
                Icon(
                    Icons.Rounded.KeyboardArrowUp,
                    "Move up",
                    tint = if (canMoveUp) colors.accent else colors.textTertiary.copy(alpha = 0.4f),
                    modifier = Modifier
                        .size(30.dp)
                        .clip(CircleShape)
                        .then(if (canMoveUp) Modifier.softClickable { onMove(-1) } else Modifier)
                        .padding(4.dp),
                )
                Spacer(Modifier.width(4.dp))
                Icon(
                    Icons.Rounded.KeyboardArrowDown,
                    "Move down",
                    tint = if (canMoveDown) colors.accent else colors.textTertiary.copy(alpha = 0.4f),
                    modifier = Modifier
                        .size(30.dp)
                        .clip(CircleShape)
                        .then(if (canMoveDown) Modifier.softClickable { onMove(1) } else Modifier)
                        .padding(4.dp),
                )
                if (categories.isNotEmpty()) {
                    /*
                     * Filing, in the mode where the list is already being
                     * rearranged. A menu rather than a drag target: dropping
                     * onto a divider on a phone means holding a row steady
                     * over a strip of text a few millimetres tall.
                     */
                    var open by remember { mutableStateOf(false) }
                    Spacer(Modifier.width(2.dp))
                    Box {
                        Icon(
                            Icons.Rounded.MoreVert,
                            "Move to category",
                            tint = colors.accent,
                            modifier = Modifier
                                .size(30.dp)
                                .clip(CircleShape)
                                .softClickable { open = true }
                                .padding(4.dp),
                        )
                        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                            DropdownMenuItem(
                                text = { Text("No category") },
                                onClick = { open = false; onFile(null) },
                                trailingIcon = {
                                    if (channel.categoryId == null) {
                                        Icon(Icons.Rounded.Check, null, tint = colors.accent)
                                    }
                                },
                            )
                            categories.forEach { category ->
                                DropdownMenuItem(
                                    text = { Text(category.name) },
                                    onClick = { open = false; onFile(category.id) },
                                    trailingIcon = {
                                        if (channel.categoryId == category.id) {
                                            Icon(Icons.Rounded.Check, null, tint = colors.accent)
                                        }
                                    },
                                )
                            }
                        }
                    }
                }
                return@Row
            }

            if (silenced) {
                Spacer(Modifier.width(8.dp))
                Icon(
                    Icons.Rounded.NotificationsOff,
                    "Muted",
                    tint = colors.textTertiary,
                    modifier = Modifier.size(15.dp),
                )
            } else if (channel.notificationLevel == "mentions") {
                Spacer(Modifier.width(8.dp))
                Icon(
                    Icons.Rounded.AlternateEmail,
                    "Mentions only",
                    tint = colors.textTertiary,
                    modifier = Modifier.size(15.dp),
                )
            }

            // Mentions outrank a plain unread count: being named is the one
            // thing worth interrupting someone for.
            if (channel.mentionCount > 0) {
                Spacer(Modifier.width(8.dp))
                // Brand yellow, not danger red: red on violet reads as an
                // error, and being named is not one. See NeuColors.mention.
                Box(
                    Modifier.clip(CircleShape).background(colors.mention).padding(horizontal = 7.dp, vertical = 2.dp),
                ) {
                    Text(
                        "@${channel.mentionCount}",
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.onMention,
                    )
                }
            } else if (unread > 0) {
                Spacer(Modifier.width(8.dp))
                Box(
                    Modifier
                        .clip(CircleShape)
                        .background(colors.accent)
                        .padding(horizontal = 7.dp, vertical = 2.dp),
                ) {
                    Text(
                        if (unread > 99) "99+" else "$unread",
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.onAccent,
                    )
                }
            }
        }
    }
}
