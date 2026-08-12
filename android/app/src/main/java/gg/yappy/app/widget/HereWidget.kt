package gg.yappy.app.widget

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.provideContent
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.width
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import gg.yappy.app.MainActivity
import gg.yappy.app.YappyApplication
import gg.yappy.app.data.Conversation

/**
 * The homescreen answer to "is anything happening?"
 *
 * Groups with their live here-counts, on the phone itself. The whole product
 * argument is that a group is a place with people in it right now, and this
 * puts that on the launcher: "NARF · 2 here" without opening anything. An
 * unread-count widget would say what you owe; this says what you are missing.
 *
 * Data comes straight from the repo in [provideContent] — the widget runs in
 * the app's process, so the session, the client and the conversation cache are
 * all already here. Refreshed two ways: the 30-minute updatePeriodMillis floor
 * in here_widget_info.xml, and a live nudge from ConversationsViewModel every
 * time the list loads, which is what makes the widget agree with the app
 * whenever both are looked at in the same minute.
 *
 * Brand-fixed colours rather than Material You: the app's identity does not
 * recolour from the wallpaper, and neither does its widget.
 */
class HereWidget : GlanceAppWidget() {

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val container = (context.applicationContext as? YappyApplication)?.container
        val places = runCatching {
            container ?: return@runCatching emptyList()
            if (container.session.currentAccess() == null) return@runCatching emptyList()

            /**
             * The disk snapshot first, the network only as a last resort.
             *
             * The widget's freshest trigger is ConversationsViewModel nudging
             * updateAll() right after the list loads — at which moment the
             * response is already sitting in the cache. Fetching here again
             * meant every open of the app cost a second, redundant request
             * purely to redraw a widget with the data the app just displayed.
             * The 30-minute period tick takes the cached copy too; presence
             * counts a half hour stale are what updatePeriodMillis means.
             */
            val cached = gg.yappy.app.data.DiskCache
                .decode<gg.yappy.app.data.ConversationsEnvelope>("conversations")
                ?.conversations
            (cached ?: container.repo.conversations().conversations)
                .filterNot { it.type == "dm" }
                .sortedByDescending { it.hereCount }
                .take(5)
        }.getOrDefault(emptyList())

        provideContent { WidgetBody(context, places) }
    }

    @Composable
    private fun WidgetBody(context: Context, places: List<Conversation>) {
        Column(
            modifier = GlanceModifier
                .fillMaxSize()
                .background(ColorProvider(SURFACE))
                .cornerRadius(22.dp)
                .padding(14.dp),
        ) {
            Text(
                "who's here",
                style = TextStyle(
                    color = ColorProvider(ACCENT),
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Bold,
                ),
            )
            Spacer(GlanceModifier.height(8.dp))

            if (places.isEmpty()) {
                Text(
                    "No places yet — open yappy",
                    style = TextStyle(color = ColorProvider(TEXT_DIM), fontSize = 13.sp),
                    modifier = GlanceModifier.clickable(
                        actionStartActivity(Intent(context, MainActivity::class.java)),
                    ),
                )
            } else {
                places.forEach { place ->
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = GlanceModifier
                            .fillMaxWidth()
                            .padding(vertical = 5.dp)
                            .clickable(openChat(context, place.id)),
                    ) {
                        Text(
                            place.title ?: "Group",
                            style = TextStyle(
                                color = ColorProvider(TEXT),
                                fontSize = 14.sp,
                                fontWeight = FontWeight.Medium,
                            ),
                            maxLines = 1,
                            modifier = GlanceModifier.defaultWeight(),
                        )
                        Spacer(GlanceModifier.width(8.dp))
                        Text(
                            if (place.hereCount > 0) "${place.hereCount} here" else "quiet",
                            style = TextStyle(
                                color = ColorProvider(if (place.hereCount > 0) HERE else TEXT_DIM),
                                fontSize = 12.sp,
                                fontWeight = if (place.hereCount > 0) FontWeight.Bold else FontWeight.Normal,
                            ),
                        )
                    }
                }
            }
        }
    }

    private fun openChat(context: Context, conversationId: String) = actionStartActivity(
        Intent(Intent.ACTION_VIEW, Uri.parse("yappy://conversation/$conversationId"))
            .setClass(context, MainActivity::class.java),
    )

    companion object {
        // The dark violet-charcoal surface and palette the app uses, fixed.
        private val SURFACE = Color(0xFF201D2B)
        private val TEXT = Color(0xFFF2F0F8)
        private val TEXT_DIM = Color(0xFF726C8C)
        private val ACCENT = Color(0xFF8B7CFF)
        private val HERE = Color(0xFF00CEC9)
    }
}

class HereWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = HereWidget()
}
