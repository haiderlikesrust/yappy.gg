package gg.yappy.app.ui.invite

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
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
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import gg.yappy.app.LocalContainer
import gg.yappy.app.data.ApiException
import gg.yappy.app.data.InvitePreview
import gg.yappy.app.ui.components.Avatar
import gg.yappy.app.ui.components.NeuButton
import gg.yappy.app.ui.theme.PlaceShape
import gg.yappy.app.ui.theme.neuColors
import kotlinx.coroutines.launch

/**
 * What an invite link opens.
 *
 * A preview and a button, never a silent join: following a link should show you
 * whose room it is and let you back out. Mirrors the iOS sheet of the same name.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun InviteSheet(
    code: String,
    onJoined: (conversationId: String, isSpace: Boolean) -> Unit,
    onDismiss: () -> Unit,
) {
    val container = LocalContainer.current
    val colors = neuColors
    val scope = rememberCoroutineScope()
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    var preview by remember { mutableStateOf<InvitePreview?>(null) }
    var failure by remember { mutableStateOf<String?>(null) }
    var joining by remember { mutableStateOf(false) }

    LaunchedEffect(code) {
        runCatching { container.repo.invitePreview(code) }
            .onSuccess { preview = it }
            .onFailure { err ->
                failure = when {
                    err is ApiException && err.status == 404 ->
                        "That invite has expired or been revoked."
                    err is ApiException -> err.message
                    else -> "Could not open that invite."
                }
            }
    }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = colors.surface,
        contentColor = colors.textPrimary,
    ) {
        Column(
            Modifier.fillMaxWidth().padding(horizontal = 24.dp).padding(bottom = 30.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            val target = preview?.conversation

            when {
                target != null -> {
                    Avatar(
                        url = target.avatarUrl,
                        name = target.title,
                        id = target.id,
                        size = 88.dp,
                        // A squircle, because this is a place.
                        shape = PlaceShape,
                    )
                    Spacer(Modifier.height(16.dp))

                    Text(
                        target.title ?: "A group",
                        style = MaterialTheme.typography.titleLarge,
                        color = colors.textPrimary,
                        textAlign = TextAlign.Center,
                    )

                    Text(
                        buildString {
                            append(target.memberCount)
                            append(if (target.memberCount == 1) " member" else " members")
                            preview?.usesRemaining?.let {
                                append(" · ")
                                append(it)
                                append(if (it == 1) " use left" else " uses left")
                            }
                        },
                        style = MaterialTheme.typography.labelMedium,
                        color = colors.textTertiary,
                        modifier = Modifier.padding(top = 4.dp),
                    )

                    if (!target.description.isNullOrBlank()) {
                        Text(
                            target.description,
                            style = MaterialTheme.typography.bodyMedium,
                            color = colors.textSecondary,
                            textAlign = TextAlign.Center,
                            modifier = Modifier.padding(top = 12.dp),
                        )
                    }

                    // A join that failed shows here rather than replacing the
                    // card: the group is still the thing being looked at, and
                    // the button is still worth another press.
                    failure?.let {
                        Text(
                            it,
                            style = MaterialTheme.typography.labelMedium,
                            color = colors.danger,
                            textAlign = TextAlign.Center,
                            modifier = Modifier.padding(top = 12.dp),
                        )
                    }

                    Row(
                        Modifier.fillMaxWidth().padding(top = 24.dp),
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        NeuButton(onClick = onDismiss, modifier = Modifier.weight(1f)) {
                            Text(
                                "Not now",
                                style = MaterialTheme.typography.labelLarge,
                                color = colors.textSecondary,
                            )
                        }
                        NeuButton(
                            onClick = {
                                if (joining) return@NeuButton
                                joining = true
                                failure = null
                                scope.launch {
                                    runCatching { container.repo.joinInvite(code) }
                                        .onSuccess {
                                            onJoined(it.conversation.id, it.conversation.type == "space")
                                        }
                                        .onFailure { err ->
                                            failure = (err as? ApiException)?.message
                                                ?: "Could not join. Try again."
                                        }
                                    joining = false
                                }
                            },
                            enabled = !joining,
                            accent = true,
                            modifier = Modifier.weight(1f),
                        ) {
                            if (joining) {
                                CircularProgressIndicator(
                                    color = colors.onAccent,
                                    strokeWidth = 2.dp,
                                    modifier = Modifier.size(18.dp),
                                )
                            } else {
                                Text(
                                    "Join",
                                    style = MaterialTheme.typography.labelLarge,
                                    color = colors.onAccent,
                                )
                            }
                        }
                    }
                }

                // Nothing to preview and a reason why: a dead invite, or a
                // network that would not answer.
                failure != null -> {
                    Text(
                        failure!!,
                        style = MaterialTheme.typography.bodyMedium,
                        color = colors.textSecondary,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.padding(vertical = 20.dp),
                    )
                    NeuButton(onClick = onDismiss, modifier = Modifier.fillMaxWidth()) {
                        Text(
                            "Close",
                            style = MaterialTheme.typography.labelLarge,
                            color = colors.textSecondary,
                        )
                    }
                }

                else -> Box(
                    Modifier.fillMaxWidth().padding(PaddingValues(vertical = 60.dp)),
                    contentAlignment = Alignment.Center,
                ) {
                    CircularProgressIndicator(color = colors.accent)
                }
            }
        }
    }
}
