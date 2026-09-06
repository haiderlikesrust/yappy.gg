package gg.yappy.app.ui.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.ChevronRight
import androidx.compose.material.icons.rounded.Devices
import androidx.compose.material.icons.rounded.HelpOutline
import androidx.compose.material.icons.rounded.Info
import androidx.compose.material.icons.rounded.Lock
import androidx.compose.material.icons.rounded.Notifications
import androidx.compose.material.icons.rounded.Palette
import androidx.compose.material.icons.rounded.PersonOutline
import androidx.compose.material.icons.rounded.Storage
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import gg.yappy.app.ui.components.Avatar
import gg.yappy.app.ui.components.NeuSurface
import gg.yappy.app.ui.components.softClickable
import gg.yappy.app.ui.theme.neuColors

internal enum class SettingsPage(val title: String, val icon: ImageVector) {
    Overview("Settings", Icons.Rounded.PersonOutline),
    Account("Account", Icons.Rounded.PersonOutline),
    Privacy("Privacy & safety", Icons.Rounded.Lock),
    Notifications("Notifications", Icons.Rounded.Notifications),
    Appearance("Appearance", Icons.Rounded.Palette),
    Storage("Storage", Icons.Rounded.Storage),
    Devices("Devices", Icons.Rounded.Devices),
}

@Composable
internal fun SettingsOverview(
    name: String,
    username: String?,
    avatarUrl: String?,
    userId: String,
    themeLabel: String,
    notificationsLabel: String,
    storageLabel: String,
    devicesLabel: String,
    onPage: (SettingsPage) -> Unit,
    onProfile: () -> Unit,
    onHelp: () -> Unit,
    onAbout: () -> Unit,
) {
    val colors = neuColors
    Column(Modifier.padding(horizontal = 16.dp)) {
        NeuSurface(onClick = onProfile, modifier = Modifier.fillMaxWidth(), contentPadding = 16.dp) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                Avatar(avatarUrl, name, userId, size = 52.dp)
                Column(Modifier.weight(1f)) {
                    Text(name, style = MaterialTheme.typography.titleMedium, color = colors.textPrimary)
                    Text(username?.let { "@$it · View profile" } ?: "View profile",
                        style = MaterialTheme.typography.bodyMedium, color = colors.textSecondary)
                }
                Icon(Icons.Rounded.ChevronRight, null, tint = colors.textTertiary, modifier = Modifier.size(20.dp))
            }
        }
        Spacer(Modifier.height(16.dp))
        NeuSurface(modifier = Modifier.fillMaxWidth(), contentPadding = 4.dp) {
            Column {
                SettingsPage.entries.filter { it != SettingsPage.Overview }.forEach { page ->
                    OverviewRow(page.icon, page.title, when (page) {
                        SettingsPage.Account -> "Profile, username and password"
                        SettingsPage.Privacy -> "Who can reach you and what you share"
                        SettingsPage.Notifications -> notificationsLabel
                        SettingsPage.Appearance -> themeLabel
                        SettingsPage.Storage -> storageLabel
                        SettingsPage.Devices -> devicesLabel
                        SettingsPage.Overview -> ""
                    }) { onPage(page) }
                }
            }
        }
        Spacer(Modifier.height(12.dp))
        OverviewRow(Icons.Rounded.HelpOutline, "Help & Support", "Get help or appeal a suspension", onHelp)
        OverviewRow(Icons.Rounded.Info, "About yappy", null, onAbout)
    }
}

@Composable
private fun OverviewRow(icon: ImageVector, title: String, subtitle: String?, onClick: () -> Unit) {
    val colors = neuColors
    Row(
        Modifier.fillMaxWidth().heightIn(min = 56.dp).softClickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Icon(icon, null, tint = colors.textSecondary, modifier = Modifier.size(22.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(title, style = MaterialTheme.typography.titleSmall, color = colors.textPrimary)
            if (subtitle != null) Text(subtitle, style = MaterialTheme.typography.bodyMedium, color = colors.textSecondary)
        }
        Icon(Icons.Rounded.ChevronRight, null, tint = colors.textTertiary, modifier = Modifier.size(20.dp))
    }
}
