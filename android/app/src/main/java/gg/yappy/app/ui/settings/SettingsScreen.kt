package gg.yappy.app.ui.settings

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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.Logout
import androidx.compose.material.icons.automirrored.rounded.VolumeUp
import androidx.compose.material.icons.rounded.Block
import androidx.compose.material.icons.rounded.Campaign
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.DarkMode
import androidx.compose.material.icons.rounded.Devices
import androidx.compose.material.icons.rounded.LightMode
import androidx.compose.material.icons.rounded.Lock
import androidx.compose.material.icons.rounded.Notifications
import androidx.compose.material.icons.rounded.SettingsBrightness
import androidx.compose.material.icons.rounded.Visibility
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
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
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import gg.yappy.app.LocalContainer
import gg.yappy.app.data.Conversation
import gg.yappy.app.data.DeviceEntry
import gg.yappy.app.data.FullUser
import gg.yappy.app.data.PublicUser
import gg.yappy.app.ui.components.Avatar
import gg.yappy.app.ui.components.BadgeMark
import gg.yappy.app.ui.components.EditableAvatar
import gg.yappy.app.ui.components.NeuChip
import gg.yappy.app.ui.components.NeuIconButton
import gg.yappy.app.ui.components.NeuSurface
import gg.yappy.app.ui.components.NeuSwitch
import gg.yappy.app.ui.components.SectionLabel
import gg.yappy.app.ui.components.softClickable
import gg.yappy.app.ui.theme.Neu
import gg.yappy.app.ui.theme.PlaceShape
import gg.yappy.app.ui.theme.neuColors
import kotlinx.coroutines.launch

