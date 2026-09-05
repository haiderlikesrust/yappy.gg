package gg.yappy.app.ui.settings

import android.app.TimePickerDialog
import android.content.Intent
import android.provider.Settings
import androidx.compose.foundation.background
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.Logout
import androidx.compose.material.icons.automirrored.rounded.VolumeUp
import androidx.compose.material.icons.rounded.AlternateEmail
import androidx.compose.material.icons.rounded.Block
import androidx.compose.material.icons.rounded.Call
import androidx.compose.material.icons.rounded.Campaign
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.Chat
import androidx.compose.material.icons.rounded.ChevronRight
import androidx.compose.material.icons.rounded.DarkMode
import androidx.compose.material.icons.rounded.Delete
import androidx.compose.material.icons.rounded.Visibility
import androidx.compose.material.icons.rounded.VisibilityOff
import androidx.compose.material.icons.rounded.Devices
import androidx.compose.material.icons.rounded.Edit
import androidx.compose.material.icons.rounded.Favorite
import androidx.compose.material.icons.rounded.Fingerprint
import androidx.compose.material.icons.rounded.Info
import androidx.compose.material.icons.rounded.EmojiEmotions
import androidx.compose.material.icons.rounded.Groups
import androidx.compose.material.icons.rounded.LightMode
import androidx.compose.material.icons.rounded.Lock
import androidx.compose.material.icons.rounded.NotificationsActive
import androidx.compose.material.icons.rounded.Notifications
import androidx.compose.material.icons.rounded.NotificationsOff
import androidx.compose.material.icons.rounded.NightlightRound
import androidx.compose.material.icons.rounded.PhoneAndroid
import androidx.compose.material.icons.rounded.PhotoCamera
import androidx.compose.material.icons.rounded.QrCode2
import androidx.compose.material.icons.rounded.SettingsBrightness
import androidx.compose.material.icons.rounded.Visibility
import androidx.compose.material.icons.rounded.Warning
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.Text
import androidx.compose.material3.TimePicker
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.app.NotificationManagerCompat
import androidx.lifecycle.compose.LifecycleResumeEffect
import coil.compose.AsyncImage
import gg.yappy.app.LocalContainer
import gg.yappy.app.data.Conversation
import gg.yappy.app.data.DeviceEntry
import gg.yappy.app.data.DiskCache
import gg.yappy.app.data.FullUser
import gg.yappy.app.data.PublicUser
import gg.yappy.app.ui.components.Avatar
import gg.yappy.app.ui.components.BadgeMark
import gg.yappy.app.ui.components.EditableAvatar
import gg.yappy.app.ui.components.LocalSnackbar
import gg.yappy.app.ui.components.NeuButton
import gg.yappy.app.ui.components.NeuChip
import gg.yappy.app.ui.components.NeuIconButton
import gg.yappy.app.ui.components.NeuSurface
import gg.yappy.app.ui.components.NeuSwitch
import gg.yappy.app.ui.components.NeuTextField
import gg.yappy.app.ui.components.SectionLabel
import gg.yappy.app.ui.components.softClickable
import gg.yappy.app.ui.theme.Neu
import gg.yappy.app.ui.theme.PlaceShape
import gg.yappy.app.ui.theme.neuColors
import gg.yappy.app.ui.util.relativeTime
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** Who may do a thing to you. Mirrors the server's `PRIVACY_AUDIENCES`. */
private val AUDIENCES = listOf(
    "everyone" to "Everyone",
    "contacts" to "Contacts",
    "nobody" to "Nobody",
)

