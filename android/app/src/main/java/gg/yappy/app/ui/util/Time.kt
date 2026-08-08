package gg.yappy.app.ui.util

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit

private val timeFormat: DateTimeFormatter = DateTimeFormatter.ofPattern("HH:mm")
private val weekdayFormat: DateTimeFormatter = DateTimeFormatter.ofPattern("EEE")
private val dateFormat: DateTimeFormatter = DateTimeFormatter.ofPattern("d MMM")
private val fullDateFormat: DateTimeFormatter = DateTimeFormatter.ofPattern("d MMM yyyy")

private fun parse(iso: String?): Instant? =
    iso?.let { runCatching { Instant.parse(it) }.getOrNull() }

/**
 * Conversation-list timestamps.
 *
 * Deliberately coarse and absolute past today — "3d ago" makes people do
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
        then.toLocalDate() == now.toLocalDate() -> then.format(timeFormat)
        then.toLocalDate() == now.toLocalDate().minusDays(1) -> "Yesterday"
        ChronoUnit.DAYS.between(then, now) < 7 -> then.format(weekdayFormat)
        then.year == now.year -> then.format(dateFormat)
        else -> then.format(fullDateFormat)
    }
}

/** Clock time on a message bubble. */
fun clockTime(iso: String?): String =
    parse(iso)?.atZone(ZoneId.systemDefault())?.format(timeFormat).orEmpty()

/** Header for a day separator in the message list. */
fun dayLabel(iso: String?): String {
    val instant = parse(iso) ?: return ""
    val date = instant.atZone(ZoneId.systemDefault()).toLocalDate()
    val today = LocalDate.now()
    return when (date) {
        today -> "Today"
        today.minusDays(1) -> "Yesterday"
        else -> if (date.year == today.year) {
            date.format(DateTimeFormatter.ofPattern("EEEE, d MMM"))
        } else {
            date.format(DateTimeFormatter.ofPattern("d MMM yyyy"))
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
