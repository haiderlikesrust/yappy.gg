package gg.yappy.app.ui.newchat

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.ArrowForward
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.DoNotDisturbOn
import androidx.compose.material.icons.rounded.Group
import androidx.compose.material.icons.rounded.Search
import androidx.compose.foundation.clickable
import androidx.compose.material.icons.rounded.Link
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.runtime.rememberCoroutineScope
import gg.yappy.app.LocalContainer
import gg.yappy.app.data.PublicUser
import gg.yappy.app.ui.components.Avatar
import gg.yappy.app.ui.components.NeuButton
import gg.yappy.app.ui.components.NeuChip
import gg.yappy.app.ui.components.NeuIconButton
import gg.yappy.app.ui.components.NeuSurface
import gg.yappy.app.ui.components.NeuTextField
import gg.yappy.app.ui.invite.InviteSheet
import gg.yappy.app.ui.theme.Neu
import gg.yappy.app.ui.theme.NeuState
import gg.yappy.app.ui.theme.neu
import gg.yappy.app.ui.theme.neuColors
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Campfire durations. Capped at a week deliberately — past that nobody holds
 * the end date in their head and it stops being a campfire.
 */
private val CAMPFIRE_CHOICES = listOf(
    "1 hour" to 3_600,
    "6 hours" to 21_600,
    "12 hours" to 43_200,
    "1 day" to 86_400,
    "3 days" to 259_200,
    "1 week" to 604_800,
)

/**
 * New conversation.
 *
 * One screen for both DMs and groups: tapping a person starts a DM, and
 * selecting several switches the primary action to "create group". Splitting
 * these into two entry points makes people back out and start over when they
 * change their mind halfway.
 */
