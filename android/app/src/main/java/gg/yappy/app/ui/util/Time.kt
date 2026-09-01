package gg.yappy.app.ui.util

import android.content.Context
import android.text.format.DateFormat
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import java.util.Locale

/**
 * Whether to write clock times as 14:05 or 2:05 PM.
 *
 * This was hardcoded to 24-hour, so a phone set to 12-hour showed `00:51` on a
 * message sent at the moment its own status bar read `12:51`. Nothing else in
 * the app disagrees with the system like that, and it is the sort of detail
 * that makes software feel like it was built somewhere else.
 *
 * Held as a flag rather than resolved per call because these formatters are hit
 * once per visible bubble on every recomposition, and `is24HourFormat` goes to
 * a content provider. Refreshed when the activity resumes, which covers the
 * only realistic path: leaving to change it in system settings and coming back.
 */
object ClockStyle {
    @Volatile
    private var use24 = true

    fun refresh(context: Context) {
        use24 = DateFormat.is24HourFormat(context)
    }

    val time: DateTimeFormatter
        get() = if (use24) time24 else time12
}

private val time24: DateTimeFormatter = DateTimeFormatter.ofPattern("HH:mm", Locale.getDefault())
private val time12: DateTimeFormatter = DateTimeFormatter.ofPattern("h:mm a", Locale.getDefault())
private val weekdayFormat: DateTimeFormatter = DateTimeFormatter.ofPattern("EEE", Locale.getDefault())
private val dateFormat: DateTimeFormatter = DateTimeFormatter.ofPattern("d MMM", Locale.getDefault())
private val fullDateFormat: DateTimeFormatter =
    DateTimeFormatter.ofPattern("d MMM yyyy", Locale.getDefault())

private fun parse(iso: String?): Instant? =
    iso?.let { runCatching { Instant.parse(it) }.getOrNull() }

/**
 * Conversation-list timestamps.
 *
 * Deliberately coarse and absolute past today: "3d ago" makes people do
 * arithmetic, while "Tue" and "14 Jan" are read at a glance. Only the last hour
 * gets relative treatment, where it genuinely is the more useful framing.
 */
fun relativeTime(iso: String?): String {
    val instant = parse(iso) ?: return ""
    val zone = ZoneId.systemDefault()
    val then = instant.atZone(zone)
    val now = Instant.now().atZone(zone)

    val minutes = ChronoUnit.MINUTES.between(then, now)
    return when {
        minutes < 1 -> "now"
        minutes < 60 -> "${minutes}m"
        then.toLocalDate() == now.toLocalDate() -> then.format(ClockStyle.time)
        then.toLocalDate() == now.toLocalDate().minusDays(1) -> "Yesterday"
        ChronoUnit.DAYS.between(then, now) < 7 -> then.format(weekdayFormat)
        then.year == now.year -> then.format(dateFormat)
        else -> then.format(fullDateFormat)
    }
}

/** Clock time on a message bubble. */
fun clockTime(iso: String?): String =
    parse(iso)?.atZone(ZoneId.systemDefault())?.format(ClockStyle.time).orEmpty()

// Built once like every other formatter in this file — `ofPattern` compiles
// the pattern, and this ran per day-separator per recomposition of the list.
private val SameYearDay = DateTimeFormatter.ofPattern("EEEE, d MMM")
private val OtherYearDay = DateTimeFormatter.ofPattern("d MMM yyyy")

/** Header for a day separator in the message list. */
fun dayLabel(iso: String?): String {
    val instant = parse(iso) ?: return ""
    val date = instant.atZone(ZoneId.systemDefault()).toLocalDate()
    val today = LocalDate.now()
    return when (date) {
        today -> "Today"
        today.minusDays(1) -> "Yesterday"
        else -> if (date.year == today.year) {
            date.format(SameYearDay)
        } else {
            date.format(OtherYearDay)
        }
    }
}

/** True when two messages fall on different calendar days in the local zone. */
fun crossesDay(previous: String?, current: String?): Boolean {
    val a = parse(previous)?.atZone(ZoneId.systemDefault())?.toLocalDate()
    val b = parse(current)?.atZone(ZoneId.systemDefault())?.toLocalDate() ?: return false
    return a != b
}

fun formatDuration(seconds: Int): String {
    val m = seconds / 60
    val s = seconds % 60
    return if (m >= 60) "%d:%02d:%02d".format(m / 60, m % 60, s) else "%d:%02d".format(m, s)
}
