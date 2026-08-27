package gg.yappy.app.ui.space

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
import androidx.compose.material.icons.automirrored.rounded.VolumeUp
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.AlternateEmail
import androidx.compose.material.icons.rounded.Campaign
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.KeyboardArrowDown
import androidx.compose.material.icons.rounded.KeyboardArrowUp
import androidx.compose.material.icons.rounded.Mic
import androidx.compose.material.icons.rounded.MicOff
import androidx.compose.material.icons.rounded.NotificationsOff
import androidx.compose.material.icons.rounded.People
import androidx.compose.material.icons.rounded.Tag
import androidx.compose.material.icons.rounded.Tune
import androidx.compose.material3.CircularProgressIndicator
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

/**
 * A space: its channels, and the way into its people and settings.
 *
 * This is the screen that makes a space feel like a *place with rooms* rather
 * than a folder. The channel list is the content — everything else (members,
 * settings, voice) is chrome around it — so the channels get the full-width
 * rows and the accent, and the rest is deliberately quiet.
 */
@OptIn(ExperimentalMaterial3Api::class)
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
    var loading by remember { mutableStateOf(space == null) }
    var refresh by remember { mutableStateOf(0) }
    var creating by remember { mutableStateOf(false) }
    var newTitle by remember { mutableStateOf("") }
    var newIsAnnouncement by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var reordering by remember { mutableStateOf(false) }
    var notifyTarget by remember { mutableStateOf<ChannelEntry?>(null) }
    var newIsVoice by remember { mutableStateOf(false) }

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
            runCatching { container.repo.channels(spaceId).channels }.getOrNull()?.let {
                channels = it
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
            if (channels.size > 1) {
                Text(
                    if (reordering) "Done" else "Reorder",
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

        Column(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            channels.forEachIndexed { index, channel ->
                ChannelRow(
                    channel = channel,
                    accent = s.appearance?.titleColor(),
                    reordering = reordering,
                    canMoveUp = index > 0,
                    canMoveDown = index < channels.lastIndex,
                    connectedVoice = voiceSession?.channelId == channel.id,
                    onClick = {
                        if (channel.isVoice) joinVoiceChannel(channel) else onOpenChannel(channel.id)
                    },
                    onLongClick = { notifyTarget = channel },
                    onMove = { delta ->
                        // Reordered locally first so the list does not jump
                        // under the finger while the round trip completes.
                        val next = channels.toMutableList()
                        val to = index + delta
                        next.add(to, next.removeAt(index))
                        channels = next
                        scope.launch {
                            runCatching { container.repo.reorderChannels(spaceId, next.map { it.id }) }
                                .onFailure { refresh++ }
                        }
                    },
                )
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
                    Row(verticalAlignment = Alignment.CenterVertically) {
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
                        Spacer(Modifier.width(8.dp))
                        Box(
                            Modifier
                                .clip(RoundedCornerShape(Neu.CornerPill))
                                .background(if (newIsVoice) colors.accentSoft else colors.incoming)
                                .softClickable { newIsVoice = !newIsVoice; newIsAnnouncement = false }
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
                        Spacer(Modifier.weight(1f))
                        Text(
                            "Cancel",
                            style = MaterialTheme.typography.labelLarge,
                            color = colors.textTertiary,
                            modifier = Modifier
                                .clip(RoundedCornerShape(Neu.CornerSmall))
                                .softClickable { creating = false; newTitle = "" }
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
                                        runCatching {
                                            container.repo.createChannel(
                                                spaceId, newTitle.trim(), newIsAnnouncement, channels.size,
                                                isVoice = newIsVoice,
                                            )
                                        }
                                        busy = false
                                        newTitle = ""
                                        newIsAnnouncement = false
                                        newIsVoice = false
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
                        if (target.isAnnouncement) Icons.Rounded.Campaign else Icons.Rounded.Tag,
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
            }
        }
    }
}

/** level, label, and what it actually means — the third column is the point. */
private val NOTIFY_LEVELS = listOf(
    Triple("all", "Everything", "Every message in this channel"),
    Triple("mentions", "Only mentions", "When someone names you"),
    Triple("none", "Nothing", "Still unread, just silent"),
)

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
                Text(
                    channel.title ?: "channel",
                    style = MaterialTheme.typography.titleSmall.copy(
                        fontWeight = if (unread > 0) FontWeight.Bold else FontWeight.Medium,
                    ),
                    color = if (connectedVoice) colors.success else colors.textPrimary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
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