@Composable
fun NewChatScreen(onBack: () -> Unit, onOpenChat: (String) -> Unit) {
    val container = LocalContainer.current
    val colors = neuColors
    val scope = rememberCoroutineScope()

    var query by remember { mutableStateOf("") }
    var contacts by remember { mutableStateOf<List<PublicUser>>(emptyList()) }
    var results by remember { mutableStateOf<List<PublicUser>>(emptyList()) }
    var selected by remember { mutableStateOf<Set<String>>(emptySet()) }
    var groupTitle by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    /** Non-null makes the new group a campfire. */
    var campfireSeconds by remember { mutableStateOf<Int?>(null) }

    /**
     * A code somebody was given rather than a link they could tap.
     *
     * The join page has always told people to "open the app and enter" their
     * code, and until now there was nowhere in the app to enter it. That is
     * the last step of the chain: an invite is shared, somebody without yappy
     * installs it, and the link that brought them is long gone by the time
     * they open the app.
     */
    var inviteCode by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        contacts = runCatching { container.repo.contacts().users }.getOrDefault(emptyList())
    }

    LaunchedEffect(query) {
        if (query.isBlank()) {
            results = emptyList()
            return@LaunchedEffect
        }
        delay(300) // debounce; the endpoint is rate limited
        results = runCatching { container.repo.searchUsers(query).users }.getOrDefault(emptyList())
    }

    val shown = if (query.isBlank()) contacts else results
    val selectedUsers = (contacts + results).distinctBy { it.id }.filter { it.id in selected }
    val groupMode = selected.size >= 2

    Column(Modifier.fillMaxSize().statusBarsPadding().imePadding()) {

        Row(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            NeuIconButton(Icons.AutoMirrored.Rounded.ArrowBack, "Back", onBack, size = 42.dp, iconSize = 19.dp)
            Spacer(Modifier.width(12.dp))
            Text(
                if (groupMode) "New group" else "New chat",
                style = MaterialTheme.typography.headlineSmall,
                color = colors.textPrimary,
            )
        }

        NeuTextField(
            value = query,
            onValueChange = { query = it },
            placeholder = "Search by name or @username",
            leading = { Icon(Icons.Rounded.Search, null, tint = colors.textTertiary, modifier = Modifier.size(19.dp)) },
            shape = RoundedCornerShape(Neu.CornerPill),
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
        )

        // Only when they are not already picking people. Somebody mid-way
        // through choosing who to message is not looking for this.
        if (!groupMode && selected.isEmpty() && query.isBlank()) {
            Spacer(Modifier.height(10.dp))
            InviteCodeRow(onCode = { inviteCode = it })
        }

        if (groupMode) {
            Spacer(Modifier.height(10.dp))
            NeuTextField(
                value = groupTitle,
                onValueChange = { groupTitle = it },
                placeholder = "Group name",
                leading = { Icon(Icons.Rounded.Group, null, tint = colors.textTertiary, modifier = Modifier.size(19.dp)) },
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
            )

            /**
             * Campfire: a group with an end date.
             *
             * Offered at creation and nowhere else on purpose. Turning an
             * ongoing group into one that deletes itself is a decision nobody
             * else in it agreed to, and the whole appeal of a campfire is that
             * everyone walked in knowing.
             */
            Spacer(Modifier.height(10.dp))
            Row(
                Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState())
                    .padding(horizontal = 16.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("🔥", style = MaterialTheme.typography.labelLarge)
                CAMPFIRE_CHOICES.forEach { (label, seconds) ->
                    val active = campfireSeconds == seconds
                    NeuChip(
                        label = label,
                        selected = active,
                        onClick = { campfireSeconds = if (active) null else seconds },
                    )
                }
            }
            campfireSeconds?.let {
                Text(
                    "This group and everything in it is deleted when the time is up.",
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.textTertiary,
                    modifier = Modifier.padding(horizontal = 20.dp, vertical = 6.dp),
                )
            }
        }

        Spacer(Modifier.height(12.dp))

        Box(Modifier.weight(1f)) {
            if (shown.isEmpty()) {
                // One line of grey text alone in a tall empty box reads as a
                // screen that failed to load. A mark and a second line that
                // says what to do next reads as a screen with nothing in it
                // yet, which is the truth.
                Box(Modifier.fillMaxSize(), Alignment.Center) {
                    Column(
                        Modifier.padding(horizontal = 48.dp).padding(bottom = 48.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Box(
                            Modifier.size(56.dp).neu(CircleShape, colors, NeuState.Pressed, 4.dp),
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(
                                Icons.Rounded.Search,
                                null,
                                tint = colors.textTertiary,
                                modifier = Modifier.size(24.dp),
                            )
                        }
                        Spacer(Modifier.height(14.dp))
                        Text(
                            if (query.isBlank()) "No contacts yet" else "No one found",
                            style = MaterialTheme.typography.titleSmall,
                            color = colors.textSecondary,
                        )
                        Spacer(Modifier.height(4.dp))
                        Text(
                            if (query.isBlank()) {
                                "Search for someone by name or @username, or paste an invite link."
                            } else {
                                "Check the spelling, or try their @username."
                            },
                            style = MaterialTheme.typography.labelSmall,
                            color = colors.textTertiary,
                            textAlign = TextAlign.Center,
                        )
                    }
                }
            } else {
                LazyColumn(
                    contentPadding = PaddingValues(horizontal = 16.dp, vertical = 4.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    items(shown, key = { it.id }) { user ->
                        val isSelected = user.id in selected
                        // Null means the endpoint did not say, which is not the
                        // same as "no" — an older server, or a list that never
                        // carried the field, must not turn the picker grey.
                        val canAdd = user.canAddToGroups ?: true

                        /**
                         * Selection is where the refusal lives, not the tap.
                         *
                         * The alternative — letting them be selected and failing
                         * at creation — is what this path used to do: the server
                         * drops anyone whose privacy refuses the add, and the
                         * group appears with only you in it. Refusing the
                         * selection moves that from a silent failure after the
                         * fact to a visible state before it.
                         */
                        val toggle = {
                            if (canAdd) {
                                selected = if (isSelected) selected - user.id else selected + user.id
                            }
                        }

                        NeuSurface(
                            modifier = Modifier.fillMaxWidth(),
                            shape = RoundedCornerShape(Neu.CornerMedium),
                            state = if (isSelected) NeuState.Pressed else NeuState.Raised,
                            elevation = if (isSelected) 3.dp else 5.dp,
                            contentPadding = 12.dp,
                            onClick = {
                                if (selected.isEmpty()) {
                                    // Single tap with nothing selected is the
                                    // fast path: straight into a DM. Still
                                    // offered to someone who cannot be added to
                                    // a group — whoCanDm is a separate setting,
                                    // and the usual answer to it is everyone.
                                    busy = true
                                    scope.launch {
                                        runCatching { container.repo.createDm(user.id).conversation.id }
                                            .onSuccess(onOpenChat)
                                        busy = false
                                    }
                                } else {
                                    toggle()
                                }
                            },
                            onLongClick = toggle,
                        ) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Box(Modifier.alpha(if (canAdd) 1f else 0.45f)) {
                                    Avatar(user.avatarUrl, user.label, user.id, size = 44.dp)
                                }
                                Spacer(Modifier.width(12.dp))
                                Column(Modifier.weight(1f)) {
                                    Text(
                                        user.label,
                                        style = MaterialTheme.typography.titleSmall,
                                        color = if (canAdd) colors.textPrimary else colors.textTertiary,
                                    )
                                    if (canAdd) {
                                        user.username?.let {
                                            Text(
                                                "@$it",
                                                style = MaterialTheme.typography.labelSmall,
                                                color = colors.textTertiary,
                                            )
                                        }
                                    } else {
                                        // The handle gives way to the reason.
                                        // Someone greyed out with no explanation
                                        // reads as a broken app; the same row
                                        // with "only their contacts can add
                                        // them" reads as a setting, and points
                                        // at what would change it.
                                        Text(
                                            "Only their contacts can add them to groups",
                                            style = MaterialTheme.typography.labelSmall,
                                            color = colors.textTertiary,
                                        )
                                    }
                                }
                                if (isSelected) {
                                    Box(
                                        Modifier
                                            .size(24.dp)
                                            .neu(CircleShape, colors, NeuState.Raised, 2.dp, colors.accent)
                                            .clip(CircleShape),
                                        contentAlignment = Alignment.Center,
                                    ) {
                                        Icon(
                                            Icons.Rounded.Check,
                                            null,
                                            tint = colors.onAccent,
                                            modifier = Modifier.size(14.dp),
                                        )
                                    }
                                } else if (!canAdd) {
                                    Icon(
                                        Icons.Rounded.DoNotDisturbOn,
                                        null,
                                        tint = colors.textTertiary,
                                        modifier = Modifier.size(20.dp),
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }

        if (groupMode) {
            NeuButton(
                onClick = {
                    busy = true
                    scope.launch {
                        runCatching {
                            container.repo.createGroup(
                                groupTitle.ifBlank { selectedUsers.joinToString { it.label } .take(60) },
                                selected.toList(),
                                campfireSeconds,
                            ).conversation.id
                        }.onSuccess(onOpenChat)
                        busy = false
                    }
                },
                accent = true,
                enabled = !busy,
                modifier = Modifier.fillMaxWidth().padding(16.dp),
            ) {
                if (busy) {
                    CircularProgressIndicator(Modifier.size(20.dp), color = colors.onAccent, strokeWidth = 2.dp)
                } else {
                    Text(
                        "Create group with ${selected.size}",
                        style = MaterialTheme.typography.labelLarge,
                        color = colors.onAccent,
                    )
                }
            }
        }
    }

    // The same sheet a tapped invite link opens, so a pasted code and a
    // followed link end in exactly the same place.
    inviteCode?.let { code ->
        InviteSheet(
            code = code,
            onJoined = { conversationId, _ ->
                inviteCode = null
                onOpenChat(conversationId)
            },
            onDismiss = { inviteCode = null },
        )
    }
}

/**
 * "Have an invite code?"
 *
 * Accepts whatever somebody actually has to hand. People paste the whole link
 * far more often than they type the ten characters out of the middle of it, and
 * rejecting the link would be pedantry — the code is right there in it.
 */
@Composable
private fun InviteCodeRow(onCode: (String) -> Unit) {
    val colors = neuColors
    var open by remember { mutableStateOf(false) }
    var text by remember { mutableStateOf("") }
    val focus = remember { FocusRequester() }

    val code = remember(text) { inviteCodeFrom(text) }

    // Opening it is a decision to paste something, so put the cursor where the
    // paste goes. Wrapped because requesting focus on a node that has not been
    // laid out yet throws, and a keyboard is not worth a crash.
    LaunchedEffect(open) { if (open) runCatching { focus.requestFocus() } }

    // One card, not two loose fields. The search box above is a pill and this
    // is a surface with a badge on it: at a glance they are different kinds of
    // thing, which is the whole job here — one finds a person, the other joins
    // a place.
    NeuSurface(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
        shape = RoundedCornerShape(Neu.CornerMedium),
        contentPadding = 12.dp,
        onClick = if (open) null else ({ open = true }),
    ) {
        Column(Modifier.fillMaxWidth()) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    Modifier.size(34.dp).neu(CircleShape, colors, NeuState.Raised, 2.dp, colors.accent),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(Icons.Rounded.Link, null, tint = colors.onAccent, modifier = Modifier.size(16.dp))
                }
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Text(
                        "Have an invite link?",
                        style = MaterialTheme.typography.titleSmall,
                        color = colors.textPrimary,
                    )
                    Text(
                        if (open) "Paste it below" else "Paste it to join a group",
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.textTertiary,
                    )
                }
                if (open) {
                    NeuIconButton(
                        Icons.Rounded.Close,
                        "Cancel",
                        { open = false; text = "" },
                        size = 32.dp,
                        iconSize = 15.dp,
                    )
                }
            }

            AnimatedVisibility(open) {
                Column {
                    Spacer(Modifier.height(10.dp))
                    // The action lives inside the field, not under it. A
                    // full-width accent button that spends nearly all its life
                    // disabled is a slab of dead colour on an otherwise empty
                    // screen, and it reads as the primary thing to do here,
                    // which it is not.
                    NeuTextField(
                        value = text,
                        onValueChange = { text = it },
                        placeholder = "yappy.gg/join/…",
                        shape = RoundedCornerShape(Neu.CornerPill),
                        trailing = {
                            NeuIconButton(
                                Icons.AutoMirrored.Rounded.ArrowForward,
                                "Join",
                                { code?.let(onCode) },
                                size = 32.dp,
                                iconSize = 16.dp,
                                accent = true,
                                enabled = code != null,
                            )
                        },
                        modifier = Modifier.fillMaxWidth().focusRequester(focus),
                    )
                    // Somebody who pasted a long URL cannot tell what was
                    // understood from it. This says so before they commit.
                    code?.let {
                        Spacer(Modifier.height(6.dp))
                        Text(
                            "Invite code $it",
                            style = MaterialTheme.typography.labelSmall,
                            color = colors.accent,
                            modifier = Modifier.padding(start = 4.dp),
                        )
                    }
                }
            }
        }
    }
}

/**
 * The code out of anything somebody might paste.
 *
 * `yappy.gg/join/abc123`, `https://yappy.gg/join/abc123?x=1`, `yappy://join/abc123`,
 * or the bare `abc123`. Returns null when there is nothing code-shaped in it,
 * which is what keeps the button disabled rather than sending a lookup for
 * whatever happened to be on the clipboard.
 */
private fun inviteCodeFrom(input: String): String? {
    val trimmed = input.trim()
    if (trimmed.isEmpty()) return null

    val afterJoin = trimmed.substringAfterLast("join/", trimmed)
    val candidate = afterJoin.substringBefore('?').substringBefore('#').trim().trimEnd('/')

    // Invite codes are lowercase alphanumeric; anything else is a paste that
    // did not contain one.
    return candidate.takeIf { it.length in 6..32 && it.all(Char::isLetterOrDigit) }
}