/** Per-conversation-kind notification levels, as the server names them. */
private val LEVELS = listOf(
    "all" to "All",
    "mentions" to "Mentions",
    "none" to "None",
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    onBack: () -> Unit,
    onOpenAbout: () -> Unit = {},
    /** Your own profile, as visitors see it. Given your user id. */
    onOpenProfile: (String) -> Unit = {},
) {
    val container = LocalContainer.current
    val lock = LocalAppLock.current
    val colors = neuColors
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val snackbar = LocalSnackbar.current

    val themeName by container.session.theme.collectAsState(initial = "light")
    val me by container.me.collectAsState()
    val lockEnabled by lock.enabled.collectAsState()

    /** Null until the list has been asked for; `devicesFailed` says why it stayed null. */
    var devices by remember { mutableStateOf<List<DeviceEntry>?>(null) }
    var devicesFailed by remember { mutableStateOf(false) }
    /** The sweep of every other session is in flight; its row shows a spinner instead of re-arming. */
    var signingOutOthers by remember { mutableStateOf(false) }

    /**
     * Whether the phone will show our notifications at all.
     *
     * Every toggle in the Notifications section is a lie while this is false —
     * the server will send, and the OS will drop. Re-read on every resume,
     * because the fix lives in the system settings and people come straight
     * back from there expecting the warning to have gone.
     */
    var notificationsAllowed by remember {
        mutableStateOf(NotificationManagerCompat.from(context).areNotificationsEnabled())
    }
    LifecycleResumeEffect(Unit) {
        notificationsAllowed = NotificationManagerCompat.from(context).areNotificationsEnabled()
        onPauseOrDispose { }
    }
    fun openSystemNotificationSettings() {
        runCatching {
            context.startActivity(
                Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                    .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName),
            )
        }
    }
    /** Badged groups that have affiliated me — the only ones I may display. */
    var affiliations by remember { mutableStateOf<List<Conversation>>(emptyList()) }
    var avatarBusy by remember { mutableStateOf(false) }
    var bannerBusy by remember { mutableStateOf(false) }

    var blockedOpen by remember { mutableStateOf(false) }
    var usernameOpen by remember { mutableStateOf(false) }

    var passwordOpen by remember { mutableStateOf(false) }
    var deleteOpen by remember { mutableStateOf(false) }
    var editProfileOpen by remember { mutableStateOf(false) }
    var shareProfileOpen by remember { mutableStateOf(false) }
    var signOutConfirmOpen by remember { mutableStateOf(false) }

    // Notifications
    var showPreview by remember { mutableStateOf(true) }
    var announcements by remember { mutableStateOf(true) }
    var soundOn by remember { mutableStateOf(true) }
    var inAppOn by remember { mutableStateOf(true) }
    var inAppSoundOn by remember { mutableStateOf(true) }
    var reactionsOn by remember { mutableStateOf(true) }
    var callsOn by remember { mutableStateOf(true) }
    var dmLevel by remember { mutableStateOf("all") }
    var groupLevel by remember { mutableStateOf("mentions") }
    var mutedBadgeOn by remember { mutableStateOf(true) }
    var quietOn by remember { mutableStateOf(false) }
    var quietStart by remember { mutableStateOf("23:00") }
    var quietEnd by remember { mutableStateOf("08:00") }

    // Privacy
    var readReceipts by remember { mutableStateOf(true) }
    var typingIndicators by remember { mutableStateOf(true) }
    var ambientPresence by remember { mutableStateOf(true) }

    // Status
    var customStatus by remember { mutableStateOf("") }
    var customStatusSave by remember { mutableStateOf<Job?>(null) }
    var whoCanDm by remember { mutableStateOf("everyone") }
    var whoCanAdd by remember { mutableStateOf("everyone") }
    var whoCanSeeLastSeen by remember { mutableStateOf("everyone") }

    // Appearance and storage
    var fontScale by remember { mutableFloatStateOf(1f) }
    var fontScaleSave by remember { mutableStateOf<Job?>(null) }
    var cacheBytes by remember { mutableStateOf(0L) }
    var cacheCleared by remember { mutableStateOf(false) }

    /**
     * Mirror a profile's settings onto the controls.
     *
     * Defaults match the server's: absent means on, except `sound`, where
     * anything but the silent sentinel counts as a sound.
     */
    fun applySettings(user: FullUser) {
        val n = user.notifications
        val p = user.privacy

        n?.bool("showPreview")?.let { showPreview = it }
        soundOn = n?.str("sound") != "none"
        announcements = n?.bool("announcements") ?: true
        inAppOn = n?.bool("inApp") ?: true
        inAppSoundOn = n?.bool("inAppSound") ?: true
        reactionsOn = n?.bool("reactions") ?: true
        callsOn = n?.bool("calls") ?: true
        dmLevel = n?.str("dm") ?: "all"
        groupLevel = n?.str("groups") ?: "mentions"
        mutedBadgeOn = n?.bool("mutedBadge") ?: true

        // Absent or null quiet hours means off; the times keep their defaults so
        // switching it on offers a sane window rather than midnight-to-midnight.
        val quiet = n?.obj("quietHours")
        if (quiet != null) {
            quietOn = quiet.bool("enabled") ?: false
            quiet.str("start")?.let { quietStart = it }
            quiet.str("end")?.let { quietEnd = it }
        } else {
            quietOn = false
        }

        p?.bool("readReceipts")?.let { readReceipts = it }
        p?.bool("typingIndicators")?.let { typingIndicators = it }
        // Absent means on: accounts created before the setting existed have no
        // key for it, and the server reads a missing value the same way.
        ambientPresence = p?.bool("ambientPresence") ?: true
        customStatus = user.presence.customStatus.orEmpty()
        whoCanDm = p?.str("whoCanDm") ?: "everyone"
        whoCanAdd = p?.str("whoCanAddToGroups") ?: "everyone"
        whoCanSeeLastSeen = p?.str("whoCanSeeLastSeen") ?: "everyone"

        fontScale = user.appearance?.fontScale ?: 1f
    }

    /**
     * Seed during *composition*, not in the effect below. A LaunchedEffect
     * runs after the first frame, and a Material Switch whose value changes
     * after a frame does not snap — it animates the slide. So a disabled
     * toggle opened as enabled and visibly slid off, every single time. This
     * block runs before anything has drawn, and writing state that nothing
     * has read yet costs no extra recomposition.
     */
    remember { container.me.value?.let(::applySettings) }

    suspend fun loadDevices() {
        devicesFailed = false
        devices = runCatching { container.repo.devices().devices }
            .getOrElse { devicesFailed = true; null }
    }

    LaunchedEffect(Unit) {
        cacheBytes = DiskCache.sizeBytes()

        runCatching { container.repo.me().user }.getOrNull()?.let { user ->
            container.setMe(user)
            applySettings(user)
        }
        loadDevices()
        // Both halves have to be true for a group to be offerable; the server
        // re-checks on write, so this is a filter and not the enforcement.
        affiliations = runCatching { container.repo.conversations().conversations }
            .getOrDefault(emptyList())
            .filter { it.badge != null && it.self?.isAffiliate == true }
    }

    /**
     * Persist the slider once it settles.
     *
     * `Slider` reports every intermediate value, and a PATCH per tick would be
     * dozens of writes for one drag — and they can land out of order, so the
     * last one to arrive is not necessarily the value on screen.
     */
    fun scheduleFontScaleSave(target: Float) {
        fontScaleSave?.cancel()
        fontScaleSave = scope.launch {
            delay(400)
            runCatching { container.repo.setFontScale(target) }
                .getOrNull()?.user?.let(container::setMe)
        }
    }

    Column(
        Modifier
            .fillMaxSize()
            .statusBarsPadding()
            // The status field is a third of the way down a long page; without
            // this the keyboard covers it and the scroll cannot bring it up,
            // because as far as the scroll knows the viewport never shrank.
            .imePadding()
            .verticalScroll(rememberScrollState()),
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
            Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
                BannerEditor(
                    url = me?.bannerUrl,
                    busy = bannerBusy,
                    enabled = me != null,
                    onPicked = { uri ->
                        scope.launch {
                            bannerBusy = true
                            runCatching {
                                val up = container.uploader.upload(uri, purpose = "banner")
                                container.repo.setMyBanner(up.mediaId).user
                            }.getOrNull()?.let(container::setMe)
                            bannerBusy = false
                        }
                    },
                    onRemove = {
                        scope.launch {
                            bannerBusy = true
                            runCatching { container.repo.setMyBanner(null).user }
                                .getOrNull()?.let(container::setMe)
                            bannerBusy = false
                        }
                    },
                )

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
                                }.getOrNull()?.let(container::setMe)
                                avatarBusy = false
                            }
                        },
                    )
                    Spacer(Modifier.width(14.dp))
                    // The name opens your profile as others see it. The
                    // chevron is the only hint, and it is enough: the same
                    // glyph means "there is a page behind this" everywhere
                    // else on Android.
                    Row(
                        Modifier
                            .weight(1f)
                            .clip(RoundedCornerShape(Neu.CornerSmall))
                            .softClickable(enabled = me != null) { me?.id?.let(onOpenProfile) }
                            .semantics { role = Role.Button },
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
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
                        Icon(
                            Icons.Rounded.ChevronRight,
                            "View profile",
                            tint = colors.textTertiary,
                            modifier = Modifier.size(22.dp),
                        )
                    }
                }

                // Name, pronouns, bio and flair live behind the first row;
                // the QR is how the person next to you finds you.
                Hairline()
                NavRow(Icons.Rounded.Edit, "Edit profile") { editProfileOpen = true }
                Hairline()
                NavRow(Icons.Rounded.QrCode2, "Share profile") { shareProfileOpen = true }
            }
        }

        // ── Status ──────────────────────────────────────────────────────────
        /**
         * The free-text line beside your name. Saved on a debounce rather than
         * behind a Save button, matching every other control on this screen —
         * and cleared by emptying the field, which is what people try first.
         */
        Section("Status")
        SettingsGroup {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    Icons.Rounded.EmojiEmotions,
                    null,
                    tint = colors.textTertiary,
                    modifier = Modifier.size(20.dp),
                )
                Spacer(Modifier.width(14.dp))
                NeuTextField(
                    value = customStatus,
                    onValueChange = { next ->
                        customStatus = next.take(128)
                        customStatusSave?.cancel()
                        customStatusSave = scope.launch {
                            delay(700)
                            runCatching {
                                container.repo.setPresence(
                                    status = me?.presence?.status?.takeIf { it != "offline" } ?: "online",
                                    customStatus = customStatus,
                                )
                            }
                        }
                    },
                    placeholder = "What are you up to?",
                    modifier = Modifier.weight(1f),
                )
            }
        }

        // ── Appearance ──────────────────────────────────────────────────────
        Section("Appearance")
        NeuSurface(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp),
            shape = RoundedCornerShape(Neu.CornerMedium),
            contentPadding = 16.dp,
        ) {
            Column {
                Text("Theme", style = MaterialTheme.typography.titleSmall, color = colors.textPrimary)
                Spacer(Modifier.height(12.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf(
                        "system" to Icons.Rounded.SettingsBrightness,
                        "light" to Icons.Rounded.LightMode,
                        "dark" to Icons.Rounded.DarkMode,
                    ).forEach { (value, _) ->
                        NeuChip(
                            label = value.replaceFirstChar(Char::uppercase),
                            selected = themeName == value,
                            // Named, not trailing: NeuChip's parameters end in
                            // `leading` and `role`, so a trailing lambda does
                            // not land on onClick and the call does not compile.
                            onClick = {
                                scope.launch {
                                    container.session.setTheme(value)
                                    runCatching { container.repo.updateTheme(value) }
                                }
                            },
                        )
                    }
                }
                Spacer(Modifier.height(8.dp))
                Text(
                    "The theme is stored on your account too, so a new device picks it up.",
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.textTertiary,
                )

                Hairline(Modifier.padding(vertical = 14.dp))

                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        "Message text size",
                        style = MaterialTheme.typography.titleSmall,
                        color = colors.textPrimary,
                        modifier = Modifier.weight(1f),
                    )
                    Text(
                        "${(fontScale * 100).toInt()}%",
                        style = MaterialTheme.typography.labelMedium,
                        color = colors.textTertiary,
                    )
                }

                // The sample is the point: a percentage means nothing until you
                // can see what it does to a line of chat.
                Text(
                    "The quick brown fox jumps over the lazy dog",
                    style = MaterialTheme.typography.bodyLarge.copy(fontSize = (16 * fontScale).sp),
                    color = colors.textSecondary,
                    maxLines = 2,
                    modifier = Modifier.padding(top = 8.dp),
                )

                Row(
                    Modifier.padding(top = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("A", fontSize = 13.sp, color = colors.textTertiary)
                    Slider(
                        value = fontScale,
                        onValueChange = { fontScale = it; scheduleFontScaleSave(it) },
                        // Server range is 0.8–1.6; the steps keep it to values
                        // that land on a whole percentage.
                        valueRange = 0.8f..1.6f,
                        steps = 15,
                        colors = SliderDefaults.colors(
                            thumbColor = colors.accent,
                            activeTrackColor = colors.accent,
                        ),
                        modifier = Modifier.weight(1f).padding(horizontal = 10.dp),
                    )
                    Text("A", fontSize = 21.sp, color = colors.textTertiary)
                }
            }
        }

        // ── Affiliation ─────────────────────────────────────────────────────
        // Only rendered when a badged group has actually affiliated you, so for
        // almost everyone this section does not exist. An empty "Affiliation"
        // header would read as something withheld.
        if (affiliations.isNotEmpty()) {
            Section("Affiliation")
            SettingsGroup {
                Text(
                    "Show a group's logo next to your name. You can turn this off at any time, and so can they.",
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.textTertiary,
                    modifier = Modifier.padding(horizontal = 4.dp, vertical = 10.dp),
                )
                affiliations.forEach { group ->
                    Hairline()
                    val selected = me?.affiliation?.id == group.id
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .softClickable {
                                scope.launch {
                                    val next = if (selected) null else group.id
                                    runCatching { container.repo.setAffiliation(next).user }
                                        .getOrNull()?.let(container::setMe)
                                }
                            }
                            .padding(horizontal = 4.dp, vertical = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Avatar(group.avatarUrl, group.title, group.id, size = 34.dp, shape = PlaceShape)
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
                            Icon(Icons.Rounded.Check, "Showing", tint = colors.accent, modifier = Modifier.size(20.dp))
                        }
                    }
                }
            }
        }

        // ── Notifications ───────────────────────────────────────────────────
        Section("Notifications")
        SettingsGroup {
            if (!notificationsAllowed) {
                // Ahead of every toggle, because it overrides every toggle.
                // The whole row goes to the system page: there is nothing
                // this app can do about it from here.
                Row(
                    Modifier
                        .fillMaxWidth()
                        .softClickable { openSystemNotificationSettings() }
                        .semantics { role = Role.Button }
                        .padding(vertical = 12.dp, horizontal = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        Icons.Rounded.NotificationsOff,
                        null,
                        tint = colors.warning,
                        modifier = Modifier.size(20.dp),
                    )
                    Spacer(Modifier.width(14.dp))
                    Column(Modifier.weight(1f)) {
                        Text(
                            "Notifications are off for yappy on this phone",
                            style = MaterialTheme.typography.bodyLarge,
                            color = colors.textPrimary,
                        )
                        Text(
                            "Nothing below can reach you until they are allowed again",
                            style = MaterialTheme.typography.labelSmall,
                            color = colors.textTertiary,
                        )
                    }
                    Spacer(Modifier.width(10.dp))
                    Text(
                        "Open settings",
                        style = MaterialTheme.typography.labelMedium,
                        color = colors.accent,
                    )
                }
                Hairline()
            }
            // Off means the notification still appears — it just arrives without
            // a sound. Said in the subtitle because "Sound: off" is otherwise
            // easy to read as "silence notifications", which is a different and
            // much more alarming promise.
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
                    }.getOrNull()?.user?.let(container::adoptSettings)
                }
            }
            Hairline()
            ToggleRow(
                Icons.Rounded.Notifications,
                "Show message preview",
                "Hide the text on your lock screen",
                showPreview,
            ) { next ->
                showPreview = next
                scope.launch { runCatching { container.repo.updateNotificationFlag("showPreview", next) }.getOrNull()?.user?.let(container::adoptSettings) }
            }
            Hairline()
            // The banner that slides in while you are elsewhere in the app.
            // Distinct from push: these arrive over the socket and exist even
            // with notifications denied.
            ToggleRow(
                Icons.Rounded.Chat,
                "In-app banners",
                "A banner for messages while you are in the app",
                inAppOn,
            ) { next ->
                inAppOn = next
                scope.launch { runCatching { container.repo.updateNotificationFlag("inApp", next) }.getOrNull()?.user?.let(container::adoptSettings) }
            }
            Hairline()
            ToggleRow(
                Icons.Rounded.NotificationsActive,
                "In-app sound",
                "Play a sound with those banners",
                inAppSoundOn,
            ) { next ->
                inAppSoundOn = next
                scope.launch { runCatching { container.repo.updateNotificationFlag("inAppSound", next) }.getOrNull()?.user?.let(container::adoptSettings) }
            }
            Hairline()
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
                scope.launch { runCatching { container.repo.updateNotificationFlag("announcements", next) }.getOrNull()?.user?.let(container::adoptSettings) }
            }
            Hairline()
            ToggleRow(
                Icons.Rounded.Favorite,
                "Reactions",
                "When someone reacts to your message",
                reactionsOn,
            ) { next ->
                reactionsOn = next
                scope.launch { runCatching { container.repo.updateNotificationFlag("reactions", next) }.getOrNull()?.user?.let(container::adoptSettings) }
            }
            Hairline()
            ToggleRow(Icons.Rounded.Call, "Calls", null, callsOn) { next ->
                callsOn = next
                scope.launch { runCatching { container.repo.updateNotificationFlag("calls", next) }.getOrNull()?.user?.let(container::adoptSettings) }
            }
            Hairline()
            /*
             * The escape hatch for a deliberate default: muting says "do not
             * interrupt me", not "I was not called", so muted rooms feed the
             * @ badge. Somebody who muted a room *because* of mention spam
             * needs the way out, and this is it.
             */
            ToggleRow(
                Icons.Rounded.AlternateEmail,
                "Muted rooms count toward the @ badge",
                "Off: a muted room's mentions stop feeding the number",
                mutedBadgeOn,
            ) { next ->
                mutedBadgeOn = next
                scope.launch { runCatching { container.repo.updateNotificationFlag("mutedBadge", next) }.getOrNull()?.user?.let(container::adoptSettings) }
            }
            Hairline()
            // Sound, vibration and the lock-screen treatment are the phone's
            // to decide, per channel. Rather than rebuild that page here, the
            // row hands people to the real one.
            NavRow(Icons.Rounded.PhoneAndroid, "Sound and vibration on this phone") {
                openSystemNotificationSettings()
            }
        }

        Spacer(Modifier.height(10.dp))
        SettingsGroup {
            // The per-kind default. A conversation that has been muted
            // individually still wins over this.
            PickerRow("What to notify me about in direct messages", LEVELS, dmLevel) { next ->
                dmLevel = next
                scope.launch { runCatching { container.repo.updateNotificationValue("dm", next) }.getOrNull()?.user?.let(container::adoptSettings) }
            }
            Hairline()
            PickerRow("…and in groups", LEVELS, groupLevel) { next ->
                groupLevel = next
                scope.launch { runCatching { container.repo.updateNotificationValue("groups", next) }.getOrNull()?.user?.let(container::adoptSettings) }
            }
        }

        Spacer(Modifier.height(10.dp))
        SettingsGroup {
            ToggleRow(
                Icons.Rounded.NightlightRound,
                "Quiet hours",
                "Notifications still arrive, they just wait until morning",
                quietOn,
            ) { next ->
                quietOn = next
                scope.launch {
                    runCatching {
                        if (next) {
                            container.repo.setQuietHours(quietStart, quietEnd, true)
                        } else {
                            container.repo.clearQuietHours()
                        }
                    }.getOrNull()?.user?.let(container::adoptSettings)
                }
            }

            if (quietOn) {
                Hairline()
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 10.dp),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    TimeField("From", quietStart, Modifier.weight(1f)) { picked ->
                        quietStart = picked
                        scope.launch {
                            runCatching { container.repo.setQuietHours(picked, quietEnd, true) }.getOrNull()?.user?.let(container::adoptSettings)
                        }
                    }
                    TimeField("Until", quietEnd, Modifier.weight(1f)) { picked ->
                        quietEnd = picked
                        scope.launch {
                            runCatching { container.repo.setQuietHours(quietStart, picked, true) }.getOrNull()?.user?.let(container::adoptSettings)
                        }
                    }
                }

                // A window that ends before it starts is a normal thing to want
                // — it is what "overnight" means — so it is stated rather than
                // rejected.
                if (quietStart > quietEnd) {
                    Text(
                        "Overnight, through to $quietEnd the next day.",
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.textTertiary,
                        modifier = Modifier.padding(horizontal = 4.dp).padding(bottom = 8.dp),
                    )
                }
            }
        }

        // ── Privacy ─────────────────────────────────────────────────────────
        Section("Privacy")
        SettingsGroup {
            ToggleRow(
                Icons.Rounded.Visibility,
                "Read receipts",
                "If off, you also stop seeing others'",
                readReceipts,
            ) { next ->
                readReceipts = next
                scope.launch { runCatching { container.repo.updatePrivacyFlag("readReceipts", next) }.getOrNull()?.user?.let(container::adoptSettings) }
            }
            Hairline()
            ToggleRow(Icons.Rounded.Lock, "Typing indicators", null, typingIndicators) { next ->
                typingIndicators = next
                scope.launch { runCatching { container.repo.updatePrivacyFlag("typingIndicators", next) }.getOrNull()?.user?.let(container::adoptSettings) }
            }
            Hairline()
            ToggleRow(
                Icons.Rounded.Groups,
                "Show me in \"here now\"",
                "Others see you're in a chat while you have it open",
                ambientPresence,
            ) { next ->
                ambientPresence = next
                scope.launch { runCatching { container.repo.updatePrivacyFlag("ambientPresence", next) }.getOrNull()?.user?.let(container::adoptSettings) }
            }
            Hairline()
            NavRow(Icons.Rounded.Block, "Blocked accounts") { blockedOpen = true }
        }

        Spacer(Modifier.height(10.dp))
        SettingsGroup {
            PickerRow("Who can message me", AUDIENCES, whoCanDm, icon = Icons.Rounded.Chat) { next ->
                whoCanDm = next
                scope.launch { runCatching { container.repo.updatePrivacy("whoCanDm", next) }.getOrNull()?.user?.let(container::adoptSettings) }
            }
            Hairline()
            PickerRow("Who can add me to groups", AUDIENCES, whoCanAdd, icon = Icons.Rounded.Groups) { next ->
                whoCanAdd = next
                scope.launch { runCatching { container.repo.updatePrivacy("whoCanAddToGroups", next) }.getOrNull()?.user?.let(container::adoptSettings) }
            }
            Hairline()
            PickerRow("Who can see when I was last online", AUDIENCES, whoCanSeeLastSeen, icon = Icons.Rounded.Visibility) { next ->
                whoCanSeeLastSeen = next
                scope.launch { runCatching { container.repo.updatePrivacy("whoCanSeeLastSeen", next) }.getOrNull()?.user?.let(container::adoptSettings) }
            }
        }

        // Offered only where the device can actually satisfy it. A handset with
        // no screen lock set would strand someone in a lock they cannot open.
        if (remember { AppLockGate.available(context) }) {
            Spacer(Modifier.height(10.dp))
            SettingsGroup {
                ToggleRow(
                    Icons.Rounded.Fingerprint,
                    "App lock",
                    "Ask to unlock when yappy opens. It hides the app, not your data",
                    lockEnabled,
                ) { next -> lock.setEnabled(next) }
            }
        }

        // ── Storage ─────────────────────────────────────────────────────────
        Section("Storage")
        SettingsGroup {
            Row(
                Modifier
                    .fillMaxWidth()
                    .softClickable(enabled = !cacheCleared) {
                        // Both caches, and nothing else in cacheDir — a
                        // recording still in flight lives there too, and
                        // "clear cache" must not be able to eat a message
                        // someone is in the middle of sending.
                        DiskCache.clear()
                        runCatching { coil.Coil.imageLoader(context).diskCache?.clear() }
                        cacheBytes = 0
                        cacheCleared = true
                    }
                    .padding(horizontal = 4.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    if (cacheCleared) Icons.Rounded.Check else Icons.Rounded.Delete,
                    null,
                    tint = if (cacheCleared) colors.success else colors.textSecondary,
                    modifier = Modifier.size(20.dp),
                )
                Spacer(Modifier.width(14.dp))
                Column(Modifier.weight(1f)) {
                    Text(
                        if (cacheCleared) "Cache cleared" else "Clear cache",
                        style = MaterialTheme.typography.bodyLarge,
                        color = colors.textPrimary,
                    )
                    // Says what is *not* lost, because "clear" next to a chat
                    // app reads as "delete my messages" to most people.
                    Text(
                        if (cacheCleared) {
                            "Media will download again when you open it"
                        } else {
                            "${readableSize(cacheBytes)} of downloaded media. Your messages stay."
                        },
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.textTertiary,
                    )
                }
            }
        }

        // ── Devices ─────────────────────────────────────────────────────────
        Section("Active sessions")
        SettingsGroup {
            val list = devices
            when {
                // "Loading…" used to be the answer to a failed request as well
                // as a pending one, forever. A failure names itself and
                // offers the retry on the same row.
                list == null && devicesFailed -> Row(
                    Modifier
                        .fillMaxWidth()
                        .softClickable { scope.launch { loadDevices() } }
                        .semantics { role = Role.Button }
                        .padding(vertical = 12.dp, horizontal = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(Icons.Rounded.Warning, null, tint = colors.warning, modifier = Modifier.size(20.dp))
                    Spacer(Modifier.width(14.dp))
                    Text(
                        "Couldn't load your sessions",
                        style = MaterialTheme.typography.bodyLarge,
                        color = colors.textPrimary,
                        modifier = Modifier.weight(1f),
                    )
                    Text("Try again", style = MaterialTheme.typography.labelMedium, color = colors.accent)
                }

                list == null -> Row(
                    Modifier.fillMaxWidth().padding(vertical = 12.dp, horizontal = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    CircularProgressIndicator(Modifier.size(18.dp), color = colors.accent, strokeWidth = 2.dp)
                    Spacer(Modifier.width(14.dp))
                    Text("Checking…", style = MaterialTheme.typography.bodyMedium, color = colors.textTertiary)
                }

                list.isEmpty() -> Text(
                    "No sessions to show.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = colors.textTertiary,
                    modifier = Modifier.padding(vertical = 12.dp, horizontal = 4.dp),
                )

                else -> {
                    list.forEachIndexed { index, device ->
                        if (index > 0) Hairline()
                        SessionRow(device) {
                            scope.launch {
                                // Dropped only once the server agrees; a failed
                                // revoke leaves the row to try again rather than
                                // pretending the session is gone.
                                if (runCatching { container.repo.revokeDevice(device.id) }.isSuccess) {
                                    devices = devices?.filterNot { it.id == device.id }
                                }
                            }
                        }
                    }
                    // A dozen stale web sessions at one revoke each — arm,
                    // tap, wait, scroll, next — is how people give up halfway
                    // and leave the rest signed in. One row ends them all.
                    // Hidden while this is the only session, where it would
                    // be a red button that does nothing.
                    if (list.size > 1) {
                        Hairline()
                        SignOutOthersRow(
                            others = list.count { !it.isCurrent },
                            busy = signingOutOthers,
                        ) {
                            scope.launch {
                                signingOutOthers = true
                                val revoked = runCatching { container.repo.revokeOtherDevices() }.getOrNull()
                                // Re-read rather than filtered locally: the
                                // server decided which sessions it ended, and
                                // the list should show exactly that.
                                if (revoked != null) loadDevices()
                                signingOutOthers = false
                                snackbar.showSnackbar(
                                    when {
                                        revoked == null -> "Couldn't sign out your other devices"
                                        revoked == 1 -> "Signed out 1 other device"
                                        else -> "Signed out $revoked other devices"
                                    },
                                    duration = SnackbarDuration.Short,
                                )
                            }
                        }
                    }
                }
            }
        }

        // ── Account ─────────────────────────────────────────────────────────
        // The destructive pair lives inside the group rather than as two red
        // cards on the main scroll: every visit to Settings was walking past
        // the ejector seats.
        Section("Account")
        SettingsGroup {
            NavRow(Icons.Rounded.AlternateEmail, "Change username") { usernameOpen = true }
            Hairline()
            NavRow(Icons.Rounded.Lock, "Change password") { passwordOpen = true }
            Hairline()
            NavRow(Icons.Rounded.Info, "About", onClick = onOpenAbout)
            Hairline()
            Row(
                Modifier
                    .fillMaxWidth()
                    // Confirmed first: one stray tap on a red row should not
                    // cost a session. Tester feedback, and they were right.
                    .softClickable { signOutConfirmOpen = true }
                    .padding(vertical = 13.dp, horizontal = 4.dp),
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
            Hairline()
            Row(
                Modifier
                    .fillMaxWidth()
                    .softClickable { deleteOpen = true }
                    .padding(vertical = 13.dp, horizontal = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Rounded.Delete, null, tint = colors.danger, modifier = Modifier.size(20.dp))
                Spacer(Modifier.width(14.dp))
                Text("Delete account", style = MaterialTheme.typography.bodyLarge, color = colors.danger)
            }
        }

        // The page scrolls under the transparent navigation bar; the last
        // group stops above it by the bar's real height on this phone.
        Spacer(Modifier.navigationBarsPadding().height(24.dp))
    }

    if (blockedOpen) BlockedAccountsSheet(onDismiss = { blockedOpen = false })
    if (passwordOpen) ChangePasswordSheet(onDismiss = { passwordOpen = false })
    if (usernameOpen) {
        ChangeUsernameSheet(
            current = me?.username.orEmpty(),
            onDismiss = { usernameOpen = false },
        )
    }
    if (deleteOpen) DeleteAccountSheet(onDismiss = { deleteOpen = false })
    me?.let { user ->
        if (editProfileOpen) EditProfileSheet(user, onDismiss = { editProfileOpen = false })
        if (shareProfileOpen) ShareProfileSheet(user, onDismiss = { shareProfileOpen = false })
    }
    if (signOutConfirmOpen) {
        val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
        ModalBottomSheet(
            onDismissRequest = { signOutConfirmOpen = false },
            sheetState = sheetState,
            containerColor = colors.surface,
            contentColor = colors.textPrimary,
        ) {
            Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 28.dp)) {
                Text("Sign out?", style = MaterialTheme.typography.titleMedium, color = colors.textPrimary)
                Spacer(Modifier.height(6.dp))
                Text(
                    "Your messages stay. You can sign back in any time.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = colors.textTertiary,
                )
                Spacer(Modifier.height(18.dp))
                NeuButton(
                    onClick = {
                        signOutConfirmOpen = false
                        scope.launch { container.signOut() }
                    },
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text("Sign out", style = MaterialTheme.typography.labelLarge, color = colors.danger)
                }
                Spacer(Modifier.height(10.dp))
                NeuButton(
                    onClick = { signOutConfirmOpen = false },
                    accent = true,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text("Stay signed in", style = MaterialTheme.typography.labelLarge, color = colors.onAccent)
                }
            }
        }
    }
}

