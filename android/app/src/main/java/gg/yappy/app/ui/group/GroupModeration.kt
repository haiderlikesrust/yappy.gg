package gg.yappy.app.ui.group

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
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
import androidx.compose.ui.unit.dp
import gg.yappy.app.LocalContainer
import gg.yappy.app.data.BanEntry
import gg.yappy.app.data.Invite
import gg.yappy.app.ui.components.Avatar
import gg.yappy.app.ui.components.NeuButton
import gg.yappy.app.ui.components.NeuChip
import gg.yappy.app.ui.components.softClickable
import gg.yappy.app.ui.theme.neuColors
import gg.yappy.app.ui.util.relativeTime
import kotlinx.coroutines.launch
import gg.yappy.app.data.RoleEntry

/**
 * Moderation surfaces that are too big to live inside the settings scroll: the
 * ban list, and invite-link management.
 */

// ── Permission arithmetic ────────────────────────────────────────────────────

/**
 * The conversation-wide permission floor, as the server computes it.
 *
 * Duplicated from `packages/shared/src/permissions.ts` because these bits are
 * part of the wire format and cannot move without a coordinated release. Only
 * the two floors the UI can actually set are mirrored — the full table stays
 * server-side.
 */
object BaseFloor {
    private fun bit(index: Int): Long = 1L shl index

    /** What an ordinary group gives everyone: read, write, react, call, invite. */
    val MEMBER: Long = run {
        val send = bit(2) or bit(3) or bit(4) or bit(5) or bit(6) or bit(7) or bit(8) or bit(10)
        val own = bit(11) or bit(12)
        bit(0) or bit(1) or send or own or bit(20) or bit(21) or bit(23) or bit(30)
    }

    /**
     * Announcement mode: everyone may read and react, nobody may post. Roles
     * hand posting back to the people who should still have it, which is why
     * this works as a *floor* rather than as a lock.
     */
    val ANNOUNCEMENT: Long = bit(0) or bit(1) or bit(8)

    /**
     * A conversation with no explicit base inherits [MEMBER], so null reads as
     * "everyone can post".
     */
    fun isAnnouncement(raw: String?): Boolean {
        val bits = raw?.toLongOrNull() ?: return false
        return bits and bit(2) == 0L
    }
}

// ── Ban list ─────────────────────────────────────────────────────────────────

