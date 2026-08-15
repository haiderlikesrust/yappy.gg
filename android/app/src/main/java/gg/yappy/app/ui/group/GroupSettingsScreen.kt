package gg.yappy.app.ui.group

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
import androidx.compose.material.icons.rounded.AutoAwesome
import androidx.compose.material.icons.rounded.Block
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.Link
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
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
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import gg.yappy.app.LocalContainer
import gg.yappy.app.data.Conversation
import gg.yappy.app.data.ConversationAppearance
import gg.yappy.app.data.DirectoryBot
import gg.yappy.app.data.RoleEntry
import gg.yappy.app.ui.components.Avatar
import gg.yappy.app.ui.components.EditableAvatar
import gg.yappy.app.ui.components.FlairAvatar
import gg.yappy.app.ui.components.BadgeMark
import gg.yappy.app.ui.components.NeuButton
import gg.yappy.app.ui.components.NeuChip
import gg.yappy.app.ui.components.NeuIconButton
import gg.yappy.app.ui.components.NeuSurface
import gg.yappy.app.ui.components.NeuSwitch
import gg.yappy.app.ui.components.NeuTextField
import gg.yappy.app.ui.components.SectionLabel
import gg.yappy.app.ui.components.flairColor
import gg.yappy.app.ui.components.softClickable
import gg.yappy.app.ui.components.titleColor
import gg.yappy.app.ui.theme.Neu
import gg.yappy.app.ui.theme.neuColors
import kotlinx.coroutines.launch

/**
 * Group settings — identity, flair, access.
 *
 * Flair edits are staged locally and rendered in a live "how it shows on the
 * list" preview, then applied in one PATCH. Staging matters: someone trying
 * five gradients should not broadcast five ConversationUpdate events to every
 * member's phone.
 */

private val GRADIENT_PRESETS: List<Pair<String, String>?> = listOf(
    null, // no flair
    "#6C5CE7" to "#00CEC9",
    "#FF7675" to "#FDCB6E",
    "#00B894" to "#55EFC4",
    "#0984E3" to "#74B9FF",
    "#E84393" to "#FD79A8",
    "#2D3436" to "#6C5CE7",
)

private val EMOJI_PRESETS = listOf(null, "⚡", "🔥", "🌊", "🌸", "👾", "🎮", "🚀", "💜")

/**
 * Permission bits, mirrored from the server's `Permission` map.
 *
 * Duplicated rather than fetched because they are part of the wire format and
 * cannot change without a coordinated release anyway — and a client that has
 * to round-trip before it can render a checkbox is a client that renders
 * nothing offline.
 */
private object Perm {
    const val PIN_MESSAGES = 1L shl 14
    const val DELETE_ANY_MESSAGE = 1L shl 13
    const val MENTION_ALL = 1L shl 9
    const val KICK_MEMBERS = 1L shl 32
    const val MUTE_MEMBERS = 1L shl 34
    const val BAN_MEMBERS = 1L shl 33
    const val MANAGE_INVITES = 1L shl 31
    const val MANAGE_CONVERSATION = 1L shl 36
}

/**
 * What roles are actually used for, rather than every bit the server knows.
 *
 * A phone-sized screen cannot present forty independent switches usefully, and
 * a badly-configured role is worse than a coarse one — so this offers three
 * shapes people recognise. The API takes arbitrary bitfields for anyone who
 * needs something else.
 */
private val ROLE_PRESETS: List<Pair<String, Long>> = listOf(
    "Cosmetic" to 0L,
    "Trusted" to (Perm.PIN_MESSAGES or Perm.MENTION_ALL),
    "Moderator" to (
        Perm.PIN_MESSAGES or Perm.MENTION_ALL or Perm.DELETE_ANY_MESSAGE or
            Perm.MUTE_MEMBERS or Perm.KICK_MEMBERS
        ),
)

private val ROLE_COLORS = listOf("#8B7CFF", "#22C55E", "#F59E0B", "#EF4444", "#06B6D4", "#EC4899")

