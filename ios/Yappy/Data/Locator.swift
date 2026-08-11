import CoreLocation
import Foundation

/// Where the phone is.
///
/// Wraps `CLLocationManager` in something awaitable, because every use here is
/// "give me one fix" or "keep them coming until I say stop" and the delegate
/// protocol is neither.
///
/// When In Use only. An always-on authorisation would let a live share keep
/// running with the app closed — which is what WhatsApp does, and is also a
/// permission people are right to refuse. A share here stops when the app does,
/// which is a smaller promise and one that can actually be kept.
@MainActor
final class Locator: NSObject, ObservableObject, CLLocationManagerDelegate {
    static let shared = Locator()

    private let manager = CLLocationManager()
    private var oneShot: CheckedContinuation<CLLocation?, Never>?
    private var stream: ((CLLocation) -> Void)?

    /// True once the person has said yes. `notDetermined` is not a no — it is
    /// the state in which asking is the correct next move.
    var authorised: Bool {
        let status = manager.authorizationStatus
        return status == .authorizedWhenInUse || status == .authorizedAlways
    }

    var denied: Bool {
        let status = manager.authorizationStatus
        return status == .denied || status == .restricted
    }

    override private init() {
        super.init()
        manager.delegate = self
        // Ten metres of movement before a new fix. Sharper than this is battery
        // spent to redraw a dot that has not visibly moved.
        manager.distanceFilter = 10
        manager.desiredAccuracy = kCLLocationAccuracyNearestTenMeters
    }

    func requestAuthorisation() {
        guard manager.authorizationStatus == .notDetermined else { return }
        manager.requestWhenInUseAuthorization()
    }

    /// One fix, or nil if it is refused or nothing arrives.
    ///
    /// Deliberately not `manager.location`, which can hold a position from
    /// hours ago and somewhere else — a stale point sent as "here I am" is the
    /// one bug in this feature that would genuinely mislead somebody.
    func current(timeout: Duration = .seconds(12)) async -> CLLocation? {
        guard authorised else { return nil }

        let fix: CLLocation? = await withCheckedContinuation { continuation in
            oneShot = continuation
            manager.requestLocation()
        }
        return fix
    }

    /// Keep them coming. Every fix while a live share is running.
    func startUpdates(_ onFix: @escaping (CLLocation) -> Void) {
        guard authorised else { return }
        stream = onFix
        manager.startUpdatingLocation()
    }

    func stopUpdates() {
        stream = nil
        manager.stopUpdatingLocation()
    }

    // ── CLLocationManagerDelegate ────────────────────────────────────────────

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let latest = locations.last else { return }
        Task { @MainActor in
            self.oneShot?.resume(returning: latest)
            self.oneShot = nil
            self.stream?(latest)
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        Task { @MainActor in
            // A one-shot request that fails must still answer, or the caller
            // waits forever on a continuation nothing will ever resume.
            self.oneShot?.resume(returning: nil)
            self.oneShot = nil
        }
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        Task { @MainActor in self.objectWillChange.send() }
    }
}

/// The thing that keeps a live share moving.
///
/// Deliberately not owned by the chat screen. A share is a promise that lasts
/// until its end time, and the screen is destroyed the moment you tap back —
/// so a broadcaster living there would leave a card saying "live" over a dot
/// that had quietly stopped moving, which is worse than not offering the
/// feature. This outlives the screen and stops on its own terms: the share
/// ending, the sender stopping it, or the server saying it is over.
///
/// One at a time. Sharing in a second conversation replaces the first, because
/// there is one GPS and one person, and pretending otherwise would drain a
/// battery to keep two dots in sync that are always in the same place.
@MainActor
final class LiveShare: ObservableObject {
    static let shared = LiveShare()

    @Published private(set) var conversationId: String?
    @Published private(set) var messageId: String?

    private var repo: YappyRepository?

    private init() {}

    var isSharing: Bool { messageId != nil }

    func start(repo: YappyRepository, conversationId: String, messageId: String) {
        stop()
        self.repo = repo
        self.conversationId = conversationId
        self.messageId = messageId

        Locator.shared.startUpdates { [weak self] fix in
            guard let self, let repo = self.repo,
                  let conversationId = self.conversationId,
                  let messageId = self.messageId
            else { return }

            Task { @MainActor in
                do {
                    try await repo.pingLocation(
                        conversationId,
                        messageId: messageId,
                        latitude: fix.coordinate.latitude,
                        longitude: fix.coordinate.longitude,
                        accuracy: fix.horizontalAccuracy,
                        heading: fix.course
                    )
                } catch {
                    // The server refuses a ping for a share that has ended or
                    // expired. Holding the GPS open after that is battery spent
                    // on nobody's behalf.
                    self.stop()
                }
            }
        }
    }

    func stop() {
        guard messageId != nil else { return }
        Locator.shared.stopUpdates()
        conversationId = nil
        messageId = nil
        repo = nil
    }

    /// Stop only if this is the share in question — used when an end event
    /// arrives for a share that may not be ours.
    func stopIfSharing(messageId: String) {
        if self.messageId == messageId { stop() }
    }
}