/**
 * Who has been thrown out, and the way back in.
 *
 * Until this existed a ban was a one-way door: the API could set one and clear
 * one, but nothing on Android could tell you a ban was there, so an accidental
 * ban was unrecoverable from inside the app.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BanListSheet(conversationId: String, onDismiss: () -> Unit) {
    val container = LocalContainer.current
    val colors = neuColors
    val scope = rememberCoroutineScope()

    /** Null while loading, so the empty state does not flash before the answer. */
    var bans by remember { mutableStateOf<List<BanEntry>?>(null) }
    var working by remember { mutableStateOf<Set<String>>(emptySet()) }

    LaunchedEffect(conversationId) {
        bans = runCatching { container.repo.bans(conversationId).bans }.getOrDefault(emptyList())
    }

    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = colors.surface,
        contentColor = colors.textPrimary,
    ) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 28.dp)) {
            Text("Banned", style = MaterialTheme.typography.titleMedium, color = colors.textPrimary)
            Spacer(Modifier.padding(top = 4.dp))
            Text(
                "Someone who is banned cannot rejoin, even with an invite link.",
                style = MaterialTheme.typography.labelSmall,
                color = colors.textTertiary,
            )
            Spacer(Modifier.padding(top = 14.dp))

            val list = bans
            when {
                list == null -> Box(Modifier.fillMaxWidth().padding(vertical = 30.dp), Alignment.Center) {
                    CircularProgressIndicator(color = colors.accent)
                }

                list.isEmpty() -> Text(
                    "Nobody is banned.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = colors.textTertiary,
                    modifier = Modifier.padding(vertical = 20.dp),
                )

                else -> list.forEach { ban ->
                    Row(
                        Modifier.fillMaxWidth().padding(vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Avatar(ban.user.avatarUrl, ban.user.label, ban.user.id, size = 38.dp)
                        Spacer(Modifier.width(12.dp))
                        Column(Modifier.weight(1f)) {
                            Text(
                                ban.user.label,
                                style = MaterialTheme.typography.bodyLarge,
                                color = colors.textPrimary,
                            )
                            val detail = ban.reason?.takeIf { it.isNotBlank() }
                                ?: ban.createdAt?.let(::relativeTime)
                            detail?.let {
                                Text(
                                    it,
                                    style = MaterialTheme.typography.labelSmall,
                                    color = colors.textTertiary,
                                    maxLines = 1,
                                )
                            }
                        }
                        Text(
                            if (working.contains(ban.user.id)) "…" else "Unban",
                            style = MaterialTheme.typography.labelMedium,
                            color = colors.accent,
                            modifier = Modifier.softClickable(
                                enabled = !working.contains(ban.user.id),
                            ) {
                                working = working + ban.user.id
                                scope.launch {
                                    // Dropped from the list only once the server
                                    // agrees, so a failed call leaves the row
                                    // there to try again rather than pretending.
                                    if (runCatching { container.repo.unban(conversationId, ban.user.id) }
                                            .isSuccess
                                    ) {
                                        bans = bans?.filterNot { it.user.id == ban.user.id }
                                    }
                                    working = working - ban.user.id
                                }
                            },
                        )
                    }
                }
            }
        }
    }
}

// ── Invite links ─────────────────────────────────────────────────────────────