@Composable
fun SettingsScreen(onBack: () -> Unit) {
    val container = LocalContainer.current
    val colors = neuColors
    val scope = rememberCoroutineScope()

    val themeName by container.session.theme.collectAsState(initial = "system")
    var me by remember { mutableStateOf<FullUser?>(null) }
    var devices by remember { mutableStateOf<List<DeviceEntry>>(emptyList()) }
    /** Badged groups that have affiliated me — the only ones I may display. */
    var affiliations by remember { mutableStateOf<List<Conversation>>(emptyList()) }
    var avatarBusy by remember { mutableStateOf(false) }
    var showPreview by remember { mutableStateOf(true) }
    var announcements by remember { mutableStateOf(true) }
    var soundOn by remember { mutableStateOf(true) }
    var readReceipts by remember { mutableStateOf(true) }
    var typingIndicators by remember { mutableStateOf(true) }
    var blockedOpen by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        runCatching { container.repo.me().user }.getOrNull()?.let { user ->
            me = user
            user.notifications?.get("showPreview")?.toString()?.let { showPreview = it == "true" }
            // Anything that is not the silent sentinel is a sound, including a
            // missing value — an account that predates this setting should not
            // silently go quiet. The JSON value arrives quoted.
            soundOn = user.notifications?.get("sound")?.toString()?.trim('"') != "none"
            // Absent on accounts created before the setting existed, and the
            // default is on — so only an explicit false turns the toggle off.
            user.notifications?.get("announcements")?.toString()?.let { announcements = it != "false" }
            user.privacy?.get("readReceipts")?.toString()?.let { readReceipts = it == "true" }
            user.privacy?.get("typingIndicators")?.toString()?.let { typingIndicators = it == "true" }
        }
        devices = runCatching { container.repo.devices().devices }.getOrDefault(emptyList())
        // Both halves have to be true for a group to be offerable; the server
        // re-checks on write, so this is a filter and not the enforcement.
        affiliations = runCatching { container.repo.conversations().conversations }
            .getOrDefault(emptyList())
            .filter { it.badge != null && it.self?.isAffiliate == true }
    }

    Column(
        Modifier
            .fillMaxSize()
            .statusBarsPadding()
            .verticalScroll(rememberScrollState())
            .padding(bottom = 40.dp),
    ) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            NeuIconButton(Icons.AutoMirrored.Rounded.ArrowBack, "Back", onBack, size = 42.dp, iconSize = 19.dp)
            Spacer(Modifier.width(12.dp))
            Text("Settings", style = MaterialTheme.typography.headlineSmall, color = colors.textPrimary)
        }

        // ── Profile card ────────────────────────────────────────────────────
        NeuSurface(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp),
            shape = RoundedCornerShape(Neu.CornerLarge),
            elevation = 8.dp,
            contentPadding = 18.dp,
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                EditableAvatar(
                    url = me?.avatarUrl,
                    name = me?.displayName,
                    id = me?.id ?: "me",
                    size = 62.dp,
                    busy = avatarBusy,
                    enabled = me != null,
                    onPicked = { uri ->
                        scope.launch {
                            avatarBusy = true
                            runCatching {
                                val up = container.uploader.upload(uri, purpose = "avatar")
                                container.repo.setMyAvatar(up.mediaId).user
                            }.onSuccess { me = it }
                            avatarBusy = false
                        }
                    },
                )
                Spacer(Modifier.width(14.dp))
                Column(Modifier.weight(1f)) {
                    Text(
                        me?.displayName ?: "…",
                        style = MaterialTheme.typography.titleMedium,
                        color = colors.textPrimary,
                    )
                    Text(
                        me?.username?.let { "@$it" } ?: "",
                        style = MaterialTheme.typography.bodyMedium,
                        color = colors.textTertiary,
                    )
                    me?.bio?.takeIf { it.isNotBlank() }?.let {
                        Spacer(Modifier.height(4.dp))
                        Text(it, style = MaterialTheme.typography.bodyMedium, color = colors.textSecondary)
                    }
                }
            }
        }

        Spacer(Modifier.height(24.dp))

        // ── Appearance ──────────────────────────────────────────────────────
        SectionLabel("Appearance", Modifier.padding(horizontal = 22.dp))
        NeuSurface(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp),
            shape = RoundedCornerShape(Neu.CornerMedium),
            contentPadding = 16.dp,
        ) {
            Column {
                Text("Theme", style = MaterialTheme.typography.titleSmall, color = colors.textPrimary)
                Spacer(Modifier.height(12.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    ThemeChip("System", Icons.Rounded.SettingsBrightness, themeName == "system") {
                        scope.launch { container.session.setTheme("system"); runCatching { container.repo.updateTheme("system") } }
                    }
                    ThemeChip("Light", Icons.Rounded.LightMode, themeName == "light") {
                        scope.launch { container.session.setTheme("light"); runCatching { container.repo.updateTheme("light") } }
                    }
                    ThemeChip("Dark", Icons.Rounded.DarkMode, themeName == "dark") {
                        scope.launch { container.session.setTheme("dark"); runCatching { container.repo.updateTheme("dark") } }
                    }
                }
                Spacer(Modifier.height(8.dp))
                Text(
                    "The theme is stored on your account too, so a new device picks it up.",
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.textTertiary,
                )
            }
        }

        // ── Affiliation ─────────────────────────────────────────────────────
        // Only rendered when a badged group has actually affiliated you, so for
        // almost everyone this section does not exist. An empty "Affiliation"
        // header would read as something withheld.
        if (affiliations.isNotEmpty()) {
            Spacer(Modifier.height(24.dp))
            SectionLabel("Affiliation", Modifier.padding(horizontal = 22.dp))
            SettingsGroup {
                Text(
                    "Show a group's logo next to your name. You can turn this off at any time, and so can they.",
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.textTertiary,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 10.dp),
                )
                affiliations.forEach { group ->
                    Divider()
                    val selected = me?.affiliation?.id == group.id
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .softClickable {
                                scope.launch {
                                    val next = if (selected) null else group.id
                                    runCatching { container.repo.setAffiliation(next).user }
                                        .onSuccess { me = it }
                                }
                            }
                            .padding(horizontal = 16.dp, vertical = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Avatar(
                            group.avatarUrl, group.title, group.id,
                            size = 34.dp, shape = PlaceShape,
                        )
                        Spacer(Modifier.width(12.dp))
                        Text(
                            group.title ?: "Group",
                            style = MaterialTheme.typography.bodyLarge,
                            color = colors.textPrimary,
                            modifier = Modifier.weight(1f),
                        )
                        BadgeMark(group.badge, size = 15.dp)
                        if (selected) {
                            Spacer(Modifier.width(8.dp))
                            Icon(
                                Icons.Rounded.Check,
                                "Showing",
                                tint = colors.accent,
                                modifier = Modifier.size(20.dp),
                            )
                        }
                    }
                }
            }
        }

        Spacer(Modifier.height(24.dp))

        // ── Notifications ───────────────────────────────────────────────────
        SectionLabel("Notifications", Modifier.padding(horizontal = 22.dp))
        SettingsGroup {
            // Off means the notification still appears — it just arrives
            // without a sound. Said in the subtitle because "Sound: off" is
            // otherwise easy to read as "silence notifications", which is a
            // different and much more alarming promise.
            ToggleRow(
                Icons.AutoMirrored.Rounded.VolumeUp,
                "Sound",
                "Off still shows the notification, just silently",
                soundOn,
            ) { next ->
                soundOn = next
                scope.launch {
                    runCatching {
                        container.repo.updateNotificationValue("sound", if (next) "default" else "none")
                    }
                }
            }
            Divider()
            ToggleRow(
                Icons.Rounded.Notifications,
                "Show message preview",
                "Hide the text on your lock screen",
                showPreview,
            ) { next ->
                showPreview = next
                scope.launch { runCatching { container.repo.updateNotificationFlag("showPreview", next) } }
            }
            // The off switch also rides on the messages themselves, which is
            // where people actually decide they are done with them. This is the
            // way back on — without it, one tap in a DM would be permanent.
            ToggleRow(
                Icons.Rounded.Campaign,
                "Tips from yapper",
                "Welcome notes and bot housekeeping. Security alerts always arrive",
                announcements,
            ) { next ->
                announcements = next
                scope.launch { runCatching { container.repo.updateNotificationFlag("announcements", next) } }
            }
        }

        Spacer(Modifier.height(24.dp))

        // ── Privacy ─────────────────────────────────────────────────────────
        SectionLabel("Privacy", Modifier.padding(horizontal = 22.dp))
        SettingsGroup {
            ToggleRow(
                Icons.Rounded.Visibility,
                "Read receipts",
                "If off, you also stop seeing others'",
                readReceipts,
            ) { next ->
                readReceipts = next
                scope.launch { runCatching { container.repo.updatePrivacyFlag("readReceipts", next) } }
            }
            Divider()
            ToggleRow(
                Icons.Rounded.Lock,
                "Typing indicators",
                null,
                typingIndicators,
            ) { next ->
                typingIndicators = next
                scope.launch { runCatching { container.repo.updatePrivacyFlag("typingIndicators", next) } }
            }
            Divider()
            NavRow(Icons.Rounded.Block, "Blocked accounts", null) { blockedOpen = true }
        }

        Spacer(Modifier.height(24.dp))

        // ── Devices ─────────────────────────────────────────────────────────
        SectionLabel("Active sessions", Modifier.padding(horizontal = 22.dp))
        SettingsGroup {
            devices.forEachIndexed { index, device ->
                if (index > 0) Divider()
                Row(
                    Modifier.fillMaxWidth().padding(vertical = 12.dp, horizontal = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(Icons.Rounded.Devices, null, tint = colors.textSecondary, modifier = Modifier.size(20.dp))
                    Spacer(Modifier.width(14.dp))
                    Column(Modifier.weight(1f)) {
                        Text(
                            device.name ?: device.platform.replaceFirstChar(Char::uppercase),
                            style = MaterialTheme.typography.bodyLarge,
                            color = colors.textPrimary,
                        )
                        Text(
                            if (device.isCurrent) "This device" else (device.osVersion ?: device.platform),
                            style = MaterialTheme.typography.labelSmall,
                            color = if (device.isCurrent) colors.success else colors.textTertiary,
                        )
                    }
                    if (!device.isCurrent) {
                        Text(
                            "Sign out",
                            style = MaterialTheme.typography.labelMedium,
                            color = colors.danger,
                            modifier = Modifier.softClickable {
                                scope.launch {
                                    runCatching { container.repo.revokeDevice(device.id) }
                                    devices = devices.filterNot { it.id == device.id }
                                }
                            },
                        )
                    }
                }
            }
            if (devices.isEmpty()) {
                Text(
                    "Loading…",
                    style = MaterialTheme.typography.bodyMedium,
                    color = colors.textTertiary,
                    modifier = Modifier.padding(vertical = 12.dp),
                )
            }
        }

        Spacer(Modifier.height(24.dp))

        NeuSurface(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp),
            shape = RoundedCornerShape(Neu.CornerMedium),
            contentPadding = 4.dp,
            onClick = { scope.launch { container.signOut() } },
        ) {
            Row(
                Modifier.fillMaxWidth().padding(vertical = 12.dp, horizontal = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    Icons.AutoMirrored.Rounded.Logout,
                    null,
                    tint = colors.danger,
                    modifier = Modifier.size(20.dp),
                )
                Spacer(Modifier.width(14.dp))
                Text("Sign out", style = MaterialTheme.typography.bodyLarge, color = colors.danger)
            }
        }
    }

    if (blockedOpen) {
        BlockedAccountsSheet(onDismiss = { blockedOpen = false })
    }
}