// ── Profile banner ───────────────────────────────────────────────────────────

/**
 * The profile banner, editable in place. Tap to pick, long-press to remove.
 *
 * The preview is the exact crop the profile screen draws, so what you see here
 * is what visitors get.
 */
@Composable
private fun BannerEditor(
    url: String?,
    busy: Boolean,
    enabled: Boolean,
    onPicked: (android.net.Uri) -> Unit,
    onRemove: () -> Unit,
) {
    val colors = neuColors
    val picker = androidx.activity.compose.rememberLauncherForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.PickVisualMedia(),
    ) { uri -> if (uri != null) onPicked(uri) }

    Box(
        Modifier
            .fillMaxWidth()
            .height(84.dp)
            .clip(RoundedCornerShape(Neu.CornerSmall))
            .background(colors.accentSoft)
            .then(
                if (enabled && !busy) {
                    Modifier.softClickable {
                        picker.launch(
                            androidx.activity.result.PickVisualMediaRequest(
                                androidx.activity.result.contract.ActivityResultContracts.PickVisualMedia.ImageOnly,
                            ),
                        )
                    }
                } else {
                    Modifier
                },
            ),
        contentAlignment = Alignment.Center,
    ) {
        if (url != null) {
            AsyncImage(
                model = url,
                contentDescription = "Profile banner",
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxWidth().height(84.dp),
            )
        } else {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Rounded.PhotoCamera, null, tint = colors.textTertiary, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(6.dp))
                Text("Add a banner", style = MaterialTheme.typography.labelMedium, color = colors.textTertiary)
            }
        }

        if (busy) {
            Box(
                Modifier.fillMaxWidth().height(84.dp).background(colors.surface.copy(alpha = 0.6f)),
                contentAlignment = Alignment.Center,
            ) {
                CircularProgressIndicator(color = colors.accent, strokeWidth = 2.dp)
            }
        } else if (url != null) {
            Box(
                Modifier
                    .align(Alignment.BottomEnd)
                    .padding(6.dp)
                    .size(26.dp)
                    .clip(androidx.compose.foundation.shape.CircleShape)
                    .background(colors.danger)
                    .softClickable(onClick = onRemove),
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Rounded.Delete, "Remove banner", tint = colors.onAccent, modifier = Modifier.size(14.dp))
            }
        }
    }
}

