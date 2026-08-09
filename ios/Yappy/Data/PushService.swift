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
    /// A tap that arrived before anything was listening for it.
    private var pendingOpen: DeepLink?

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

    /// Called again once the container is ready, in case the token — or a
    /// notification tap on a cold start — beat it.
    func flush() {
        if let token = pendingToken, let onToken {
            pendingToken = nil
            Task { await onToken(token) }
        }
        if let link = pendingOpen, let onOpen {
            pendingOpen = nil
            onOpen(link)
        }
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
            let link = DeepLink.conversation(conversationId)
            // Held if nothing is listening yet. On a cold start this callback
            // runs during launch, well before the container has wired itself
            // up, and the bare optional call used to drop the link on the floor
            // — you tapped a notification for a specific chat and landed on the
            // conversation list.
            guard let onOpen else { pendingOpen = link; return }
            onOpen(link)
        }
    }
}

/// The delegate exists only for the two remote-notification callbacks, which
/// SwiftUI's `App` has no equivalent of.
final class AppDelegate: NSObject, UIApplicationDelegate {
    /// The notification delegate has to exist *before* launch finishes.
    ///
    /// iOS delivers the tap that launched the app once, immediately, and
    /// setting the delegate from SwiftUI's `.task` — which does not run until
    /// after the first render — is too late to catch it. Tapping a notification
    /// while the app was merely backgrounded worked, which is what made this
    /// read as flaky rather than broken.
    func application(
        _: UIApplication,
        didFinishLaunchingWithOptions _: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        MainActor.assumeIsolated {
            UNUserNotificationCenter.current().delegate = PushService.shared
        }
        return true
    }

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