/**
 * Existing invite links, and the way to make or revoke one.
 *
 * The Android build could only ever create a single unlimited, never-expiring
 * link — the one shape you would not want for a link posted publicly. This
 * offers the limits the API has always accepted, and lets a link that has been
 * shared too widely be taken back.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun InviteManagerSheet(conversationId: String, onDismiss: () -> Unit) {
    val container = LocalContainer.current
    val colors = neuColors
    val scope = rememberCoroutineScope()
    val clipboard = androidx.compose.ui.platform.LocalClipboardManager.current

    var invites by remember { mutableStateOf<List<Invite>?>(null) }
    var maxUses by remember { mutableStateOf(0) }
    var expiresIn by remember { mutableStateOf<Int?>(null) }
    /** Roles new links can grant. Empty in a DM, where none exist. */
    var roles by remember { mutableStateOf<List<RoleEntry>>(emptyList()) }
    var grantRoleId by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }

    LaunchedEffect(conversationId) {
        invites = runCatching { container.repo.invites(conversationId).invites }.getOrDefault(emptyList())
        roles = runCatching { container.repo.roles(conversationId).roles }.getOrDefault(emptyList())
    }

    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = colors.surface,
        contentColor = colors.textPrimary,
    ) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 28.dp)) {
            Text("Invite links", style = MaterialTheme.typography.titleMedium, color = colors.textPrimary)
            Spacer(Modifier.padding(top = 14.dp))

            Text("Uses", style = MaterialTheme.typography.labelSmall, color = colors.textTertiary)
            Spacer(Modifier.padding(top = 6.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                NeuChip("Unlimited", maxUses == 0, onClick = { maxUses = 0 })
                NeuChip("1", maxUses == 1, onClick = { maxUses = 1 })
                NeuChip("10", maxUses == 10, onClick = { maxUses = 10 })
                NeuChip("50", maxUses == 50, onClick = { maxUses = 50 })
            }

            Spacer(Modifier.padding(top = 12.dp))
            Text("Expires", style = MaterialTheme.typography.labelSmall, color = colors.textTertiary)
            Spacer(Modifier.padding(top = 6.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                NeuChip("Never", expiresIn == null, onClick = { expiresIn = null })
                NeuChip("1 hour", expiresIn == 3_600, onClick = { expiresIn = 3_600 })
                NeuChip("1 day", expiresIn == 86_400, onClick = { expiresIn = 86_400 })
                NeuChip("7 days", expiresIn == 604_800, onClick = { expiresIn = 604_800 })
            }

            /*
             * What the next link hands out. One role per link, so "who did
             * this admit as what" stays answerable — a second role is a
             * second link.
             */
            if (roles.isNotEmpty()) {
                Spacer(Modifier.padding(top = 12.dp))
                Text("Grants", style = MaterialTheme.typography.labelSmall, color = colors.textTertiary)
                Spacer(Modifier.padding(top = 6.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    NeuChip("No role", grantRoleId == null, onClick = { grantRoleId = null })
                    roles.take(3).forEach { role ->
                        NeuChip(
                            role.name,
                            grantRoleId == role.id,
                            onClick = { grantRoleId = role.id },
                        )
                    }
                }
            }

            Spacer(Modifier.padding(top = 16.dp))
            NeuButton(
                onClick = {
                    if (busy) return@NeuButton
                    busy = true
                    scope.launch {
                        runCatching { container.repo.createInvite(conversationId, maxUses, expiresIn, roleId = grantRoleId) }
                            .getOrNull()
                            ?.let { created -> invites = listOf(created.invite) + invites.orEmpty() }
                        busy = false
                    }
                },
                accent = true,
                enabled = !busy,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(
                    if (busy) "Creating…" else "Create a link",
                    style = MaterialTheme.typography.labelLarge,
                    color = colors.onAccent,
                )
            }

            Spacer(Modifier.padding(top = 18.dp))

            val list = invites
            when {
                list == null -> Box(Modifier.fillMaxWidth().padding(vertical = 24.dp), Alignment.Center) {
                    CircularProgressIndicator(color = colors.accent)
                }

                list.isEmpty() -> Column(
                    Modifier.fillMaxWidth().padding(vertical = 20.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text("🔗", style = MaterialTheme.typography.headlineMedium)
                    Spacer(Modifier.padding(top = 8.dp))
                    Text(
                        "No invite links yet",
                        style = MaterialTheme.typography.titleSmall,
                        color = colors.textSecondary,
                    )
                    Text(
                        "Make one above and send it to whoever belongs here.",
                        style = MaterialTheme.typography.bodySmall,
                        color = colors.textTertiary,
                    )
                }

                else -> list.forEach { invite ->
                    Row(
                        Modifier.fillMaxWidth().padding(vertical = 9.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(
                            Modifier.weight(1f).softClickable {
                                clipboard.setText(androidx.compose.ui.text.AnnotatedString(invite.url))
                            },
                        ) {
                            Text(
                                invite.url,
                                style = MaterialTheme.typography.bodyMedium,
                                color = colors.textPrimary,
                                maxLines = 1,
                            )
                            Text(
                                buildString {
                                    append(
                                        if (invite.maxUses == 0) {
                                            (invite.role?.let { "grants ${it.name} · " } ?: "") +
                                                "${invite.uses} uses · unlimited"
                                        } else {
                                            (invite.role?.let { "grants ${it.name} · " } ?: "") +
                                                "${invite.uses}/${invite.maxUses} uses"
                                        },
                                    )
                                    invite.expiresAt?.let { append(" · expires ${relativeTime(it)}") }
                                },
                                style = MaterialTheme.typography.labelSmall,
                                color = colors.textTertiary,
                            )
                        }
                        Text(
                            "Revoke",
                            style = MaterialTheme.typography.labelMedium,
                            color = colors.danger,
                            modifier = Modifier.softClickable {
                                scope.launch {
                                    if (runCatching {
                                            container.repo.revokeInvite(conversationId, invite.code)
                                        }.isSuccess
                                    ) {
                                        invites = invites?.filterNot { it.code == invite.code }
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
