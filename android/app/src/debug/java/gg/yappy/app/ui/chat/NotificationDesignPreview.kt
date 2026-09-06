package gg.yappy.app.ui.chat

import android.app.Activity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import gg.yappy.app.data.NotificationEntry
import gg.yappy.app.ui.theme.ThemePreference
import gg.yappy.app.ui.theme.YappyTheme
import gg.yappy.app.ui.theme.neuColors
import java.time.Instant
import kotlinx.serialization.json.JsonPrimitive

@Preview(name = "Notifications · light", widthDp = 378, heightDp = 760)
@Composable
fun NotificationDesignLightPreview() = NotificationDesignPreview(ThemePreference.Light)

@Preview(name = "Notifications · dark", widthDp = 378, heightDp = 760)
@Composable
fun NotificationDesignDarkPreview() = NotificationDesignPreview(ThemePreference.Dark)

@Preview(name = "Notifications · large text", widthDp = 320, heightDp = 900)
@Composable
fun NotificationDesignLargeTextPreview() {
    CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, 1.5f)) {
        NotificationDesignPreview(ThemePreference.Light)
    }
}

@Composable
private fun NotificationDesignPreview(preference: ThemePreference) {
    val context = LocalContext.current
    YappyTheme(preference) {
        Column(
            Modifier
                .fillMaxSize()
                .background(neuColors.surface)
                .statusBarsPadding(),
        ) {
            InboxHeader(onBack = { (context as? Activity)?.finish() })
            val now = Instant.now().toString()
            val grant = NotificationEntry(
                id = "preview-verified",
                kind = "group_verified",
                targetType = "conversation",
                targetId = "preview-group",
                data = mapOf(
                    "title" to JsonPrimitive("revolving door"),
                    "badge" to JsonPrimitive("verified"),
                ),
                createdAt = now,
            )
            val samples = listOf(
                grant.copy(id = "preview-role", kind = "role_granted"),
                grant,
                NotificationEntry(
                    id = "preview-suspension", kind = "account_suspended", createdAt = now,
                    data = mapOf(
                        "title" to JsonPrimitive("Your account was suspended"),
                        "body" to JsonPrimitive("Repeated harassment after a warning."),
                        "until" to JsonPrimitive("2026-09-13T12:00:00.000Z"),
                        "detail" to JsonPrimitive("Suspended until Sun, 13 Sep 2026 12:00:00 GMT.\n\nWhile suspended, you cannot sign in or post. Your messages and groups have not been deleted.\n\nContact support if you believe this is a mistake."),
                    ),
                ),
                NotificationEntry(
                    id = "preview-sign-in", kind = "new_sign_in", createdAt = now,
                    data = mapOf(
                        "title" to JsonPrimitive("New sign-in to your account"),
                        "body" to JsonPrimitive("Signed in from iPhone. If this was you, no action is needed."),
                        "detail" to JsonPrimitive("If this was not you, change your password in Settings to sign out other devices."),
                    ),
                ),
                grant.copy(
                    id = "preview-read",
                    readAt = now,
                    createdAt = Instant.now().minusSeconds(7200).toString(),
                    data = mapOf(
                        "title" to JsonPrimitive("Pittsburgh / design community and creative friends"),
                        "badge" to JsonPrimitive("verified"),
                    ),
                ),
                grant.copy(
                    id = "preview-partner",
                    data = mapOf(
                        "title" to JsonPrimitive("Design partners"),
                        "badge" to JsonPrimitive("partner"),
                    ),
                ),
                grant.copy(id = "preview-revoked", kind = "group_verification_declined"),
                NotificationEntry(
                    id = "preview-restored", kind = "account_restored", createdAt = now,
                    data = mapOf(
                        "title" to JsonPrimitive("Your suspension was lifted"),
                        "body" to JsonPrimitive("You can sign in and use yappy again."),
                        "detail" to JsonPrimitive("Sign in again on each device. Sessions ended by the suspension stay signed out."),
                    ),
                ),
            )
            Column(
                Modifier.verticalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 6.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                samples.forEach { NoticeRow(it, onOpenGroup = {}, onOpenProfile = {}) }
            }
        }
    }
}