// ── Account sheets ───────────────────────────────────────────────────────────

/**
 * Rename.
 *
 * The server keeps the old handle in `username_history`, so links and mentions
 * that used it still resolve — that is worth saying out loud, because "will my
 * old @ break?" is the reason most people never touch this.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ChangeUsernameSheet(current: String, onDismiss: () -> Unit) {
    val container = LocalContainer.current
    val colors = neuColors
    val scope = rememberCoroutineScope()

    var draft by remember { mutableStateOf("") }
    var state by remember { mutableStateOf(CheckState.Idle) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var check by remember { mutableStateOf<Job?>(null) }

    val trimmed = draft.trim().lowercase()
    val canSave = !busy && state == CheckState.Free && trimmed != current.lowercase() && trimmed.length >= 3

    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = colors.surface,
        contentColor = colors.textPrimary,
    ) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 28.dp)) {
            Text("Change username", style = MaterialTheme.typography.titleMedium, color = colors.textPrimary)
            Spacer(Modifier.height(6.dp))
            Text(
                "Your old @$current keeps working for mentions and links that already " +
                    "point at it. You can change this about once a day.",
                style = MaterialTheme.typography.bodyMedium,
                color = colors.textTertiary,
            )

            Spacer(Modifier.height(16.dp))
            NeuTextField(
                value = draft,
                onValueChange = { next ->
                    draft = next
                    error = null
                    check?.cancel()
                    val candidate = next.trim().lowercase()
                    if (candidate.length < 3 || candidate == current.lowercase()) {
                        state = CheckState.Idle
                        return@NeuTextField
                    }
                    state = CheckState.Checking
                    // Debounced, because the availability endpoint is
                    // rate-limited per second and a keystroke-per-request burns
                    // that budget on prefixes nobody typed on purpose.
                    check = scope.launch {
                        delay(400)
                        val free = runCatching { container.repo.usernameAvailable(candidate).available }
                            .getOrDefault(false)
                        if (candidate == draft.trim().lowercase()) {
                            state = if (free) CheckState.Free else CheckState.Taken
                        }
                    }
                },
                placeholder = current,
                modifier = Modifier.fillMaxWidth(),
                leading = {
                    Text("@", style = MaterialTheme.typography.bodyLarge, color = colors.textTertiary)
                },
                trailing = {
                    when (state) {
                        CheckState.Checking -> CircularProgressIndicator(
                            color = colors.accent,
                            strokeWidth = 2.dp,
                            modifier = Modifier.size(16.dp),
                        )
                        CheckState.Free -> Icon(
                            Icons.Rounded.Check, null, tint = colors.success, modifier = Modifier.size(18.dp),
                        )
                        CheckState.Taken -> Icon(
                            Icons.Rounded.Block, null, tint = colors.danger, modifier = Modifier.size(18.dp),
                        )
                        CheckState.Idle -> Unit
                    }
                },
            )

            val message = error ?: "That one is taken.".takeIf { state == CheckState.Taken }
            message?.let {
                Spacer(Modifier.height(8.dp))
                Text(it, style = MaterialTheme.typography.labelSmall, color = colors.danger)
            }

            Spacer(Modifier.height(18.dp))
            NeuButton(
                onClick = {
                    if (!canSave) return@NeuButton
                    busy = true
                    error = null
                    scope.launch {
                        runCatching { container.repo.changeUsername(trimmed).user }
                            .onSuccess { container.setMe(it); onDismiss() }
                            .onFailure { failure ->
                                // The rate limit is the one people actually hit,
                                // and "429" is not an explanation.
                                error = (failure as? gg.yappy.app.data.ApiException)
                                    ?.takeIf { it.isRateLimited }
                                    ?.let { "You have changed it too recently. Try again tomorrow." }
                                    ?: failure.message
                                    ?: "That did not work. Try again."
                            }
                        busy = false
                    }
                },
                accent = true,
                enabled = canSave,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(
                    if (busy) "Saving…" else "Save",
                    style = MaterialTheme.typography.labelLarge,
                    color = colors.onAccent,
                )
            }
        }
    }
}

private enum class CheckState { Idle, Checking, Free, Taken }

/**
 * Changing a password without being thrown out for it.
 *
 * The server ends every session on a change — that is the point of changing a
 * password after a scare — and hands back a fresh one for the device that did
 * it. Saving those tokens is what makes the difference between "your other
 * devices were signed out" and "you were signed out", and the second is how a
 * person ends up never changing their password again.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ChangePasswordSheet(onDismiss: () -> Unit) {
    val container = LocalContainer.current
    val colors = neuColors
    val scope = rememberCoroutineScope()

    var current by remember { mutableStateOf("") }
    var next by remember { mutableStateOf("") }
    var show by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var done by remember { mutableStateOf(false) }

    val canSave = !busy && current.isNotEmpty() && next.length >= 8 && next != current

    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = colors.surface,
        contentColor = colors.textPrimary,
    ) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 28.dp)) {
            Text("Change password", style = MaterialTheme.typography.titleMedium, color = colors.textPrimary)
            Spacer(Modifier.height(6.dp))
            Text(
                if (done) {
                    "Done. Every other device has been signed out; this one stays as it is."
                } else {
                    "Your other devices are signed out. You stay signed in here."
                },
                style = MaterialTheme.typography.bodyMedium,
                color = colors.textTertiary,
            )

            if (!done) {
                Spacer(Modifier.height(16.dp))
                NeuTextField(
                    value = current,
                    onValueChange = { current = it.take(200); error = null },
                    placeholder = "Current password",
                    visualTransformation =
                        if (show) VisualTransformation.None else PasswordVisualTransformation(),
                    keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(
                        keyboardType = KeyboardType.Password,
                    ),
                    modifier = Modifier.fillMaxWidth(),
                )

                Spacer(Modifier.height(10.dp))
                NeuTextField(
                    value = next,
                    onValueChange = { next = it.take(200); error = null },
                    placeholder = "New password (at least 8)",
                    visualTransformation =
                        if (show) VisualTransformation.None else PasswordVisualTransformation(),
                    keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(
                        keyboardType = KeyboardType.Password,
                    ),
                    trailing = {
                        Icon(
                            if (show) Icons.Rounded.VisibilityOff else Icons.Rounded.Visibility,
                            if (show) "Hide password" else "Show password",
                            tint = colors.textTertiary,
                            modifier = Modifier.size(18.dp).softClickable { show = !show },
                        )
                    },
                    modifier = Modifier.fillMaxWidth(),
                )

                error?.let {
                    Spacer(Modifier.height(8.dp))
                    Text(it, style = MaterialTheme.typography.labelSmall, color = colors.danger)
                }

                Spacer(Modifier.height(18.dp))
                NeuButton(
                    onClick = {
                        if (!canSave) return@NeuButton
                        busy = true
                        error = null
                        scope.launch {
                            runCatching { container.repo.changePassword(current, next) }
                                .onSuccess { tokens ->
                                    // The session that came back replaces the one
                                    // this change just revoked.
                                    container.session.saveTokens(tokens.accessToken, tokens.refreshToken)
                                    current = ""
                                    next = ""
                                    done = true
                                }
                                .onFailure { failure ->
                                    error = (failure as? gg.yappy.app.data.ApiException)?.message
                                        ?: "That did not work. Try again."
                                }
                            busy = false
                        }
                    },
                    accent = true,
                    enabled = canSave,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(
                        if (busy) "Saving…" else "Change password",
                        style = MaterialTheme.typography.labelLarge,
                        color = colors.onAccent,
                    )
                }
            } else {
                Spacer(Modifier.height(18.dp))
                NeuButton(onClick = onDismiss, accent = true, modifier = Modifier.fillMaxWidth()) {
                    Text("Done", style = MaterialTheme.typography.labelLarge, color = colors.onAccent)
                }
            }
        }
    }
}

/**
 * Deleting the account.
 *
 * In the app because the Play Store requires it of anything that can create an
 * account, and behind a typed confirmation because it is the one destructive
 * action here that a mis-tap should not be able to reach.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DeleteAccountSheet(onDismiss: () -> Unit) {
    val container = LocalContainer.current
    val colors = neuColors
    val scope = rememberCoroutineScope()

    var confirmation by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    val armed = confirmation.trim().equals("delete", ignoreCase = true)

    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = colors.surface,
        contentColor = colors.textPrimary,
    ) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 30.dp)) {
            Text("Delete account", style = MaterialTheme.typography.titleMedium, color = colors.danger)
            Spacer(Modifier.height(8.dp))
            Text(
                "Your profile, username and picture are removed right away, and " +
                    "everything else is erased for good after 30 days.\n\n" +
                    "Signing back in during those 30 days cancels it. After that it " +
                    "cannot be undone.",
                style = MaterialTheme.typography.bodyMedium,
                color = colors.textSecondary,
            )

            Spacer(Modifier.height(20.dp))
            Text(
                "Type DELETE to confirm",
                style = MaterialTheme.typography.labelSmall,
                color = colors.textTertiary,
            )
            Spacer(Modifier.height(6.dp))
            NeuTextField(
                value = confirmation,
                onValueChange = { confirmation = it },
                placeholder = "DELETE",
                keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(
                    capitalization = KeyboardCapitalization.Characters,
                ),
                modifier = Modifier.fillMaxWidth(),
            )

            error?.let {
                Spacer(Modifier.height(8.dp))
                Text(it, style = MaterialTheme.typography.labelSmall, color = colors.danger)
            }

            Spacer(Modifier.height(18.dp))
            NeuButton(
                onClick = {
                    if (!armed || busy) return@NeuButton
                    busy = true
                    error = null
                    scope.launch {
                        if (runCatching { container.repo.deleteAccount() }.isSuccess) {
                            // Sign out locally too: the tokens are dead
                            // server-side, and leaving the app on a signed-in
                            // screen it can no longer load is a worse ending
                            // than the sign-in screen.
                            container.signOut()
                        } else {
                            error = "That did not work. Try again."
                            busy = false
                        }
                    }
                },
                enabled = armed && !busy,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(
                    if (busy) "Deleting…" else "Delete my account",
                    style = MaterialTheme.typography.labelLarge,
                    color = colors.danger,
                )
            }

            Spacer(Modifier.height(10.dp))
            NeuButton(onClick = onDismiss, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
                Text(
                    "Keep my account",
                    style = MaterialTheme.typography.labelLarge,
                    color = colors.textSecondary,
                )
            }
        }
    }
}

/**
 * Blocked accounts, and the way back out of one.
 *
 * Blocking is otherwise one-way in practice: you can block from a profile, but
 * finding that profile again to undo it means remembering who they were.
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
        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 28.dp)) {
            Text("Blocked accounts", style = MaterialTheme.typography.titleMedium, color = colors.textPrimary)
            Spacer(Modifier.height(12.dp))

            val list = blocked
            when {
                list == null -> Box(Modifier.fillMaxWidth().padding(vertical = 30.dp), Alignment.Center) {
                    CircularProgressIndicator(color = colors.accent)
                }

                list.isEmpty() -> Text(
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
                        TextAction("Unblock", color = colors.accent) {
                            scope.launch {
                                // Dropped from the list only once the server
                                // agrees, so a failed call leaves the row
                                // there to try again rather than pretending.
                                if (runCatching { container.repo.unblock(user.id) }.isSuccess) {
                                    blocked = blocked?.filterNot { it.id == user.id }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

// ── Layout helpers ───────────────────────────────────────────────────────────

@Composable
private fun Section(title: String) {
    Spacer(Modifier.height(24.dp))
    SectionLabel(title, Modifier.padding(horizontal = 22.dp))
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
private fun Hairline(modifier: Modifier = Modifier) {
    val colors = neuColors
    Box(modifier.fillMaxWidth().height(1.dp).background(colors.hairline))
}

/**
 * One setting, as one control.
 *
 * The whole row toggles, not just the 48x28 switch at its far edge — that is
 * what every settings row on the platform does, and it is what people aim
 * for. To TalkBack the row is a single switch that reads its own title and
 * subtitle; the NeuSwitch inside is stripped of semantics so it is not
 * announced a second time as an unlabeled control.
 */
