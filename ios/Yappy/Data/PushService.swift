import UIKit
import UserNotifications

/// Push registration and delivery.
///
/// The server's worker already speaks APNs (`apps/worker/src/lib/apns.ts`) and
/// its `APNS_BUNDLE_ID` defaults to this app's id, so the only missing half was
/// the client: ask, get a token, hand it to `PUT /devices/me/push`, and route a
/// tap back into the conversation.
///
/// Permission is asked for *after* sign-in rather than at first launch. A
/// prompt on the very first screen, before the person has seen a single
/// message, is the one most reliably denied — and iOS only lets you ask once.
@MainActor
final class PushService: NSObject, ObservableObject {
    static let shared = PushService()

    /// Set once the container exists, so a token that arrives before the app
    /// has finished starting up is not dropped.
    var onToken: ((String) async -> Void)?
    /// Where a tapped notification wants to go.
    var onOpen: ((DeepLink) -> Void)?
    /// The conversation on screen right now, so its own notifications are not
    /// shown as banners over the top of the messages they describe.
    var foregroundConversationId: String?

    private var pendingToken: String?

    func configure() {
        UNUserNotificationCenter.current().delegate = self
    }

    /// Asks, then registers. Safe to call more than once: iOS answers from the
    /// stored decision after the first time and never re-prompts.
    func register() async {
        let centre = UNUserNotificationCenter.current()
        let granted = (try? await centre.requestAuthorization(options: [.alert, .badge, .sound])) ?? false
        guard granted else { return }
        UIApplication.shared.registerForRemoteNotifications()
    }

    func handle(deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        pendingToken = hex
        flush()
    }

    /// Called again once the container is ready, in case the token beat it.
    func flush() {
        guard let token = pendingToken, let onToken else { return }
        pendingToken = nil
        Task { await onToken(token) }
    }

    func clearBadge() {
        UNUserNotificationCenter.current().setBadgeCount(0)
    }
}

extension PushService: UNUserNotificationCenterDelegate {
    /// A notification for the chat you are already looking at is noise — the
    /// message is arriving over the socket and is already on screen.
    nonisolated func userNotificationCenter(
        _: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        let info = notification.request.content.userInfo
        let conversationId = info["conversationId"] as? String

        return await MainActor.run {
            if let conversationId, conversationId == foregroundConversationId { return [] }
            return [.banner, .sound, .badge]
        }
    }

    nonisolated func userNotificationCenter(
        _: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let info = response.notification.request.content.userInfo
        guard let conversationId = info["conversationId"] as? String else { return }
        await MainActor.run {
            onOpen?(.conversation(conversationId))
        }
    }
}

/// The delegate exists only for the two remote-notification callbacks, which
/// SwiftUI's `App` has no equivalent of.
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        Task { @MainActor in PushService.shared.handle(deviceToken: deviceToken) }
    }

    func application(
        _: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        // Nothing to retry against — this is a provisioning or entitlement
        // problem, not a transient one. The app keeps working without push.
        NSLog("[yappy] push registration failed: \(error.localizedDescription)")
    }
}
