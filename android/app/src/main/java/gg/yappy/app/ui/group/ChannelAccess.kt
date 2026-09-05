package gg.yappy.app.ui.group

import androidx.compose.foundation.background
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
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
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import gg.yappy.app.LocalContainer
import gg.yappy.app.data.ApiException
import gg.yappy.app.data.ChannelOverwrite
import gg.yappy.app.data.RoleEntry
import gg.yappy.app.ui.components.NeuChip
import gg.yappy.app.ui.components.NeuSwitch
import gg.yappy.app.ui.components.flairColor
import gg.yappy.app.ui.theme.Neu
import gg.yappy.app.ui.theme.neuColors
import kotlinx.coroutines.launch

/** What "let this role in" grants: see it, read it, speak in it. */
private const val CHANNEL_VIEW = 1L shl 0
private const val CHANNEL_ACCESS = (1L shl 0) or (1L shl 1) or (1L shl 2)

/**
 * A refusal in the card's own register. The server's 403 reads "Missing
 * permission: MANAGE_CONVERSATION" — the right fact in wire-format words, and
 * the floor and the role switches sit on different bits, so a member can
 * genuinely hold one and not the other. Everything else (offline, a rate
 * limit) gets the sentence the caller passes.
 */
private fun accessFailure(cause: Throwable, fallback: String): String =
    if ((cause as? ApiException)?.code == "missing_permission") {
        "You don't have permission to change that."
    } else {
        fallback
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
 *
 * One editor for both places it is offered — the channel's settings page and
 * the long-press sheet on the space — because the two copies had drifted: one
 * drew a check mark, the other a switch that ignored its own taps. The switch
 * stays, and it toggles.
 *
 * A refusal is said here, under the chips, not in a snackbar: one of the two
 * hosts is a bottom sheet, and a snackbar lands behind a sheet. It used to be
 * swallowed — the tap did nothing and nothing said why — and the settings
 * page is open to every member, so for most of them that was every tap.
 *
 * @param gated whether the floor is already at nothing, as the caller knows it.
 * @param onGatedChanged the floor moved; the caller updates whatever it keeps.
 * @param onChanged a role was let in or out.
 */
@Composable
fun ChannelAccessEditor(
    conversationId: String,
    spaceId: String,
    gated: Boolean,
    onGatedChanged: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
    onChanged: () -> Unit = {},
    horizontalPadding: Dp = 0.dp,
) {
    val container = LocalContainer.current
    val colors = neuColors
    val scope = rememberCoroutineScope()

    var roles by remember(spaceId) { mutableStateOf<List<RoleEntry>?>(null) }
    var overwrites by remember(conversationId) { mutableStateOf<List<ChannelOverwrite>>(emptyList()) }
    // Local so the chips answer immediately; re-keyed on the caller's value so
    // a refetch that disagrees wins.
    var isGated by remember(conversationId, gated) { mutableStateOf(gated) }
    /** Which control is mid-flight: "gate", a role id, or nothing. */
    var busy by remember { mutableStateOf<String?>(null) }
    /** Why the last tap changed nothing, or null. The next attempt clears it. */
    var error by remember(conversationId) { mutableStateOf<String?>(null) }

    LaunchedEffect(conversationId, spaceId) {
        roles = runCatching { container.repo.roles(spaceId).roles }.getOrDefault(emptyList())
        overwrites = runCatching { container.repo.channelOverwrites(conversationId).overwrites }
            .getOrDefault(emptyList())
    }

    fun allowed(roleId: String): Boolean {
        val allow = overwrites.firstOrNull { it.roleId == roleId }?.allow?.toLongOrNull() ?: 0L
        return allow and CHANNEL_VIEW != 0L
    }

    fun setGate(want: Boolean) {
        if (busy != null || isGated == want) return
        busy = "gate"
        error = null
        scope.launch {
            runCatching {
                if (want) container.repo.setBasePermissions(conversationId, "0")
                else container.repo.clearBasePermissions(conversationId)
            }.onSuccess {
                isGated = want
                onGatedChanged(want)
            }.onFailure {
                error = accessFailure(it, "Couldn't change who can see this channel.")
            }
            busy = null
        }
    }

    fun toggle(role: RoleEntry) {
        if (busy != null) return
        val on = allowed(role.id)
        busy = role.id
        error = null
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
                    overwrites = overwrites.filterNot { it.roleId == role.id } + saved
                }
            }.onSuccess { onChanged() }
                .onFailure { error = accessFailure(it, "Couldn't change that role's access.") }
            busy = null
        }
    }

    Column(modifier.padding(horizontal = horizontalPadding)) {
        Text(
            if (isGated) {
                "Only the roles you pick below, plus admins."
            } else {
                "Everyone in the space, like every other channel."
            },
            style = MaterialTheme.typography.labelSmall,
            color = colors.textTertiary,
        )
        Spacer(Modifier.height(12.dp))

        // One choice of two; the group lets the reader count them.
        Row(Modifier.selectableGroup(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            NeuChip("Everyone", selected = !isGated, onClick = { setGate(false) })
            NeuChip("Only these roles", selected = isGated, onClick = { setGate(true) })
        }

        error?.let {
            Spacer(Modifier.height(8.dp))
            Text(it, style = MaterialTheme.typography.labelSmall, color = colors.danger)
        }

        if (!isGated) return@Column

        Spacer(Modifier.height(12.dp))
        val list = roles
        when {
            list == null -> Text(
                "Loading roles…",
                style = MaterialTheme.typography.labelSmall,
                color = colors.textTertiary,
            )

            list.isEmpty() -> Text(
                "This space has no roles yet. Make one first — a channel for " +
                    "nobody is a channel nobody can read, including you tomorrow.",
                style = MaterialTheme.typography.labelSmall,
                color = colors.textTertiary,
            )

            else -> list.forEach { role ->
                val on = allowed(role.id)
                /*
                 * The whole row is the switch, the way SettingsScreen's rows
                 * are. To TalkBack that is one stop that reads the role name
                 * and its state; the NeuSwitch inside is stripped of semantics
                 * so it is not announced a second time as a switch with no
                 * name. Its pointer input stays, so a thumb aimed at the
                 * switch itself still lands, tick and all.
                 */
                val interaction = remember { MutableInteractionSource() }
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(Neu.CornerSmall))
                        .toggleable(
                            value = on,
                            interactionSource = interaction,
                            indication = null,
                            enabled = busy == null,
                            role = Role.Switch,
                            onValueChange = { toggle(role) },
                        )
                        .padding(vertical = 8.dp),
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
                    NeuSwitch(
                        checked = on,
                        onCheckedChange = { toggle(role) },
                        modifier = Modifier.clearAndSetSemantics { },
                    )
                }
            }
        }
    }
}
