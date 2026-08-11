import Foundation

/// Timestamp formatting.
///
/// Formatters are expensive to build and are reused rather than constructed per
/// row — a conversation list makes one call per visible cell on every state
/// change, and allocating a `DateFormatter` each time is measurable.
enum YappyTime {
    /// The API sends RFC 3339 with fractional seconds on some fields and without
    /// on others, and `ISO8601DateFormatter` matches only the format it was
    /// configured for. Both are tried rather than assuming.
    private static let isoWithFraction: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let iso: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    private static let clock: DateFormatter = {
        let formatter = DateFormatter()
        // Locale-aware rather than a hard "HH:mm": on a device set to a 12-hour
        // clock, 24-hour times in the bubbles look like a bug.
        formatter.setLocalizedDateFormatFromTemplate("j:mm")
        return formatter
    }()

    private static let weekday: DateFormatter = {
        let formatter = DateFormatter()
        formatter.setLocalizedDateFormatFromTemplate("EEE")
        return formatter
    }()

    private static let shortDate: DateFormatter = {
        let formatter = DateFormatter()
        formatter.setLocalizedDateFormatFromTemplate("d MMM")
        return formatter
    }()

    private static let fullDate: DateFormatter = {
        let formatter = DateFormatter()
        formatter.setLocalizedDateFormatFromTemplate("d MMM yyyy")
        return formatter
    }()

    private static let dayHeader: DateFormatter = {
        let formatter = DateFormatter()
        formatter.setLocalizedDateFormatFromTemplate("EEEE d MMM")
        return formatter
    }()

    static func parse(_ iso8601: String?) -> Date? {
        guard let iso8601, !iso8601.isEmpty else { return nil }
        return isoWithFraction.date(from: iso8601) ?? iso.date(from: iso8601)
    }

    static func now() -> String { isoWithFraction.string(from: Date()) }

    /// A specific instant, for a request body. `now()` is this with `Date()`.
    static func string(from date: Date) -> String { isoWithFraction.string(from: date) }

    /// Conversation-list timestamps.
    ///
    /// Deliberately coarse and absolute past today — "3d ago" makes people do
    /// arithmetic, while "Tue" and "14 Jan" are read at a glance. Only the last
    /// hour gets relative treatment, where it genuinely is the more useful
    /// framing.
    static func relative(_ iso8601: String?) -> String {
        guard let date = parse(iso8601) else { return "" }
        let calendar = Calendar.current
        let now = Date()

        let minutes = Int(now.timeIntervalSince(date) / 60)
        if minutes < 1 { return "now" }
        if minutes < 60 { return "\(minutes)m" }
        if calendar.isDateInToday(date) { return clock.string(from: date) }
        if calendar.isDateInYesterday(date) { return "Yesterday" }

        let days = calendar.dateComponents([.day], from: date, to: now).day ?? 0
        if days < 7 { return weekday.string(from: date) }
        if calendar.component(.year, from: date) == calendar.component(.year, from: now) {
            return shortDate.string(from: date)
        }
        return fullDate.string(from: date)
    }

    /// Clock time on a message bubble.
    static func clockTime(_ iso8601: String?) -> String {
        guard let date = parse(iso8601) else { return "" }
        return clock.string(from: date)
    }

    /// Header for a day separator in the message list.
    static func dayLabel(_ iso8601: String?) -> String {
        guard let date = parse(iso8601) else { return "" }
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return "Today" }
        if calendar.isDateInYesterday(date) { return "Yesterday" }
        if calendar.component(.year, from: date) == calendar.component(.year, from: Date()) {
            return dayHeader.string(from: date)
        }
        return fullDate.string(from: date)
    }

    /// True when two messages fall on different calendar days in the local zone.
    static func crossesDay(_ previous: String?, _ current: String?) -> Bool {
        guard let currentDate = parse(current) else { return false }
        guard let previousDate = parse(previous) else { return true }
        return !Calendar.current.isDate(previousDate, inSameDayAs: currentDate)
    }

    static func duration(_ seconds: Int) -> String {
        let minutes = seconds / 60
        let secs = seconds % 60
        if minutes >= 60 {
            return String(format: "%d:%02d:%02d", minutes / 60, minutes % 60, secs)
        }
        return String(format: "%d:%02d", minutes, secs)
    }
}