private fun permissionSummary(permissions: String): String {
    val bits = permissions.toLongOrNull() ?: 0L
    if (bits == 0L) return "Colour and label only"
    val names = buildList {
        if (bits and Perm.PIN_MESSAGES != 0L) add("pin")
        if (bits and Perm.DELETE_ANY_MESSAGE != 0L) add("delete any")
        if (bits and Perm.MENTION_ALL != 0L) add("mention all")
        if (bits and Perm.MUTE_MEMBERS != 0L) add("mute")
        if (bits and Perm.KICK_MEMBERS != 0L) add("kick")
        if (bits and Perm.BAN_MEMBERS != 0L) add("ban")
        if (bits and Perm.MANAGE_INVITES != 0L) add("invites")
        if (bits and Perm.MANAGE_CONVERSATION != 0L) add("settings")
    }
    return if (names.isEmpty()) "Custom permissions" else names.joinToString(" · ")
}

@Composable
fun GroupSettingsScreen(conversationId: String, onBack: () -> Unit) {
    val container = LocalContainer.current
    val colors = neuColors
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboardManager.current

    var conversation by remember { mutableStateOf<Conversation?>(null) }
    var title by remember { mutableStateOf("") }
    var description by remember { mutableStateOf("") }
    var staged by remember { mutableStateOf<ConversationAppearance?>(null) }
    var inviteUrl by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var savedTick by remember { mutableStateOf(false) }
    var logoBusy by remember { mutableStateOf(false) }
    var roles by remember { mutableStateOf<List<RoleEntry>>(emptyList()) }
    var newRoleName by remember { mutableStateOf("") }
    var newRoleColor by remember { mutableStateOf<String?>(ROLE_COLORS.first()) }
    var newRolePerms by remember { mutableStateOf(ROLE_PRESETS.first().second) }
    var firstChannel by remember { mutableStateOf("general") }
    var confirmUpgrade by remember { mutableStateOf(false) }
    var upgrading by remember { mutableStateOf(false) }
    var bansOpen by remember { mutableStateOf(false) }
    var invitesOpen by remember { mutableStateOf(false) }
    var botPickerOpen by remember { mutableStateOf(false) }
    var verifyOpen by androidx.compose.runtime.saveable.rememberSaveable { mutableStateOf(false) }
    var idCopied by remember { mutableStateOf(false) }
    var yapperUserId by remember { mutableStateOf<String?>(null) }
    var yapperIsMember by remember { mutableStateOf(false) }
    var yapperBusy by remember { mutableStateOf(false) }

    LaunchedEffect(conversationId) {
        val conv = runCatching { container.repo.conversation(conversationId).conversation }.getOrNull()
        conversation = conv
        title = conv?.title.orEmpty()
        description = conv?.description.orEmpty()
        staged = conv?.appearance
        inviteUrl = runCatching { container.repo.invites(conversationId).invites.firstOrNull()?.url }.getOrNull()
        roles = runCatching { container.repo.roles(conversationId).roles }.getOrDefault(emptyList())
        // yapper's row needs two facts: its user id (from the directory, like
        // any public bot) and whether it is already in this group.
        yapperUserId = runCatching { container.repo.botDirectory().bots }.getOrDefault(emptyList())
            .firstOrNull { it.user?.username == "yapper" }?.botUserId
        yapperIsMember = runCatching { container.repo.members(conversationId).members }
            .getOrDefault(emptyList())
            .any { it.user.username == "yapper" && it.user.isBot }
    }

    val conv = conversation
    Column(
        Modifier
            .fillMaxSize()
            .statusBarsPadding()
            .verticalScroll(rememberScrollState()),
    ) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            NeuIconButton(Icons.AutoMirrored.Rounded.ArrowBack, "Back", onBack, size = 42.dp, iconSize = 19.dp)
            Spacer(Modifier.width(14.dp))
            Text(
                if (conversation?.isSpace == true) "Space settings" else "Group settings",
                style = MaterialTheme.typography.headlineSmall,
                color = colors.textPrimary,
            )
        }

        if (conv == null) {
            Box(Modifier.fillMaxWidth().height(280.dp), Alignment.Center) {
                CircularProgressIndicator(color = colors.accent)
            }
            return@Column
        }

        // ── The logo ─────────────────────────────────────────────────────────
        // Above the preview, because it is the thing the preview is previewing.
        Spacer(Modifier.height(8.dp))
        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
            EditableAvatar(
                url = conv.displayAvatar,
                name = title.ifBlank { conv.displayName },
                id = conv.avatarSeed,
                size = 92.dp,
                shape = gg.yappy.app.ui.theme.PlaceShape,
                busy = logoBusy,
                onPicked = { uri ->
                    scope.launch {
                        logoBusy = true
                        runCatching {
                            val up = container.uploader.upload(uri, purpose = "conversation_avatar")
                            container.repo.setConversationAvatar(conversationId, up.mediaId).conversation
                        }.onSuccess { conversation = it }
                        logoBusy = false
                    }
                },
            )
        }
        Spacer(Modifier.height(16.dp))

        // ── Live preview: exactly the row the list will render ───────────────
        Spacer(Modifier.height(6.dp))
        SectionLabel("How it shows on the list", Modifier.padding(start = 24.dp))
        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp)
                .clip(RoundedCornerShape(Neu.CornerMedium))
                .background(colors.incoming)
                .padding(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            FlairAvatar(
                appearance = staged,
                url = conv.displayAvatar,
                name = title.ifBlank { conv.displayName },
                id = conv.avatarSeed,
                size = 52.dp,
                shape = gg.yappy.app.ui.theme.PlaceShape,
            )
            Spacer(Modifier.width(13.dp))
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        title.ifBlank { conv.displayName },
                        style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.SemiBold),
                        color = staged?.titleColor() ?: colors.textPrimary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    staged?.emoji?.let {
                        Spacer(Modifier.width(5.dp))
                        Text(it, style = MaterialTheme.typography.titleMedium)
                    }
                }
                Text(
                    "the last message shows here",
                    style = MaterialTheme.typography.bodyMedium,
                    color = colors.textTertiary,
                )
            }
        }

        // ── Identity ─────────────────────────────────────────────────────────
        Spacer(Modifier.height(22.dp))
        SectionLabel("Identity", Modifier.padding(start = 24.dp))
        Column(Modifier.padding(horizontal = 20.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            NeuTextField(title, { title = it }, placeholder = "Group name", modifier = Modifier.fillMaxWidth())
            NeuTextField(
                description,
                { description = it },
                placeholder = "Description",
                singleLine = false,
                maxLines = 3,
                modifier = Modifier.fillMaxWidth(),
            )
        }

        /**
         * ── Verification ─────────────────────────────────────────────────────
         *
         * Owner/admin only, like the request itself: showing a member a door
         * the server would slam is not a feature. The id row is here because
         * the id is how anything outside the app names this group — staff
         * grant with it, bots address it — and hunting it out of a URL was
         * the old way.
         */
        val amAdmin = conv.self?.role == "owner" || conv.self?.role == "admin"
        if (amAdmin && !conv.isSpace) {
            Spacer(Modifier.height(22.dp))
            SectionLabel("Verification", Modifier.padding(start = 24.dp))
            Column(Modifier.padding(horizontal = 20.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                if (conv.badge != null) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        BadgeMark(conv.badge, size = 16.dp)
                        Spacer(Modifier.width(8.dp))
                        Text(
                            "This group is ${conv.badge}. Admins can affiliate members from the group page.",
                            style = MaterialTheme.typography.bodyMedium,
                            color = colors.textSecondary,
                        )
                    }
                } else {
                    NeuButton(onClick = { verifyOpen = true }, modifier = Modifier.fillMaxWidth()) {
                        Text(
                            "Request verification",
                            style = MaterialTheme.typography.labelLarge,
                            color = colors.textPrimary,
                        )
                    }
                }
                NeuButton(
                    onClick = {
                        clipboard.setText(AnnotatedString(conversationId))
                        idCopied = true
                    },
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(
                        if (idCopied) "Copied" else "Copy group ID",
                        style = MaterialTheme.typography.labelLarge,
                        color = if (idCopied) colors.accent else colors.textPrimary,
                    )
                }
            }
        }

        // ── Flair ────────────────────────────────────────────────────────────
        Spacer(Modifier.height(22.dp))
        SectionLabel("Flair", Modifier.padding(start = 24.dp))

        Row(
            Modifier.fillMaxWidth().padding(horizontal = 20.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            GRADIENT_PRESETS.forEach { preset ->
                val selected = staged?.gradient?.let { it.getOrNull(0) == preset?.first && it.getOrNull(1) == preset?.second }
                    ?: (preset == null && staged?.gradient == null)
                Box(
                    Modifier
                        .size(40.dp)
                        .clip(CircleShape)
                        .background(
                            preset?.let {
                                Brush.linearGradient(
                                    listOf(
                                        flairColor(it.first) ?: colors.accent,
                                        flairColor(it.second) ?: colors.accent,
                                    ),
                                )
                            } ?: Brush.linearGradient(listOf(colors.incoming, colors.incoming)),
                        )
                        .softClickable {
                            staged = if (preset == null) {
                                staged?.copy(gradient = null, accent = null)
                            } else {
                                (staged ?: ConversationAppearance()).copy(
                                    gradient = listOf(preset.first, preset.second),
                                    accent = preset.first,
                                )
                            }
                        },
                    contentAlignment = Alignment.Center,
                ) {
                    if (selected) {
                        Icon(
                            Icons.Rounded.Check,
                            null,
                            tint = if (preset == null) colors.textSecondary else androidx.compose.ui.graphics.Color.White,
                            modifier = Modifier.size(16.dp),
                        )
                    }
                }
            }
        }

        Spacer(Modifier.height(12.dp))
        Row(
            Modifier.padding(horizontal = 20.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            listOf("none" to "Still", "glow" to "Glow", "shimmer" to "Shimmer").forEach { (key, label) ->
                NeuChip(
                    label,
                    selected = (staged?.effect ?: "none") == key,
                    onClick = { staged = (staged ?: ConversationAppearance()).copy(effect = key) },
                )
            }
        }

        Spacer(Modifier.height(12.dp))
        Row(
            Modifier.padding(horizontal = 20.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            EMOJI_PRESETS.forEach { emoji ->
                val selected = staged?.emoji == emoji
                Box(
                    Modifier
                        .size(38.dp)
                        .clip(CircleShape)
                        .background(if (selected) colors.accentSoft else colors.incoming)
                        .softClickable { staged = (staged ?: ConversationAppearance()).copy(emoji = emoji) },
                    contentAlignment = Alignment.Center,
                ) {
                    Text(emoji ?: "–", style = MaterialTheme.typography.titleSmall)
                }
            }
        }

        // ── Access ───────────────────────────────────────────────────────────
        Spacer(Modifier.height(22.dp))
        SectionLabel("Access", Modifier.padding(start = 24.dp))
        NeuSurface(
            Modifier.fillMaxWidth().padding(horizontal = 20.dp),
            shape = RoundedCornerShape(Neu.CornerMedium),
            contentPadding = 14.dp,
        ) {
            Column {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Public group", style = MaterialTheme.typography.bodyLarge, color = colors.textPrimary)
                        Text(
                            "Anyone with the link can join",
                            style = MaterialTheme.typography.labelSmall,
                            color = colors.textTertiary,
                        )
                    }
                    NeuSwitch(
                        checked = conv.isPublic,
                        onCheckedChange = { next ->
                            scope.launch {
                                runCatching { container.repo.setPublic(conversationId, next).conversation }
                                    .onSuccess { conversation = it }
                            }
                        },
                    )
                }

                Spacer(Modifier.height(14.dp))

                val url = inviteUrl
                if (url == null) {
                    NeuButton(
                        onClick = {
                            scope.launch {
                                runCatching { container.repo.createInvite(conversationId).invite.url }
                                    .onSuccess { inviteUrl = it }
                            }
                        },
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Icon(Icons.Rounded.Link, null, tint = colors.textSecondary, modifier = Modifier.size(17.dp))
                        Spacer(Modifier.width(8.dp))
                        Text("Create invite link", style = MaterialTheme.typography.labelLarge, color = colors.textSecondary)
                    }
                } else {
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(Neu.CornerSmall))
                            .background(colors.incoming)
                            .softClickable { clipboard.setText(AnnotatedString(url)) }
                            .padding(horizontal = 12.dp, vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(Icons.Rounded.Link, null, tint = colors.accent, modifier = Modifier.size(16.dp))
                        Spacer(Modifier.width(10.dp))
                        Text(
                            url,
                            style = MaterialTheme.typography.bodyMedium,
                            color = colors.textSecondary,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f),
                        )
                        Text("copy", style = MaterialTheme.typography.labelSmall, color = colors.accent)
                    }
                }

                Spacer(Modifier.height(10.dp))
                Text(
                    "Manage links",
                    style = MaterialTheme.typography.labelMedium,
                    color = colors.accent,
                    modifier = Modifier.softClickable { invitesOpen = true },
                )
            }
        }

        // ── Moderation ───────────────────────────────────────────────────────
        Spacer(Modifier.height(22.dp))
        SectionLabel("Moderation", Modifier.padding(start = 24.dp))
        NeuSurface(
            Modifier.fillMaxWidth().padding(horizontal = 20.dp),
            shape = RoundedCornerShape(Neu.CornerMedium),
            contentPadding = 14.dp,
        ) {
            Column {
                // Announcement mode is a permission *floor*, not a lock: roles
                // hand posting back to the people who should still have it.
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(
                            "Only admins can post",
                            style = MaterialTheme.typography.bodyLarge,
                            color = colors.textPrimary,
                        )
                        Text(
                            "Everyone can still read and react. A role can grant posting back.",
                            style = MaterialTheme.typography.labelSmall,
                            color = colors.textTertiary,
                        )
                    }
                    NeuSwitch(
                        checked = BaseFloor.isAnnouncement(conv.permissions),
                        onCheckedChange = { next ->
                            scope.launch {
                                val bits = if (next) BaseFloor.ANNOUNCEMENT else BaseFloor.MEMBER
                                runCatching {
                                    container.repo.setBasePermissions(conversationId, bits.toString())
                                        .conversation
                                }.onSuccess { conversation = it }
                            }
                        },
                    )
                }

                Spacer(Modifier.height(16.dp))

                // Slow mode. The steps are the ones people actually reach for;
                // an arbitrary number field invites 7-second slow mode.
                Text("Slow mode", style = MaterialTheme.typography.bodyLarge, color = colors.textPrimary)
                Text(
                    "How long a member waits between messages",
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.textTertiary,
                )
                Spacer(Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf(
                        0 to "Off",
                        5 to "5s",
                        30 to "30s",
                        300 to "5m",
                        3_600 to "1h",
                    ).forEach { (seconds, label) ->
                        NeuChip(
                            label,
                            conv.slowModeSeconds == seconds,
                            onClick = {
                                scope.launch {
                                    runCatching { container.repo.setSlowMode(conversationId, seconds).conversation }
                                        .onSuccess { conversation = it }
                                }
                            },
                        )
                    }
                }

                Spacer(Modifier.height(16.dp))
                Row(
                    Modifier
                        .fillMaxWidth()
                        .softClickable { bansOpen = true }
                        .padding(vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(Icons.Rounded.Block, null, tint = colors.textSecondary, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        Text(
                            "Banned people",
                            style = MaterialTheme.typography.bodyLarge,
                            color = colors.textPrimary,
                        )
                        Text(
                            "Review who is banned, and let someone back in",
                            style = MaterialTheme.typography.labelSmall,
                            color = colors.textTertiary,
                        )
                    }
                }
            }
        }

        // ── Roles ────────────────────────────────────────────────────────────
        Spacer(Modifier.height(22.dp))
        SectionLabel("Roles", Modifier.padding(start = 24.dp))
        NeuSurface(
            Modifier.fillMaxWidth().padding(horizontal = 20.dp),
            shape = RoundedCornerShape(Neu.CornerMedium),
            contentPadding = 14.dp,
        ) {
            Column {
                Text(
                    "Roles say what someone can do. Who outranks whom is still owner, admin, then moderator.",
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.textTertiary,
                )
                Spacer(Modifier.height(12.dp))

                roles.forEach { role ->
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .padding(vertical = 7.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Box(
                            Modifier
                                .size(11.dp)
                                .clip(CircleShape)
                                .background(flairColor(role.color) ?: colors.textTertiary),
                        )
                        Spacer(Modifier.width(10.dp))
                        Column(Modifier.weight(1f)) {
                            Text(
                                role.name,
                                style = MaterialTheme.typography.bodyLarge,
                                color = flairColor(role.color) ?: colors.textPrimary,
                            )
                            Text(
                                permissionSummary(role.permissions),
                                style = MaterialTheme.typography.labelSmall,
                                color = colors.textTertiary,
                            )
                        }
                        Text(
                            "remove",
                            style = MaterialTheme.typography.labelSmall,
                            color = colors.danger,
                            modifier = Modifier
                                .clip(RoundedCornerShape(Neu.CornerSmall))
                                .softClickable {
                                    scope.launch {
                                        runCatching { container.repo.deleteRole(conversationId, role.id) }
                                        roles = runCatching { container.repo.roles(conversationId).roles }
                                            .getOrDefault(roles)
                                    }
                                }
                                .padding(horizontal = 8.dp, vertical = 4.dp),
                        )
                    }
                }

                if (roles.isEmpty()) {
                    Text(
                        "No roles yet.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = colors.textTertiary,
                        modifier = Modifier.padding(vertical = 6.dp),
                    )
                }

                Spacer(Modifier.height(10.dp))
                NeuTextField(
                    value = newRoleName,
                    onValueChange = { newRoleName = it },
                    placeholder = "New role name",
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(10.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    ROLE_COLORS.forEach { hex ->
                        val picked = newRoleColor == hex
                        Box(
                            Modifier
                                .size(if (picked) 30.dp else 26.dp)
                                .clip(CircleShape)
                                .background(flairColor(hex) ?: colors.accent)
                                .softClickable { newRoleColor = hex },
                        )
                    }
                }
                Spacer(Modifier.height(10.dp))
                // A short list of what a role is usually *for*. The full 40-bit
                // matrix belongs on a bigger screen than a phone.
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    ROLE_PRESETS.forEach { (label, bits) ->
                        val picked = newRolePerms == bits
                        Box(
                            Modifier
                                .clip(RoundedCornerShape(Neu.CornerPill))
                                .background(if (picked) colors.accentSoft else colors.incoming)
                                .softClickable { newRolePerms = bits }
                                .padding(horizontal = 12.dp, vertical = 7.dp),
                        ) {
                            Text(
                                label,
                                style = MaterialTheme.typography.labelMedium,
                                color = if (picked) colors.accent else colors.textTertiary,
                            )
                        }
                    }
                }
                Spacer(Modifier.height(12.dp))
                NeuButton(
                    onClick = {
                        if (newRoleName.isBlank()) return@NeuButton
                        scope.launch {
                            runCatching {
                                container.repo.createRole(
                                    conversationId,
                                    newRoleName.trim(),
                                    newRoleColor,
                                    newRolePerms.toString(),
                                    position = roles.size,
                                    isHoisted = true,
                                )
                            }
                            newRoleName = ""
                            roles = runCatching { container.repo.roles(conversationId).roles }.getOrDefault(roles)
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text("Add role", style = MaterialTheme.typography.labelLarge, color = colors.textSecondary)
                }
            }
        }

        // ── Become a space ───────────────────────────────────────────────────
        // Only for an ordinary group, and only for its owner. Presented with
        // what actually happens spelled out — it moves everyone's history, and
        // there is no button to undo it.
        if (conv.type == "group" && conv.self?.role == "owner") {
            Spacer(Modifier.height(22.dp))
            SectionLabel("Channels", Modifier.padding(start = 24.dp))
            NeuSurface(
                Modifier.fillMaxWidth().padding(horizontal = 20.dp),
                shape = RoundedCornerShape(Neu.CornerMedium),
                contentPadding = 14.dp,
            ) {
                Column {
                    Text(
                        "Turn this group into a space",
                        style = MaterialTheme.typography.bodyLarge,
                        color = colors.textPrimary,
                    )
                    Spacer(Modifier.height(4.dp))
                    Text(
                        "A space holds several channels. Everyone stays a member, roles and " +
                            "invite links keep working, and this group's messages move into its " +
                            "first channel. It cannot be undone.",
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.textTertiary,
                    )
                    Spacer(Modifier.height(12.dp))
                    NeuTextField(
                        value = firstChannel,
                        onValueChange = { firstChannel = it },
                        placeholder = "general",
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(Modifier.height(10.dp))
                    NeuButton(
                        onClick = {
                            if (upgrading) return@NeuButton
                            // Two taps, because it is irreversible and the first
                            // tap is often curiosity rather than intent.
                            if (!confirmUpgrade) { confirmUpgrade = true; return@NeuButton }
                            upgrading = true
                            scope.launch {
                                runCatching {
                                    container.repo.upgradeToSpace(
                                        conversationId,
                                        firstChannel.trim().ifBlank { "general" },
                                    )
                                }.onSuccess { onBack() }
                                upgrading = false
                            }
                        },
                        accent = confirmUpgrade,
                        enabled = !upgrading,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text(
                            when {
                                upgrading -> "Converting…"
                                confirmUpgrade -> "Tap again to convert"
                                else -> "Convert to a space"
                            },
                            style = MaterialTheme.typography.labelLarge,
                            color = if (confirmUpgrade) colors.onAccent else colors.textSecondary,
                        )
                    }
                }
            }
        }

        // ── Bots ─────────────────────────────────────────────────────────────
        Spacer(Modifier.height(22.dp))
        SectionLabel("Bots", Modifier.padding(start = 24.dp))
        NeuSurface(
            Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(top = 8.dp),
            shape = RoundedCornerShape(Neu.CornerMedium),
            contentPadding = 16.dp,
        ) {
            Column {
                // yapper first: the one bot that ships with the app. Mentioning
                // it is the only thing that wakes it, and that is the pitch.
                if (yapperUserId != null) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(
                            Icons.Rounded.AutoAwesome,
                            null,
                            tint = colors.accent,
                            modifier = Modifier.size(20.dp),
                        )
                        Spacer(Modifier.width(10.dp))
                        Column(Modifier.weight(1f)) {
                            Text(
                                "yapper",
                                style = MaterialTheme.typography.titleSmall,
                                color = colors.textPrimary,
                            )
                            Text(
                                if (yapperIsMember) "In this group — mention @yapper to ask it anything."
                                else "The group's AI. Answers only when someone mentions @yapper.",
                                style = MaterialTheme.typography.bodySmall,
                                color = colors.textTertiary,
                            )
                        }
                        Spacer(Modifier.width(10.dp))
                        NeuButton(
                            onClick = {
                                val botId = yapperUserId ?: return@NeuButton
                                if (yapperBusy) return@NeuButton
                                yapperBusy = true
                                scope.launch {
                                    runCatching {
                                        if (yapperIsMember) container.repo.removeMember(conversationId, botId)
                                        else container.repo.addMembers(conversationId, listOf(botId))
                                    }.onSuccess { yapperIsMember = !yapperIsMember }
                                    yapperBusy = false
                                }
                            },
                            accent = !yapperIsMember,
                            enabled = !yapperBusy,
                        ) {
                            Text(
                                if (yapperIsMember) "Remove" else "Add",
                                style = MaterialTheme.typography.labelLarge,
                                color = if (yapperIsMember) colors.textSecondary else colors.onAccent,
                            )
                        }
                    }
                    Spacer(Modifier.height(14.dp))
                    HorizontalDivider(color = colors.textTertiary.copy(alpha = 0.12f))
                    Spacer(Modifier.height(14.dp))
                }
                Text(
                    "A bot you add here reads every message in this group and can post its own. " +
                        "Only add one you trust.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = colors.textTertiary,
                )
                Spacer(Modifier.height(12.dp))
                NeuButton(onClick = { botPickerOpen = true }, modifier = Modifier.fillMaxWidth()) {
                    Text(
                        "Add a bot",
                        style = MaterialTheme.typography.labelLarge,
                        color = colors.textSecondary,
                    )
                }
            }
        }

        // ── Apply ────────────────────────────────────────────────────────────
        Spacer(Modifier.height(26.dp))
        NeuButton(
            onClick = {
                if (busy) return@NeuButton
                busy = true
                savedTick = false
                scope.launch {
                    val result = runCatching {
                        val newTitle = title.trim().takeIf { it.isNotBlank() && it != conv.title }
                        val newDescription = description.takeIf { it != conv.description.orEmpty() }
                        // An empty PATCH is a server error, not a no-op — skip it.
                        if (newTitle != null || newDescription != null) {
                            container.repo.updateConversation(conversationId, newTitle, newDescription)
                        }
                        container.repo.setAppearance(conversationId, staged).conversation
                    }
                    result.onSuccess { fresh ->
                        conversation = fresh
                        staged = fresh.appearance
                        savedTick = true
                    }
                    busy = false
                }
            },
            accent = true,
            enabled = !busy,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp),
        ) {
            if (savedTick) {
                Icon(Icons.Rounded.Check, null, tint = colors.onAccent, modifier = Modifier.size(17.dp))
                Spacer(Modifier.width(8.dp))
            }
            Text(
                if (savedTick) "Saved" else "Save changes",
                style = MaterialTheme.typography.labelLarge,
                color = colors.onAccent,
            )
        }

        Spacer(Modifier.height(40.dp))
    }

    if (botPickerOpen) {
        BotPickerSheet(conversationId, onDismiss = { botPickerOpen = false })
    }
    if (bansOpen) BanListSheet(conversationId, onDismiss = { bansOpen = false })
    if (verifyOpen) {
        VerificationWizard(
            conversationId = conversationId,
            groupName = conversation?.title ?: "this group",
            onDismiss = { verifyOpen = false },
        )
    }
    if (invitesOpen) {
        InviteManagerSheet(
            conversationId,
            onDismiss = {
                invitesOpen = false
                // The header link may have been revoked or replaced in there.
                scope.launch {
                    inviteUrl = runCatching {
                        container.repo.invites(conversationId).invites.firstOrNull()?.url
                    }.getOrNull()
                }
            },
        )
    }
}

