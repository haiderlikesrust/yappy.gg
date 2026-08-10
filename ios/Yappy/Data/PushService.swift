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
    /// has finished starting up is not dropped. Called with the APNs token and
    /// whatever VoIP token is known — the pair, because the server replaces
    /// both columns on every registration.
    var onToken: ((String, String?) async -> Void)?
    /// Where a tapped notification wants to go.
    var onOpen: ((DeepLink) -> Void)?
    /// The conversation on screen right now, so its own notifications are not
    /// shown as banners over the top of the messages they describe.
    var foregroundConversationId: String?

    private var apnsToken: String?
    /// From PKPushRegistry, which CallSystem owns; it lands here so the two
    /// tokens can be sent as one registration.
    private var voipToken: String?
    /// The pair most recently sent, so a flush() with nothing new is a no-op
    /// instead of a redundant PUT on every foreground.
    private var sentPair: String?
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
        apnsToken = deviceToken.map { String(format: "%02x", $0) }.joined()
        flush()
    }

    /// The VoIP token, from CallSystem's PKPushRegistry. Registration still
    /// waits for the APNs token — the server requires it — but both registries
    /// deliver on every launch, so the wait is milliseconds, not forever.
    func handleVoip(token: String) {
        voipToken = token
        flush()
    }

    /// Called again once the container is ready, in case a token — or a
    /// notification tap on a cold start — beat it.
    func flush() {
        if let token = apnsToken, let onToken {
            let pair = token + "|" + (voipToken ?? "")
            if pair != sentPair {
                sentPair = pair
                let voip = voipToken
                Task { await onToken(token, voip) }
            }
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
    /// With the app open, message pushes stay silent entirely: the gateway is
    /// faster than APNs, so the in-app banner has already shown by the time
    /// this fires — presenting the system banner too meant every message
    /// announced itself twice, a second apart. Anything without a
    /// conversationId (a call, account notices) keeps the system treatment;
    /// those have no in-app equivalent racing them.
    nonisolated func userNotificationCenter(
        _: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        let info = notification.request.content.userInfo
        let conversationId = info["conversationId"] as? String

        return await MainActor.run {
            if conversationId != nil { return [.badge] }
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