/**
 * Blocked accounts, and the way back out of one.
 *
 * The row that opens this existed for a while with an empty click handler — a
 * control that looks live and does nothing, which is worse than an absent one.
 * It also meant blocking was one-way in practice: you can block from a profile,
 * but finding that profile again to undo it means remembering who they were.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun BlockedAccountsSheet(onDismiss: () -> Unit) {
    val container = LocalContainer.current
    val colors = neuColors
    val scope = rememberCoroutineScope()

    // Null while loading, so the empty state does not flash before the answer.
    var blocked by remember { mutableStateOf<List<PublicUser>?>(null) }

    LaunchedEffect(Unit) {
        blocked = runCatching { container.repo.blocks().users }.getOrDefault(emptyList())
    }

    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = colors.surface,
        contentColor = colors.textPrimary,
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp)
                .padding(bottom = 28.dp),
        ) {
            Text(
                "Blocked accounts",
                style = MaterialTheme.typography.titleMedium,
                color = colors.textPrimary,
            )
            Spacer(Modifier.height(12.dp))

            val list = blocked
            when {
                list == null ->
                    Box(Modifier.fillMaxWidth().padding(vertical = 30.dp), Alignment.Center) {
                        CircularProgressIndicator(color = colors.accent)
                    }

                list.isEmpty() ->
                    Text(
                        "You haven't blocked anyone.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = colors.textTertiary,
                        modifier = Modifier.padding(vertical = 20.dp),
                    )

                else -> list.forEach { user ->
                    Row(
                        Modifier.fillMaxWidth().padding(vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Avatar(user.avatarUrl, user.label, user.id, size = 38.dp)
                        Spacer(Modifier.width(12.dp))
                        Text(
                            user.label,
                            style = MaterialTheme.typography.bodyLarge,
                            color = colors.textPrimary,
                            modifier = Modifier.weight(1f),
                        )
                        Text(
                            "Unblock",
                            style = MaterialTheme.typography.labelMedium,
                            color = colors.accent,
                            modifier = Modifier.softClickable {
                                scope.launch {
                                    // Dropped from the list only once the server
                                    // agrees, so a failed call leaves the row
                                    // there to try again rather than pretending.
                                    if (runCatching { container.repo.unblock(user.id) }.isSuccess) {
                                        blocked = blocked?.filterNot { it.id == user.id }
                                    }
                                }
                            },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun SettingsGroup(content: @Composable () -> Unit) {
    NeuSurface(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp),
        shape = RoundedCornerShape(Neu.CornerMedium),
        contentPadding = 12.dp,
    ) {
        Column { content() }
    }
}

/** A hairline etched into the sheet rather than drawn on top of it. */
@Composable
private fun Divider() {
    val colors = neuColors
    Box(
        Modifier
            .fillMaxWidth()
            .height(1.dp)
            .background(colors.dark.copy(alpha = 0.18f)),
    )
}

@Composable
private fun ToggleRow(
    icon: ImageVector,
    title: String,
    subtitle: String?,
    checked: Boolean,
    onChange: (Boolean) -> Unit,
) {
    val colors = neuColors
    Row(
        Modifier.fillMaxWidth().padding(vertical = 10.dp, horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, tint = colors.textSecondary, modifier = Modifier.size(20.dp))
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge, color = colors.textPrimary)
            subtitle?.let {
                Text(it, style = MaterialTheme.typography.labelSmall, color = colors.textTertiary)
            }
        }
        NeuSwitch(checked, onChange)
    }
}

@Composable
private fun NavRow(icon: ImageVector, title: String, subtitle: String?, onClick: () -> Unit) {
    val colors = neuColors
    Row(
        Modifier
            .fillMaxWidth()
            .softClickable(onClick = onClick)
            .padding(vertical = 13.dp, horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, tint = colors.textSecondary, modifier = Modifier.size(20.dp))
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge, color = colors.textPrimary)
            subtitle?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = colors.textTertiary) }
        }
    }
}

@Composable
private fun ThemeChip(label: String, icon: ImageVector, selected: Boolean, onClick: () -> Unit) {
    NeuChip(label = label, selected = selected, onClick = onClick)
}