@Composable
private fun ToggleRow(
    icon: ImageVector,
    title: String,
    subtitle: String?,
    checked: Boolean,
    onChange: (Boolean) -> Unit,
) {
    val colors = neuColors
    val interaction = remember { MutableInteractionSource() }
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .toggleable(
                value = checked,
                interactionSource = interaction,
                indication = null,
                role = Role.Switch,
                onValueChange = onChange,
            )
            .padding(vertical = 10.dp, horizontal = 4.dp),
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
        NeuSwitch(checked, onChange, Modifier.clearAndSetSemantics { })
    }
}

/**
 * A signed-in device, and the way to end it.
 *
 * "Sign out" is armed on the first tap and fires on the second, the same
 * two-tap pattern the group settings use for anything that cannot be undone.
 * A confirmation sheet for a row this small would be ceremony; a single tap
 * that ends a session somebody else is in the middle of would be a trap.
 */
@Composable
private fun SessionRow(device: DeviceEntry, onRevoke: () -> Unit) {
    val colors = neuColors
    var armed by remember(device.id) { mutableStateOf(false) }
    // Disarms itself: a tap that was a mistake should not stay loaded.
    LaunchedEffect(armed) {
        if (armed) {
            delay(3_000)
            armed = false
        }
    }

    Row(
        Modifier.fillMaxWidth().padding(vertical = 8.dp, horizontal = 4.dp),
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
            // "Android 14 · Last seen Tue": what it is and when it was last
            // here, which is the pair anybody scanning for a stranger needs.
            Text(
                listOfNotNull(
                    if (device.isCurrent) "This device" else (device.osVersion ?: device.platform),
                    device.lastActiveAt?.takeIf { !device.isCurrent }
                        ?.let { relativeTime(it) }
                        ?.takeIf { it.isNotBlank() }
                        ?.let { "Last seen $it" },
                ).joinToString(" · "),
                style = MaterialTheme.typography.labelSmall,
                color = if (device.isCurrent) colors.success else colors.textTertiary,
            )
        }
        if (!device.isCurrent) {
            TextAction(
                if (armed) "Tap again" else "Sign out",
                color = colors.danger,
            ) {
                if (armed) {
                    armed = false
                    onRevoke()
                } else {
                    armed = true
                }
            }
        }
    }
}

