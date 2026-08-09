package gg.yappy.app.ui.newchat

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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.DoNotDisturbOn
import androidx.compose.material.icons.rounded.Group
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
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import androidx.compose.runtime.rememberCoroutineScope
import gg.yappy.app.LocalContainer
import gg.yappy.app.data.PublicUser
import gg.yappy.app.ui.components.Avatar
import gg.yappy.app.ui.components.NeuButton
import gg.yappy.app.ui.components.NeuIconButton
import gg.yappy.app.ui.components.NeuSurface
import gg.yappy.app.ui.components.NeuTextField
import gg.yappy.app.ui.theme.Neu
import gg.yappy.app.ui.theme.NeuState
import gg.yappy.app.ui.theme.neu
import gg.yappy.app.ui.theme.neuColors
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

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

        if (groupMode) {
            Spacer(Modifier.height(10.dp))
            NeuTextField(
                value = groupTitle,
                onValueChange = { groupTitle = it },
                placeholder = "Group name",
                leading = { Icon(Icons.Rounded.Group, null, tint = colors.textTertiary, modifier = Modifier.size(19.dp)) },
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
            )
        }

        Spacer(Modifier.height(12.dp))

        Box(Modifier.weight(1f)) {
            if (shown.isEmpty()) {
                Box(Modifier.fillMaxSize(), Alignment.Center) {
                    Text(
                        if (query.isBlank()) "No contacts yet — search for someone" else "No one found",
                        style = MaterialTheme.typography.bodyMedium,
                        color = colors.textTertiary,
                    )
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
}
