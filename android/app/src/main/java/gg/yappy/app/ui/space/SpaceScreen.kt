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
import androidx.compose.material.icons.rounded.NotificationsOff
import androidx.compose.material.icons.rounded.People
import androidx.compose.material.icons.rounded.Tag
import androidx.compose.material.icons.rounded.Tune
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
import gg.yappy.app.data.RoleEntry
import gg.yappy.app.data.ChannelOverwrite
import gg.yappy.app.ui.components.flairColor
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
    var creating by remember { mutableStateOf(false) }
    var namingCategory by remember { mutableStateOf(false) }
    var newCategoryName by remember { mutableStateOf("") }
    var renamingCategory by remember { mutableStateOf<String?>(null) }
    var newChannelCategoryId by remember { mutableStateOf<String?>(null) }

    /**
     * Whether this viewer may create and arrange channels and categories:
     * MANAGE_CONVERSATION, or ADMINISTRATOR, which holds everything. Mirrors
     * the server rather than guessing from the ladder role, because a role
     * overwrite can grant it to somebody who is not an admin.
     */
    val canManage = (space?.permissions?.toLongOrNull() ?: 0L).let {
        it and (1L shl 36) != 0L || it and (1L shl 62) != 0L
    }
    var newTitle by remember { mutableStateOf("") }
    var newIsAnnouncement by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var reordering by remember { mutableStateOf(false) }
    var notifyTarget by remember { mutableStateOf<ChannelEntry?>(null) }
    var newIsVoice by remember { mutableStateOf(false) }
    var newIsBoard by remember { mutableStateOf(false) }
    var newIsForum by remember { mutableStateOf(false) }
    var newIsPrivate by remember { mutableStateOf(false) }
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
        launch {
            runCatching { container.repo.conversation(spaceId).conversation }.getOrNull()?.let {
                space = it
                container.screenSnapshots.put("space_$spaceId", it)
                seedChannelHeaders()
            }
            loading = false
        }
        launch {
            runCatching { container.repo.channels(spaceId) }.getOrNull()?.let { envelope ->
                val it = envelope.channels
                channels = it
                categories = envelope.categories
                container.screenSnapshots.put("space_categories_$spaceId", envelope.categories)
                container.screenSnapshots.put("space_channels_$spaceId", it)
                seedChannelHeaders()
            }
        }
    }

    Column(
        Modifier
            .fillMaxSize()
            .statusBarsPadding()
            .verticalScroll(rememberScrollState())
            .padding(bottom = 36.dp),
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
            if (channels.size > 1 || categories.isNotEmpty()) {
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

        // Inline, like the new-channel form below it: naming a divider is a
        // three-second act and does not deserve a dialog.
        if (namingCategory) {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                NeuTextField(
                    value = newCategoryName,
                    onValueChange = { newCategoryName = it },
                    placeholder = "Category name",
                    modifier = Modifier.weight(1f),
                )
                Spacer(Modifier.width(8.dp))
                Text(
                    "Add",
                    style = MaterialTheme.typography.labelLarge,
                    color = if (newCategoryName.isBlank()) colors.textTertiary else colors.accent,
                    modifier = Modifier
                        .clip(RoundedCornerShape(Neu.CornerSmall))
                        .softClickable {
                            val name = newCategoryName.trim()
                            if (name.isBlank()) return@softClickable
                            scope.launch {
                                runCatching { container.repo.createCategory(spaceId, name) }
                                newCategoryName = ""
                                namingCategory = false
                                refresh++
                            }
                        }
                        .padding(horizontal = 10.dp, vertical = 6.dp),
                )
                Text(
                    "Cancel",
                    style = MaterialTheme.typography.labelLarge,
                    color = colors.textTertiary,
                    modifier = Modifier
                        .clip(RoundedCornerShape(Neu.CornerSmall))
                        .softClickable { namingCategory = false; newCategoryName = "" }
                        .padding(horizontal = 10.dp, vertical = 6.dp),
                )
            }
        }

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
                onLongClick = { notifyTarget = channel },
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
                    if (categories.isNotEmpty()) {
                        // Where it lands. "No category" is a chip too, and the
                        // default, because loose above the dividers is where a
                        // channel belongs until somebody decides otherwise.
                        FlowRow(
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            (listOf<ChannelCategory?>(null) + categories).forEach { category ->
                                val picked = newChannelCategoryId == category?.id
                                Box(
                                    Modifier
                                        .clip(RoundedCornerShape(Neu.CornerPill))
                                        .background(if (picked) colors.accentSoft else colors.incoming)
                                        .softClickable { newChannelCategoryId = category?.id }
                                        .padding(horizontal = 12.dp, vertical = 7.dp),
                                ) {
                                    Text(
                                        category?.name ?: "No category",
                                        style = MaterialTheme.typography.labelMedium,
                                        color = if (picked) colors.accent else colors.textTertiary,
                                    )
                                }
                            }
                        }
                        Spacer(Modifier.height(10.dp))
                    }
                    FlowRow(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Box(
                            Modifier
                                .clip(RoundedCornerShape(Neu.CornerPill))
                                .background(
                                    if (newIsAnnouncement && !newIsVoice) colors.accentSoft else colors.incoming,
                                )
                                .softClickable { newIsAnnouncement = !newIsAnnouncement; newIsVoice = false }
                                .padding(horizontal = 12.dp, vertical = 7.dp),
                        ) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Icon(
                                    Icons.Rounded.Campaign,
                                    null,
                                    tint = if (newIsAnnouncement && !newIsVoice) colors.accent else colors.textTertiary,
                                    modifier = Modifier.size(16.dp),
                                )
                                Spacer(Modifier.width(6.dp))
                                Text(
                                    "Announcements",
                                    style = MaterialTheme.typography.labelMedium,
                                    color = if (newIsAnnouncement && !newIsVoice) colors.accent else colors.textTertiary,
                                )
                            }
                        }
                        Box(
                            Modifier
                                .clip(RoundedCornerShape(Neu.CornerPill))
                                .background(if (newIsBoard && !newIsVoice) colors.accentSoft else colors.incoming)
                                // A board brings the announcement floor with it
                                // rather than making somebody set two switches:
                                // a page of notices with a composer under it is
                                // a page nobody can keep tidy.
                                .softClickable {
                                    newIsBoard = !newIsBoard
                                    newIsVoice = false
                                    newIsForum = false
                                    newIsAnnouncement = false
                                }
                                .padding(horizontal = 12.dp, vertical = 7.dp),
                        ) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Icon(
                                    Icons.Rounded.PushPin,
                                    null,
                                    tint = if (newIsBoard && !newIsVoice) colors.accent else colors.textTertiary,
                                    modifier = Modifier.size(16.dp),
                                )
                                Spacer(Modifier.width(6.dp))
                                Text(
                                    "Board",
                                    style = MaterialTheme.typography.labelMedium,
                                    color = if (newIsBoard && !newIsVoice) colors.accent else colors.textTertiary,
                                )
                            }
                        }
                        Box(
                            Modifier
                                .clip(RoundedCornerShape(Neu.CornerPill))
                                .background(if (newIsForum && !newIsVoice) colors.accentSoft else colors.incoming)
                                // Unlike a board, a forum wants everyone
                                // posting — that is what it is for — so it
                                // does not bring the announcement floor.
                                .softClickable {
                                    newIsForum = !newIsForum
                                    newIsVoice = false
                                    newIsBoard = false
                                    newIsAnnouncement = false
                                }
                                .padding(horizontal = 12.dp, vertical = 7.dp),
                        ) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Icon(
                                    Icons.AutoMirrored.Rounded.List,
                                    null,
                                    tint = if (newIsForum && !newIsVoice) colors.accent else colors.textTertiary,
                                    modifier = Modifier.size(16.dp),
                                )
                                Spacer(Modifier.width(6.dp))
                                Text(
                                    "Forum",
                                    style = MaterialTheme.typography.labelMedium,
                                    color = if (newIsForum && !newIsVoice) colors.accent else colors.textTertiary,
                                )
                            }
                        }
                        Box(
                            Modifier
                                .clip(RoundedCornerShape(Neu.CornerPill))
                                .background(if (newIsVoice) colors.accentSoft else colors.incoming)
                                .softClickable {
                                    newIsVoice = !newIsVoice
                                    newIsAnnouncement = false
                                    newIsBoard = false
                                    newIsForum = false
                                }
                                .padding(horizontal = 12.dp, vertical = 7.dp),
                        ) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Icon(
                                    Icons.AutoMirrored.Rounded.VolumeUp,
                                    null,
                                    tint = if (newIsVoice) colors.accent else colors.textTertiary,
                                    modifier = Modifier.size(16.dp),
                                )
                                Spacer(Modifier.width(6.dp))
                                Text(
                                    "Voice",
                                    style = MaterialTheme.typography.labelMedium,
                                    color = if (newIsVoice) colors.accent else colors.textTertiary,
                                )
                            }
                        }
                        /*
                         * Private is not a fifth posture — it is orthogonal to
                         * the others, and a board or a forum can perfectly
                         * well be private. Voice and announcement are the
                         * exceptions: a call has no timeline to hide, and
                         * announcement is the same lever at a different floor.
                         */
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
    }

    // ── Per-channel notifications ────────────────────────────────────────────
    notifyTarget?.let { target ->
        val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
        ModalBottomSheet(
            onDismissRequest = { notifyTarget = null },
            sheetState = sheetState,
            containerColor = colors.surface,
            contentColor = colors.textPrimary,
        ) {
            Column(Modifier.padding(horizontal = 16.dp).padding(bottom = 30.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(bottom = 4.dp)) {
                    Icon(
                        when {
                            target.isBoard -> Icons.Rounded.PushPin
                            target.isForum -> Icons.AutoMirrored.Rounded.List
                            target.isAnnouncement -> Icons.Rounded.Campaign
                            else -> Icons.Rounded.Tag
                        },
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
                                    notifyTarget = null
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

                /*
                 * Who the channel is for.
                 *
                 * This sheet is where a channel is configured on a phone —
                 * there is no separate channel settings screen — so access
                 * belongs here beside notifications rather than behind a
                 * second long press somewhere else.
                 */
                // Mirrors the server: MANAGE_ROLES, or administrator, which
                // holds everything. Anyone else sees notifications and no more.
                val bits = space?.permissions?.toLongOrNull() ?: 0L
                val canManage =
                    bits and (1L shl 35) != 0L || bits and (1L shl 62) != 0L
                if (canManage) {
                    HorizontalDivider(
                        color = colors.hairline,
                        modifier = Modifier.padding(vertical = 12.dp),
                    )
                    ChannelAccessRows(
                        conversationId = target.id,
                        spaceId = spaceId,
                        gated = target.isPrivate,
                        onChanged = { refresh++ },
                    )

                    HorizontalDivider(
                        color = colors.hairline,
                        modifier = Modifier.padding(vertical = 12.dp),
                    )
                    WebhookRows(conversationId = target.id)
                }
            }
        }
    }
}

/**
 * Who a channel is for.
 *
 * Two settings that only mean something together. The floor applies to
 * everybody, so lowering it closes the channel to the whole space; a role
 * overwrite then lets one role back in *here*, which a space-wide role cannot
 * do because it applies everywhere.
 *
 * The bitfields stay out of the UI. "Only these roles" is what somebody
 * actually wants, and the two patterns behind it — floor at nothing, allow
 * view/read/send per role — are an implementation of that sentence rather than
 * a thing to configure.
 */
@Composable
private fun ChannelAccessRows(
    conversationId: String,
    spaceId: String,
    gated: Boolean,
    onChanged: () -> Unit,
) {
    val container = LocalContainer.current
    val colors = neuColors
    val scope = rememberCoroutineScope()

    var roles by remember(spaceId) { mutableStateOf<List<RoleEntry>?>(null) }
    var overwrites by remember(conversationId) {
        mutableStateOf<List<ChannelOverwrite>>(emptyList())
    }
    var isGated by remember(conversationId, gated) { mutableStateOf(gated) }
    var busy by remember { mutableStateOf(false) }

    LaunchedEffect(conversationId, spaceId) {
        roles = runCatching { container.repo.roles(spaceId).roles }.getOrDefault(emptyList())
        overwrites = runCatching { container.repo.channelOverwrites(conversationId).overwrites }
            .getOrDefault(emptyList())
    }

    Text(
        "Who can see this channel",
        style = MaterialTheme.typography.titleSmall,
        color = colors.textPrimary,
        modifier = Modifier.padding(horizontal = 8.dp),
    )
    Text(
        if (isGated) {
            "Only the roles you pick, plus admins."
        } else {
            "Everyone in the space, like every other channel."
        },
        style = MaterialTheme.typography.labelSmall,
        color = colors.textTertiary,
        modifier = Modifier.padding(horizontal = 8.dp).padding(bottom = 10.dp),
    )

    Row(
        Modifier.padding(horizontal = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        listOf(false to "Everyone", true to "Only these roles").forEach { (want, label) ->
            val picked = isGated == want
            Box(
                Modifier
                    .clip(RoundedCornerShape(Neu.CornerPill))
                    .background(if (picked) colors.accentSoft else colors.incoming)
                    .softClickable(enabled = !busy && !picked) {
                        busy = true
                        scope.launch {
                            runCatching {
                                if (want) {
                                    container.repo.setBasePermissions(conversationId, "0")
                                } else {
                                    container.repo.clearBasePermissions(conversationId)
                                }
                            }.onSuccess {
                                isGated = want
                                onChanged()
                            }
                            busy = false
                        }
                    }
                    .padding(horizontal = 14.dp, vertical = 8.dp),
            ) {
                Text(
                    label,
                    style = MaterialTheme.typography.labelMedium,
                    color = if (picked) colors.accent else colors.textSecondary,
                )
            }
        }
    }

    if (!isGated) return

    val list = roles
    when {
        list == null -> Text(
            "Loading roles…",
            style = MaterialTheme.typography.labelSmall,
            color = colors.textTertiary,
            modifier = Modifier.padding(8.dp),
        )

        list.isEmpty() -> Text(
            "This space has no roles yet. Make one first — a channel for nobody " +
                "is a channel nobody can read, including you tomorrow.",
            style = MaterialTheme.typography.labelSmall,
            color = colors.textTertiary,
            modifier = Modifier.padding(8.dp),
        )

        else -> list.forEach { role ->
            val allow = overwrites.firstOrNull { it.roleId == role.id }?.allow?.toLongOrNull() ?: 0L
            val on = allow and CHANNEL_VIEW != 0L
            Row(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(Neu.CornerSmall))
                    .softClickable(enabled = !busy) {
                        busy = true
                        scope.launch {
                            runCatching {
                                if (on) {
                                    container.repo.removeChannelOverwrite(conversationId, role.id)
                                    overwrites = overwrites.filterNot { it.roleId == role.id }
                                } else {
                                    val saved = container.repo.setChannelOverwrite(
                                        conversationId,
                                        role.id,
                                        allow = CHANNEL_ACCESS.toString(),
                                    ).overwrite
                                    overwrites =
                                        overwrites.filterNot { it.roleId == role.id } + saved
                                }
                            }
                            onChanged()
                            busy = false
                        }
                    }
                    .padding(vertical = 10.dp, horizontal = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(
                    Modifier
                        .size(7.dp)
                        .clip(CircleShape)
                        .background(flairColor(role.color) ?: colors.textTertiary),
                )
                Spacer(Modifier.width(10.dp))
                Text(
                    role.name,
                    style = MaterialTheme.typography.bodyLarge,
                    color = flairColor(role.color) ?: colors.textPrimary,
                    modifier = Modifier.weight(1f),
                )
                if (on) {
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
}

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

    hooks.forEach { hook ->
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
            Text(
                "remove",
                style = MaterialTheme.typography.labelSmall,
                color = colors.danger,
                modifier = Modifier
                    .clip(RoundedCornerShape(Neu.CornerSmall))
                    .softClickable(enabled = !busy) {
                        busy = true
                        scope.launch {
                            runCatching { container.repo.deleteWebhook(conversationId, hook.id) }
                            hooks = hooks.filterNot { it.id == hook.id }
                            if (minted?.id == hook.id) minted = null
                            busy = false
                        }
                    }
                    .padding(6.dp),
            )
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

/** What "let this role in" grants: see it, read it, speak in it. */
private const val CHANNEL_VIEW = 1L shl 0
private const val CHANNEL_ACCESS = (1L shl 0) or (1L shl 1) or (1L shl 2)

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
                color = colors.accent,
                modifier = Modifier
                    .clip(RoundedCornerShape(Neu.CornerPill))
                    .background(colors.accentSoft)
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
            Icon(
                Icons.Rounded.Delete,
                "Delete ${category.name}",
                tint = colors.textTertiary,
                modifier = Modifier
                    .size(28.dp)
                    .clip(CircleShape)
                    .softClickable { onDelete() }
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
        onClick = if (reordering) ({ }) else onClick,
        onLongClick = if (reordering) null else onLongClick,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(
                when {
                    channel.isVoice -> Icons.AutoMirrored.Rounded.VolumeUp
                    // Before the announcement case: a board is
                    // announcement-floored, and left to the megaphone it
                    // reads as "an announcement channel" in every list,
                    // which is the one thing it is not.
                    channel.isBoard -> Icons.Rounded.PushPin
                    channel.isForum -> Icons.AutoMirrored.Rounded.List
                    channel.isAnnouncement -> Icons.Rounded.Campaign
                    else -> Icons.Rounded.Tag
                },
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
                Box(
                    Modifier.clip(CircleShape).background(colors.danger).padding(horizontal = 7.dp, vertical = 2.dp),
                ) {
                    Text(
                        "@${channel.mentionCount}",
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.onAccent,
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