/**
 * [SessionRow]'s "Sign out" for every other session at once, with the same
 * two-tap arm. The second tap is not a formality here: whoever is on the
 * laptop is signed out mid-sentence, so the armed state says how many that
 * is before it happens.
 */
@Composable
private fun SignOutOthersRow(others: Int, busy: Boolean, onConfirmed: () -> Unit) {
    val colors = neuColors
    var armed by remember { mutableStateOf(false) }
    // Disarms itself: a tap that was a mistake should not stay loaded.
    LaunchedEffect(armed) {
        if (armed) {
            delay(3_000)
            armed = false
        }
    }

    Row(
        Modifier.fillMaxWidth().padding(vertical = 8.dp, horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            Icons.AutoMirrored.Rounded.Logout,
            null,
            tint = colors.danger,
            modifier = Modifier.size(20.dp),
        )
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Text("Sign out other devices", style = MaterialTheme.typography.bodyLarge, color = colors.danger)
            Text(
                when {
                    armed && others == 1 -> "Tap again to end 1 other session"
                    armed -> "Tap again to end $others other sessions"
                    else -> "Everywhere except this device"
                },
                style = MaterialTheme.typography.labelSmall,
                color = colors.textTertiary,
            )
        }
        if (busy) {
            CircularProgressIndicator(Modifier.size(18.dp), color = colors.accent, strokeWidth = 2.dp)
        } else {
            TextAction(
                if (armed) "Tap again" else "Sign out",
                color = colors.danger,
            ) {
                if (armed) {
                    armed = false
                    onConfirmed()
                } else {
                    armed = true
                }
            }
        }
    }
}