/**
 * Pick a bot to add.
 *
 * Adding goes through the ordinary add-members endpoint rather than anything
 * bot-specific: a bot is a user row, so it lands with the same permission check
 * and the same "X added Y" system message a person would. The group can see it
 * arrive, which for something that reads every message is the point.
 */
@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
private fun BotPickerSheet(conversationId: String, onDismiss: () -> Unit) {
    val container = LocalContainer.current
    val colors = neuColors
    val scope = rememberCoroutineScope()
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    var bots by remember { mutableStateOf<List<DirectoryBot>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var adding by remember { mutableStateOf<String?>(null) }
    var added by remember { mutableStateOf<Set<String>>(emptySet()) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        // yapper has its own row in the Bots section; listing it here too
        // would offer the same bot twice.
        bots = runCatching { container.repo.botDirectory().bots }.getOrDefault(emptyList())
            .filter { it.user?.username != "yapper" }
        loading = false
    }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = colors.surface,
        contentColor = colors.textPrimary,
    ) {
        Column(Modifier.padding(horizontal = 20.dp).padding(bottom = 28.dp)) {
            Text(
                "Add a bot",
                style = MaterialTheme.typography.headlineSmall,
                color = colors.textPrimary,
            )
            Spacer(Modifier.height(4.dp))
            Text(
                "It will be able to read this group's messages and post in it.",
                style = MaterialTheme.typography.bodyMedium,
                color = colors.textTertiary,
            )
            Spacer(Modifier.height(16.dp))

            when {
                loading -> Box(Modifier.fillMaxWidth().padding(30.dp), Alignment.Center) {
                    CircularProgressIndicator(color = colors.accent)
                }

                bots.isEmpty() -> Text(
                    "No public bots yet. Build one in the developer portal and mark it public.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = colors.textTertiary,
                )

                else -> Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    bots.forEach { bot ->
                        val isAdded = bot.botUserId in added
                        NeuSurface(
                            Modifier.fillMaxWidth(),
                            shape = RoundedCornerShape(Neu.CornerMedium),
                            contentPadding = 14.dp,
                        ) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Avatar(
                                    url = bot.user?.avatarUrl,
                                    name = bot.name,
                                    id = bot.botUserId,
                                    size = 40.dp,
                                )
                                Spacer(Modifier.width(12.dp))
                                Column(Modifier.weight(1f)) {
                                    Text(
                                        bot.name,
                                        style = MaterialTheme.typography.bodyLarge,
                                        color = colors.textPrimary,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                    val subtitle = bot.description?.takeIf { it.isNotBlank() }
                                        ?: if (bot.commandCount > 0) "${bot.commandCount} commands" else "Bot"
                                    Text(
                                        subtitle,
                                        style = MaterialTheme.typography.bodyMedium,
                                        color = colors.textTertiary,
                                        maxLines = 2,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                }
                                Spacer(Modifier.width(10.dp))
                                if (isAdded) {
                                    Text(
                                        "Added",
                                        style = MaterialTheme.typography.labelLarge,
                                        color = colors.success,
                                    )
                                } else {
                                    NeuButton(
                                        onClick = {
                                            if (adding != null) return@NeuButton
                                            adding = bot.botUserId
                                            error = null
                                            scope.launch {
                                                val ok = runCatching {
                                                    container.repo.addMembers(
                                                        conversationId,
                                                        listOf(bot.botUserId),
                                                    )
                                                }.isSuccess
                                                if (ok) {
                                                    added = added + bot.botUserId
                                                } else {
                                                    error = "Could not add ${bot.name}."
                                                }
                                                adding = null
                                            }
                                        },
                                        accent = true,
                                    ) {
                                        if (adding == bot.botUserId) {
                                            CircularProgressIndicator(
                                                Modifier.size(16.dp),
                                                color = colors.onAccent,
                                                strokeWidth = 2.dp,
                                            )
                                        } else {
                                            Text(
                                                "Add",
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

            error?.let {
                Spacer(Modifier.height(12.dp))
                Text(it, style = MaterialTheme.typography.bodyMedium, color = colors.danger)
            }
        }
    }
}
