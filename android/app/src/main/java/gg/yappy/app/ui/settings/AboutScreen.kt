package gg.yappy.app.ui.settings

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.OpenInNew
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.ContentCopy
import androidx.compose.material.icons.rounded.Info
import androidx.compose.material.icons.rounded.NewReleases
import androidx.compose.material.icons.rounded.Warning
import androidx.compose.material3.ExperimentalMaterial3Api
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
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import gg.yappy.app.BuildConfig
import gg.yappy.app.LocalContainer
import gg.yappy.app.data.ReleaseNote
import gg.yappy.app.data.VersionInfo
import gg.yappy.app.ui.components.LogoMark
import gg.yappy.app.ui.components.NeuIconButton
import gg.yappy.app.ui.components.NeuSurface
import gg.yappy.app.ui.components.SectionLabel
import gg.yappy.app.ui.components.softClickable
import gg.yappy.app.ui.theme.Neu
import gg.yappy.app.ui.theme.neuColors

/**
 * About: what this build is, what the server is, and whether they agree.
 *
 * Exists mostly for support. "What version are you on?" is the first question
 * of every bug report, and an answer someone can read off the screen and copy
 * is worth more than one they have to go find in the Play Store.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AboutScreen(onBack: () -> Unit) {
    val container = LocalContainer.current
    val colors = neuColors
    val context = LocalContext.current
    val clipboard = LocalClipboardManager.current

    var info by remember { mutableStateOf<VersionInfo?>(null) }
    /** Distinguishes "still loading" from "asked and could not reach it". */
    var checked by remember { mutableStateOf(false) }
    /** Null while loading, empty when the server has nothing to show. */
    var notes by remember { mutableStateOf<List<ReleaseNote>?>(null) }
    var notesOpen by remember { mutableStateOf(false) }
    var copied by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        // Both are optional extras: About must still render every local fact
        // when the network is down, which is often exactly when someone is
        // reading it.
        info = runCatching { container.repo.version(BuildConfig.VERSION_NAME) }.getOrNull()
        checked = true
        notes = runCatching { container.repo.changelog().notes }.getOrDefault(emptyList())
    }

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
            Spacer(Modifier.width(12.dp))
            Text("About", style = MaterialTheme.typography.headlineSmall, color = colors.textPrimary)
        }

        Column(
            Modifier.fillMaxWidth().padding(top = 12.dp, bottom = 22.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            LogoMark(height = 44.dp)
            Text("yappy", style = MaterialTheme.typography.headlineSmall, color = colors.textPrimary)
            Text(
                "Version ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})",
                style = MaterialTheme.typography.bodyMedium,
                color = colors.textTertiary,
            )
        }

        // One line that answers "am I on the latest?" without making anyone
        // compare two version strings themselves.
        val status = when {
            !checked -> Triple(Icons.Rounded.Info, colors.textTertiary, "Checking…")
            info == null -> Triple(
                Icons.Rounded.Warning,
                colors.warning,
                "Could not reach the server",
            )
            info?.updateRequired == true -> Triple(
                Icons.Rounded.NewReleases,
                colors.danger,
                "This version is no longer supported — update to keep using yappy",
            )
            info?.updateAvailable == true -> Triple(
                Icons.Rounded.NewReleases,
                colors.accent,
                "Version ${info?.latest} is available",
            )
            else -> Triple(Icons.Rounded.CheckCircle, colors.success, "You're up to date")
        }

        NeuSurface(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp),
            shape = RoundedCornerShape(Neu.CornerMedium),
            contentPadding = 14.dp,
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(status.first, null, tint = status.second, modifier = Modifier.size(22.dp))
                Spacer(Modifier.width(12.dp))
                Text(status.third, style = MaterialTheme.typography.bodyMedium, color = colors.textPrimary)
            }
        }

        Spacer(Modifier.height(24.dp))
        SectionLabel("Details", Modifier.padding(horizontal = 22.dp))

        NeuSurface(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp),
            shape = RoundedCornerShape(Neu.CornerMedium),
            contentPadding = 12.dp,
        ) {
            Column {
                DetailRow("App version", "${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})")
                DetailRow("API", info?.api ?: "—")
                DetailRow("Minimum supported", info?.minimum ?: "—")
                DetailRow("Device", "${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL}")
                DetailRow("Android", android.os.Build.VERSION.RELEASE)

                // The whole block, in one tap. A support conversation goes much
                // better when someone can paste this than when they read six
                // numbers out one at a time.
                Row(
                    Modifier
                        .fillMaxWidth()
                        .softClickable {
                            clipboard.setText(
                                AnnotatedString(
                                    buildString {
                                        appendLine("yappy ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})")
                                        appendLine("api ${info?.api ?: "unknown"}")
                                        appendLine(
                                            "device ${android.os.Build.MANUFACTURER} " +
                                                "${android.os.Build.MODEL}, Android " +
                                                android.os.Build.VERSION.RELEASE,
                                        )
                                    },
                                ),
                            )
                            copied = true
                        }
                        .padding(vertical = 12.dp, horizontal = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        Icons.Rounded.ContentCopy,
                        null,
                        tint = if (copied) colors.success else colors.textSecondary,
                        modifier = Modifier.size(18.dp),
                    )
                    Spacer(Modifier.width(14.dp))
                    Text(
                        if (copied) "Copied" else "Copy this for support",
                        style = MaterialTheme.typography.bodyLarge,
                        color = if (copied) colors.success else colors.textPrimary,
                    )
                }
            }
        }

        Spacer(Modifier.height(24.dp))
        SectionLabel("More", Modifier.padding(horizontal = 22.dp))

        NeuSurface(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp),
            shape = RoundedCornerShape(Neu.CornerMedium),
            contentPadding = 12.dp,
        ) {
            Column {
                LinkRow(Icons.Rounded.NewReleases, "What's new") { notesOpen = true }
                LinkRow(Icons.AutoMirrored.Rounded.OpenInNew, "Privacy policy") {
                    open(context, "${BuildConfig.WEB_URL}/privacy")
                }
                LinkRow(Icons.AutoMirrored.Rounded.OpenInNew, "Terms of service") {
                    open(context, "${BuildConfig.WEB_URL}/terms")
                }
                LinkRow(Icons.AutoMirrored.Rounded.OpenInNew, "Support") {
                    open(context, "${BuildConfig.WEB_URL}/support")
                }
            }
        }

        // The page scrolls under the transparent navigation bar; the last
        // card stops above it. The bar's height is whatever this phone's
        // is — 3-button or gesture — rather than a guess.
        Spacer(Modifier.navigationBarsPadding().height(24.dp))
    }

    if (notesOpen) {
        val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
        ModalBottomSheet(
            onDismissRequest = { notesOpen = false },
            sheetState = sheetState,
            containerColor = colors.surface,
            contentColor = colors.textPrimary,
        ) {
            val list = notes.orEmpty()
            if (list.isEmpty()) {
                Text(
                    "No release notes yet.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = colors.textTertiary,
                    modifier = Modifier.padding(24.dp),
                )
            } else {
                // Opening it from here must not consume the pending flag —
                // reading the notes on purpose is not the same as being shown
                // them, and the launch sheet still owes the user its turn.
                WhatsNewSheet(list, onClose = { notesOpen = false })
            }
        }
    }
}

@Composable
private fun DetailRow(label: String, value: String) {
    val colors = neuColors
    Row(
        Modifier.fillMaxWidth().padding(vertical = 9.dp, horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = MaterialTheme.typography.bodyMedium, color = colors.textSecondary)
        Spacer(Modifier.weight(1f))
        Text(
            value,
            style = MaterialTheme.typography.labelMedium,
            color = colors.textTertiary,
        )
    }
}

@Composable
private fun LinkRow(icon: ImageVector, title: String, onClick: () -> Unit) {
    val colors = neuColors
    Row(
        Modifier
            .fillMaxWidth()
            .softClickable(onClick = onClick)
            .padding(vertical = 13.dp, horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, tint = colors.textSecondary, modifier = Modifier.size(19.dp))
        Spacer(Modifier.width(14.dp))
        Text(title, style = MaterialTheme.typography.bodyLarge, color = colors.textPrimary)
    }
}

private fun open(context: android.content.Context, url: String) {
    runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
}
