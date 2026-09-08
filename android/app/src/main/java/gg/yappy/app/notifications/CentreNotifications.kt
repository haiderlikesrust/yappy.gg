package gg.yappy.app.notifications

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import gg.yappy.app.MainActivity
import gg.yappy.app.R

/** Server notices are data-only pushes too, but are not replyable messages. */
object CentreNotifications {
    fun show(context: Context, data: Map<String, String>) {
        val id = data["notificationId"] ?: return
        val open = PendingIntent.getActivity(
            context, 0,
            Intent(Intent.ACTION_VIEW, Uri.parse("yappy://inbox"), context, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(context, data["channel"] ?: "messages")
            .setSmallIcon(R.drawable.logo_mark)
            .setContentTitle(data["title"] ?: "yappy")
            .setContentText(data["body"] ?: "You have a new notification")
            .setStyle(NotificationCompat.BigTextStyle().bigText(data["body"]))
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        runCatching { NotificationManagerCompat.from(context).notify("notice:$id", 0, notification) }
    }
}
