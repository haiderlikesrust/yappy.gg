package gg.yappy.app.ui.group

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
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
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material3.Icon
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import gg.yappy.app.AppContainer
import gg.yappy.app.data.ApiException
import gg.yappy.app.data.CustomEmoji
import gg.yappy.app.ui.components.NeuTextField
import gg.yappy.app.ui.components.SectionLabel
import gg.yappy.app.ui.components.softClickable
import gg.yappy.app.ui.theme.Neu
import gg.yappy.app.ui.theme.neuColors
import kotlinx.coroutines.launch

/**
 * A group's own emoji: everyone browses, MANAGE_STICKERS curates.
 *
 * The phones could use these — a `:party_parrot:` typed here has rendered as a
 * picture since the entity landed — but there was no way to *make* one without
 * opening the web app, which is a strange thing to require of a feature whose
 * whole point is that a group has its own voice.
 *
 * Name and picture are taken together rather than in two steps. The server
 * insists on both anyway, and a half-made emoji sitting in the list waiting
 * for a name is a state worth not having.
 */
@Composable
fun EmojiSection(
    container: AppContainer,
    conversationId: String,
    canManage: Boolean,
) {
    val colors = neuColors
    val scope = rememberCoroutineScope()

    var emojis by remember(conversationId) { mutableStateOf<List<CustomEmoji>>(emptyList()) }
    var name by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var refresh by remember { mutableStateOf(0) }

    LaunchedEffect(conversationId, refresh) {
        runCatching { container.repo.customEmojis(conversationId).emojis }
            .getOrNull()
            ?.let { emojis = it }
    }

    /*
     * The picture is chosen last, so the launcher closes over the name that was
     * typed. Picking first and then asking for a name means an upload that has
     * already happened when somebody changes their mind.
     */
    val pick = rememberLauncherForActivityResult(
        ActivityResultContracts.PickVisualMedia(),
    ) { uri ->
        val wanted = name.trim().lowercase()
        if (uri == null || wanted.isEmpty()) return@rememberLauncherForActivityResult
        scope.launch {
            busy = true
            error = null
            runCatching {
                val up = container.uploader.upload(uri, purpose = "emoji")
                container.repo.createCustomEmoji(conversationId, wanted, up.mediaId)
            }.onSuccess {
                name = ""
                refresh++
            }.onFailure {
                // Surfaced rather than swallowed: the name rules are strict
                // (lowercase, 2–32, no spaces) and a silent no-op teaches
                // nobody what went wrong.
                error = (it as? ApiException)?.message ?: "Could not add that emoji"
            }
            busy = false
        }
    }

    if (emojis.isEmpty() && !canManage) return

    Spacer(Modifier.height(18.dp))
    SectionLabel("Emoji", Modifier.padding(start = 24.dp))
    Spacer(Modifier.height(8.dp))

    if (emojis.isNotEmpty()) {
        LazyRow(
            Modifier.fillMaxWidth(),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 20.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            items(emojis.size, key = { emojis[it].id }) { index ->
                val emoji = emojis[index]
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Box(contentAlignment = Alignment.TopEnd) {
                        AsyncImage(
                            model = emoji.url,
                            contentDescription = ":" + emoji.name + ":",
                            modifier = Modifier.size(44.dp),
                        )
                        if (canManage) {
                            Box(
                                Modifier
                                    .size(18.dp)
                                    .clip(CircleShape)
                                    .background(colors.veil)
                                    .softClickable {
                                        scope.launch {
                                            runCatching {
                                                container.repo.deleteCustomEmoji(conversationId, emoji.id)
                                            }
                                            refresh++
                                        }
                                    },
                                contentAlignment = Alignment.Center,
                            ) {
                                Icon(
                                    Icons.Rounded.Close,
                                    "Remove :" + emoji.name + ":",
                                    tint = colors.textSecondary,
                                    modifier = Modifier.size(11.dp),
                                )
                            }
                        }
                    }
                    Spacer(Modifier.height(3.dp))
                    Text(
                        ":" + emoji.name + ":",
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.textTertiary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.width(60.dp),
                    )
                }
            }
        }
        Spacer(Modifier.height(10.dp))
    }

    if (!canManage) return

    error?.let {
        Text(
            it,
            style = MaterialTheme.typography.bodyMedium,
            color = colors.danger,
            modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp),
        )
    }

    Row(
        Modifier.fillMaxWidth().padding(horizontal = 20.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        NeuTextField(
            value = name,
            onValueChange = { name = it },
            placeholder = "name (a–z, 0–9, _)",
            modifier = Modifier.weight(1f),
        )
        Spacer(Modifier.width(8.dp))
        Row(
            Modifier
                .clip(RoundedCornerShape(Neu.CornerSmall))
                .softClickable(enabled = name.isNotBlank() && !busy) {
                    pick.launch(
                        PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly),
                    )
                }
                .padding(horizontal = 10.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                Icons.Rounded.Add,
                null,
                tint = if (name.isBlank()) colors.textTertiary else colors.accent,
                modifier = Modifier.size(16.dp),
            )
            Spacer(Modifier.width(5.dp))
            Text(
                if (busy) "Adding…" else "Picture",
                style = MaterialTheme.typography.labelLarge,
                color = if (name.isBlank()) colors.textTertiary else colors.accent,
            )
        }
    }
    Text(
        "Up to 50 per group, 512 KB each.",
        style = MaterialTheme.typography.labelSmall,
        color = colors.textTertiary,
        modifier = Modifier.padding(horizontal = 20.dp, vertical = 6.dp),
    )
}