/**
 * A line of text that acts like a button, and is one to the platform: a 48dp
 * hit box around the label and a role, so a 17dp-tall "Unblock" is neither a
 * fiddly target nor read out as prose.
 */
@Composable
private fun TextAction(
    label: String,
    color: Color,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    Text(
        label,
        style = MaterialTheme.typography.labelMedium,
        color = color,
        modifier = modifier
            .minimumInteractiveComponentSize()
            .semantics { role = Role.Button }
            .softClickable(onClick = onClick),
    )
}

/**
 * A label with a row of chips under it.
 *
 * Chips rather than a dropdown: three short options fit, and a menu hides the
 * current answer behind a tap on a screen whose whole job is showing people
 * what their settings currently are.
 */
@Composable
private fun PickerRow(
    title: String,
    options: List<Pair<String, String>>,
    value: String,
    icon: ImageVector? = null,
    onChange: (String) -> Unit,
) {
    val colors = neuColors
    Column(Modifier.fillMaxWidth().padding(vertical = 11.dp, horizontal = 4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            icon?.let {
                Icon(it, null, tint = colors.textSecondary, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(10.dp))
            }
            Text(title, style = MaterialTheme.typography.titleSmall, color = colors.textPrimary)
        }
        Spacer(Modifier.height(9.dp))
        // One group to accessibility services: three chips of which exactly
        // one is chosen, rather than three unrelated buttons.
        Row(Modifier.selectableGroup(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            options.forEach { (key, label) ->
                NeuChip(label, value == key, onClick = { if (value != key) onChange(key) })
            }
        }
    }
}

@Composable
private fun NavRow(icon: ImageVector, title: String, onClick: () -> Unit) {
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
        Text(title, style = MaterialTheme.typography.bodyLarge, color = colors.textPrimary)
    }
}

