import Foundation

/// The container the app, the notification service extension and the widget
/// all share.
///
/// Three processes hold pieces of yappy now, and an app extension is not the
/// app: it gets its own sandbox, its own container, and it cannot see a single
/// byte the app has written unless that byte is in here.
///
/// Deliberately tiny, and deliberately shared source rather than the same
/// string typed into three targets — the group identifier is one of those
/// constants where a typo produces no error at all, just a `nil` container and
/// a widget that is permanently empty for reasons nothing reports.
enum AppGroup {
    /// Must match the App Group in the Developer portal, and the
    /// `com.apple.security.application-groups` entitlement on all three
    /// targets. Provisioning fails to sign if the portal does not have it.
    static let identifier = "group.gg.yappy.app"

    /// `nil` when the entitlement is missing — an ad-hoc simulator build that
    /// stripped it, or a target that was never granted the group. Callers must
    /// treat that as "no shared storage" and degrade, never as an error: the
    /// app worked before this file existed and must keep working without it.
    static var container: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: identifier)
    }

    /// Where `DiskCache` keeps its snapshots.
    ///
    /// The widget reads the app's last conversation response from here rather
    /// than making its own authenticated request — the same trade Android's
    /// `HereWidget` makes, and for the same reason: the widget's freshest
    /// trigger is the app having just loaded that list, at which point a second
    /// fetch would ask the server for something already on disk.
    static var snapshots: URL? {
        container?.appendingPathComponent("yappy-snapshots", isDirectory: true)
    }
}