/**
 * `HH:mm`, which is what the server stores — timezone-free by design, since the
 * zone travels beside it in the same PATCH.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TimeField(label: String, value: String, modifier: Modifier = Modifier, onPick: (String) -> Unit) {
    val colors = neuColors
    val parts = value.split(":")
    val hour = parts.getOrNull(0)?.toIntOrNull() ?: 23
    val minute = parts.getOrNull(1)?.toIntOrNull() ?: 0
    var pickerOpen by remember { mutableStateOf(false) }

    Column(modifier) {
        Text(label, style = MaterialTheme.typography.labelSmall, color = colors.textTertiary)
        Spacer(Modifier.height(4.dp))
        NeuSurface(
            Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(Neu.CornerSmall),
            contentPadding = 12.dp,
            onClick = { pickerOpen = true },
        ) {
            Text(
                value,
                style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.Medium),
                color = colors.textPrimary,
            )
        }
    }

    /**
     * A Compose sheet, not `android.app.TimePickerDialog`. The framework
     * dialog reads the *activity's* XML theme, which follows the system
     * setting — so with the app set to Dark on a light-mode phone, tapping a
     * quiet-hours field opened a glaring white dialog. This picker lives
     * inside our theme and draws from the bridged Material scheme.
     */
    if (pickerOpen) {
        val state = rememberTimePickerState(initialHour = hour, initialMinute = minute, is24Hour = true)
        ModalBottomSheet(
            onDismissRequest = { pickerOpen = false },
            containerColor = colors.surface,
        ) {
            Column(
                Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 28.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                TimePicker(state = state)
                Spacer(Modifier.height(6.dp))
                NeuButton(
                    onClick = {
                        pickerOpen = false
                        onPick("%02d:%02d".format(state.hour, state.minute))
                    },
                    modifier = Modifier.fillMaxWidth(),
                    accent = true,
                ) {
                    Text("Done", style = MaterialTheme.typography.titleSmall)
                }
            }
        }
    }
}

private fun readableSize(bytes: Long): String = when {
    bytes >= 1_000_000_000 -> "%.1f GB".format(bytes / 1_000_000_000.0)
    bytes >= 1_000_000 -> "%.1f MB".format(bytes / 1_000_000.0)
    bytes >= 1_000 -> "%d KB".format(bytes / 1_000)
    else -> "$bytes bytes"
}

// ── JSON reading ─────────────────────────────────────────────────────────────
//
// The settings blobs are free-form `JsonObject`s on the wire — the server owns
// their shape and adds keys without a client release. These read one value each
// and answer null for anything absent or of the wrong type, so a server that
// starts sending a string where a boolean was cannot crash the screen.

private fun JsonObject.bool(key: String): Boolean? =
    runCatching { this[key]?.jsonPrimitive?.booleanOrNull }.getOrNull()

private fun JsonObject.str(key: String): String? =
    runCatching { this[key]?.jsonPrimitive?.content?.takeIf { it != "null" } }.getOrNull()

private fun JsonObject.obj(key: String): JsonObject? =
    runCatching { this[key]?.jsonObject }.getOrNull()
