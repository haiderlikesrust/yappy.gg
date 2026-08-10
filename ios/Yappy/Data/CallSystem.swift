import AVFAudio
import CallKit
import Combine
import PushKit
import UIKit

/// The system half of calling: PushKit wakes us, CallKit rings, and every call
/// — incoming or outgoing — runs through here so the OS and the app agree on
/// what is happening.
///
/// This exists because a phone must ring when the app is closed. That means
/// audio can start with **no UI in existence** — someone answers from the lock
/// screen, `CallScreen` has never been built, and the microphone is already
/// live. So the engine cannot belong to a screen; it belongs to the container,
/// and the screen adopts whatever this object already connected.
///
/// One rule dominates everything here: **every VoIP push must be reported to
/// CallKit before the push handler returns.** iOS kills the app for skipping
/// it, and after a few kills stops delivering VoIP pushes to this bundle at
/// all — silently, permanently, per device. That is why `reportIncoming` runs
/// synchronously in the push callback and reconciliation happens after.
@MainActor
final class CallSystem: NSObject, ObservableObject {
    static let shared = CallSystem()

    /// Reported to CallKit and still unanswered on this device.
    @Published private(set) var ringingCallId: String?
    /// Answered or started here; the engine is (or is becoming) connected.
    @Published private(set) var activeCallId: String?
    /// Mirror of CallKit's mute, so the in-app button and the lock-screen
    /// button are the same switch and not two that drift.
    @Published private(set) var muted = false
    /// Set when a call was answered and the UI should navigate to it. RootView
    /// consumes it and puts it back to nil.
    @Published var openCallId: String?

    private weak var container: AppContainer?
    private var provider: CXProvider?
    private let callController = CXCallController()
    private var registry: PKPushRegistry?

    /// callId ↔ CallKit UUID. Server call ids are UUIDs already, so the map is
    /// usually the identity — but CallKit requires the type, not the string.
    private var uuidByCall: [String: UUID] = [:]
    private var callByUuid: [UUID: String] = [:]

    private var ringTimeout: Task<Void, Never>?
    private var gatewayListener: AnyCancellable?
    private var engineWatch: AnyCancellable?

    // ── Setup ────────────────────────────────────────────────────────────────

    func attach(container: AppContainer) {
        self.container = container

        let config = CXProviderConfiguration()
        config.supportsVideo = true
        config.maximumCallGroups = 1
        config.maximumCallsPerCallGroup = 1
        config.supportedHandleTypes = [.generic]
        config.iconTemplateImageData = UIImage(named: "LogoMark")?.pngData()

        let provider = CXProvider(configuration: config)
        provider.setDelegate(self, queue: nil)
        self.provider = provider

        // Registered unconditionally, signed in or not: the token is only
        // *sent* to the server once auth exists (PushService gates on that),
        // and a registry created late misses the credentials PushKit delivers
        // at launch.
        let registry = PKPushRegistry(queue: .main)
        registry.delegate = self
        registry.desiredPushTypes = [.voIP]
        self.registry = registry

        // The socket is the ring path whenever the app is alive — it beats
        // APNs by seconds and it is the only path on the simulator, where
        // VoIP push does not exist.
        gatewayListener = container.gateway.events.sink { [weak self] event in
            self?.handleGatewayEvent(event)
        }

        // The engine's own view of the room, watched for the deaths nothing
        // announces: the server deleted the room, the connection failed for
        // good. Without this the CallKit call outlives the audio it stood for.
        engineWatch = container.callEngine.$media
            .map(\.state)
            .removeDuplicates()
            .sink { [weak self] state in
                guard let self, let callId = self.activeCallId else { return }
                switch state {
                case .disconnected, .failed:
                    self.reportEnded(callId, reason: .remoteEnded)
                default:
                    break
                }
            }
    }

    /// Sign-out. Any call this account was in is over as far as this device is
    /// concerned, and the CallKit UI must not survive into the next account.
    func reset() {
        for callId in uuidByCall.keys { reportEnded(callId, reason: .remoteEnded) }
        container?.callEngine.close()
    }

    // ── Incoming ─────────────────────────────────────────────────────────────

    /// Report a ring to CallKit. Idempotent per call — the VoIP push and the
    /// socket event both arrive when the app is foregrounded, and the second
    /// one must not produce a second ring.
    private func reportIncoming(
        callId: String,
        callerName: String,
        hasVideo: Bool,
        expiresAt: String?,
        completion: (() -> Void)? = nil
    ) {
        guard uuidByCall[callId] == nil, activeCallId != callId else {
            completion?()
            return
        }

        let uuid = UUID(uuidString: callId) ?? UUID()
        uuidByCall[callId] = uuid
        callByUuid[uuid] = callId

        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .generic, value: callerName)
        update.localizedCallerName = callerName
        update.hasVideo = hasVideo
        update.supportsHolding = false
        update.supportsGrouping = false
        update.supportsUngrouping = false
        update.supportsDTMF = false

        ringingCallId = callId
        provider?.reportNewIncomingCall(with: uuid, update: update) { [weak self] error in
            Task { @MainActor in
                // Do Not Disturb or a blocked caller: CallKit refused the ring.
                // Clean up so the id is not stuck looking active forever.
                if error != nil { self?.cleanup(callId) }
                completion?()
            }
        }

        armRingTimeout(callId, expiresAt: expiresAt)
        reconcile(callId)
    }

    /// The push races the call's actual state: the caller may have hung up, or
    /// another of this user's devices answered while APNs was in flight. The
    /// ring was already reported — the rule demands it — so the correction is
    /// to end it, with a reason that says which thing happened.
    private func reconcile(_ callId: String) {
        Task { [weak self] in
            guard let container = self?.container else { return }
            guard let call = try? await container.repo.call(callId).call else { return }
            guard let self, self.ringingCallId == callId else { return }

            let mine = call.participants.first { $0.user.id == container.session.userId }
            if mine?.state == "joined" {
                self.reportEnded(callId, reason: .answeredElsewhere)
            } else if mine?.state == "declined" {
                self.reportEnded(callId, reason: .declinedElsewhere)
            } else if call.state == "ended" {
                self.reportEnded(callId, reason: .unanswered)
            }
        }
    }

    /// Stop ringing at the server's deadline even if every end event is lost —
    /// the same absolute-deadline rule the gateway protocol asks of clients.
    private func armRingTimeout(_ callId: String, expiresAt: String?) {
        ringTimeout?.cancel()
        let deadline = expiresAt.flatMap { YappyTime.parse($0) }
        let seconds = deadline.map { max(1, $0.timeIntervalSinceNow) } ?? 45
        ringTimeout = Task { [weak self] in
            try? await Task.sleep(for: .seconds(seconds))
            guard !Task.isCancelled else { return }
            guard let self, self.ringingCallId == callId else { return }
            self.reportEnded(callId, reason: .unanswered)
        }
    }

    // ── Outgoing / joining from the UI ───────────────────────────────────────

    /// Connect to a call from inside the app — starting one, or opening an
    /// active group call. Routed through CallKit so the system knows the call
    /// exists: that is what keeps the mic alive in the background and stops a
    /// cellular call from silently killing ours.
    func connect(callId: String, displayName: String, hasVideo: Bool) async {
        if activeCallId == callId { return }

        // Already ringing on this device: connecting *is* answering, and it
        // must go through CallKit's answer action or the system UI stays up.
        if ringingCallId == callId, let uuid = uuidByCall[callId] {
            request(CXAnswerCallAction(call: uuid))
            return
        }

        let uuid = UUID(uuidString: callId) ?? UUID()
        uuidByCall[callId] = uuid
        callByUuid[uuid] = callId

        let action = CXStartCallAction(call: uuid, handle: CXHandle(type: .generic, value: displayName))
        action.isVideo = hasVideo
        request(action)
    }

    /// Hang up, decline, or dismiss — one verb, because CallKit models all of
    /// them as ending the call and the perform handler picks the right API.
    func hangUp(_ callId: String) {
        guard let uuid = uuidByCall[callId] else { return }
        request(CXEndCallAction(call: uuid))
    }

    func setMuted(_ next: Bool) {
        guard let callId = activeCallId, let uuid = uuidByCall[callId] else { return }
        request(CXSetMutedCallAction(call: uuid, muted: next))
    }

    /// The roster poll noticed the call ended while the socket was down.
    func noteEnded(_ callId: String) {
        guard uuidByCall[callId] != nil else { return }
        reportEnded(callId, reason: .remoteEnded)
    }

    private func request(_ action: CXAction) {
        callController.request(CXTransaction(action: action)) { error in
            if let error {
                NSLog("[yappy] CallKit transaction failed: \(error.localizedDescription)")
            }
        }
    }

    // ── Shared teardown ──────────────────────────────────────────────────────

    /// Tell CallKit the call is over and forget it. Safe to call twice; the
    /// second report lands on a UUID CallKit no longer knows and is ignored.
    private func reportEnded(_ callId: String, reason: CXCallEndedReason) {
        if let uuid = uuidByCall[callId] {
            provider?.reportCall(with: uuid, endedAt: nil, reason: reason)
        }
        if activeCallId == callId { container?.callEngine.close() }
        cleanup(callId)
    }

    private func cleanup(_ callId: String) {
        if let uuid = uuidByCall.removeValue(forKey: callId) {
            callByUuid.removeValue(forKey: uuid)
        }
        if ringingCallId == callId {
            ringingCallId = nil
            ringTimeout?.cancel()
        }
        if activeCallId == callId {
            activeCallId = nil
            muted = false
        }
    }

    /// Join the call and bring audio up. The one path both directions share.
    private func establish(_ callId: String) async throws {
        guard let container else { throw CancellationError() }

        let joined = try await container.repo.joinCall(callId, video: false)
        guard let token = joined.token, let url = joined.url else {
            // Joined the roster but got no media token — a server without
            // LIVEKIT_URL. The call exists; the screen will say audio is off.
            activeCallId = callId
            ringingCallId = nil
            return
        }

        await container.callEngine.connect(
            url: CallEngine.resolveUrl(url),
            token: token,
            publishAudio: CallEngine.microphoneGranted,
            // CallKit activates the session at answer; doing it ourselves
            // first is the classic dead-audio-from-the-lock-screen bug.
            activateSession: false
        )
        activeCallId = callId
        ringingCallId = nil
        ringTimeout?.cancel()
    }

    // ── Gateway ──────────────────────────────────────────────────────────────

    private func handleGatewayEvent(_ event: GatewayEvent) {
        switch event.type {
        case "call.ring":
            guard let payload = try? JSONEncoder().encode(event.data),
                  let call = try? JSONDecoder().decode(Call.self, from: payload),
                  !call.id.isEmpty
            else { return }
            // Never ring the person who started it: their own devices are not
            // invitees today, but a payload bug must not make a phone ring
            // itself.
            guard call.initiatorId != container?.session.userId else { return }

            let caller = call.participants.first { $0.user.id == call.initiatorId }
            reportIncoming(
                callId: call.id,
                callerName: caller?.user.label ?? "yappy",
                hasVideo: call.mode == "video",
                expiresAt: event.data["expiresAt"]?.stringValue ?? call.ringExpiresAt
            )

        case "call.end":
            guard let id = event.data["id"]?.stringValue, uuidByCall[id] != nil else { return }
            reportEnded(id, reason: .remoteEnded)

        case "call.update":
            guard let id = event.data["id"]?.stringValue,
                  ringingCallId == id,
                  event.data["state"]?.stringValue == "ended"
            else { return }
            reportEnded(id, reason: .remoteEnded)

        // Another of this user's devices acted; this one stops ringing with a
        // reason that draws the right line in the system call log.
        case "call.participant_update":
            guard let id = event.data["callId"]?.stringValue,
                  ringingCallId == id,
                  event.data["userId"]?.stringValue == container?.session.userId,
                  event.data["answeredOn"]?.stringValue != container?.session.deviceId
            else { return }
            let state = event.data["state"]?.stringValue
            if state == "joined" { reportEnded(id, reason: .answeredElsewhere) }
            if state == "declined" { reportEnded(id, reason: .declinedElsewhere) }

        default:
            break
        }
    }
}

// ── CallKit actions ──────────────────────────────────────────────────────────

extension CallSystem: CXProviderDelegate {
    /// The system reset telephony. Everything we believed is void.
    nonisolated func providerDidReset(_: CXProvider) {
        Task { @MainActor in
            self.container?.callEngine.close()
            for callId in self.uuidByCall.keys { self.cleanup(callId) }
        }
    }

    nonisolated func provider(_: CXProvider, perform action: CXAnswerCallAction) {
        Task { @MainActor in
            guard let callId = self.callByUuid[action.callUUID] else {
                action.fail()
                return
            }
            do {
                try await self.establish(callId)
                self.openCallId = callId
                action.fulfill()
            } catch {
                action.fail()
                self.reportEnded(callId, reason: .failed)
            }
        }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
        Task { @MainActor in
            guard let callId = self.callByUuid[action.callUUID] else {
                action.fail()
                return
            }
            provider.reportOutgoingCall(with: action.callUUID, startedConnectingAt: Date())
            do {
                try await self.establish(callId)
                provider.reportOutgoingCall(with: action.callUUID, connectedAt: Date())
                action.fulfill()
            } catch {
                action.fail()
                self.cleanup(callId)
            }
        }
    }

    nonisolated func provider(_: CXProvider, perform action: CXEndCallAction) {
        Task { @MainActor in
            guard let callId = self.callByUuid[action.callUUID],
                  let container = self.container
            else {
                action.fulfill()
                return
            }

            let wasActive = self.activeCallId == callId
            // Clean up *before* the awaits: the engine-state watcher fires on
            // close(), and it must find nothing left to double-report.
            self.cleanup(callId)

            if wasActive {
                container.callEngine.close()
                try? await container.repo.leaveCall(callId)
            } else {
                // Ringing and never answered: this is a decline.
                _ = try? await container.repo.declineCall(callId)
            }
            action.fulfill()
        }
    }

    nonisolated func provider(_: CXProvider, perform action: CXSetMutedCallAction) {
        Task { @MainActor in
            guard let callId = self.callByUuid[action.callUUID],
                  let container = self.container
            else {
                action.fulfill()
                return
            }
            self.muted = action.isMuted
            // Track first, roster second — the slow half must not leave a
            // hot mic behind a "muted" label.
            await container.callEngine.setMicEnabled(!action.isMuted)
            _ = try? await container.repo.setCallState(callId, muted: action.isMuted)
            action.fulfill()
        }
    }

    /// CallKit activated the session — the audio engine is already configured
    /// and starts against the now-live session. Nothing to do but let it.
    nonisolated func provider(_: CXProvider, didActivate _: AVAudioSession) {}
    nonisolated func provider(_: CXProvider, didDeactivate _: AVAudioSession) {}
}

// ── VoIP push ────────────────────────────────────────────────────────────────

extension CallSystem: PKPushRegistryDelegate {
    nonisolated func pushRegistry(
        _: PKPushRegistry,
        didUpdate credentials: PKPushCredentials,
        for _: PKPushType
    ) {
        let hex = credentials.token.map { String(format: "%02x", $0) }.joined()
        Task { @MainActor in PushService.shared.handleVoip(token: hex) }
    }

    nonisolated func pushRegistry(
        _: PKPushRegistry,
        didReceiveIncomingPushWith payload: PKPushPayload,
        for _: PKPushType,
        completion: @escaping () -> Void
    ) {
        // The registry's queue is main, so this hop is a formality — but the
        // report must happen *now*, in this callback, not in a scheduled task.
        // iOS kills apps that take a VoIP push and show no call for it.
        MainActor.assumeIsolated {
            let data = payload.dictionaryPayload
            let callId = (data["callId"] as? String) ?? UUID().uuidString
            reportIncoming(
                callId: callId,
                callerName: (data["callerName"] as? String) ?? "yappy",
                hasVideo: (data["mode"] as? String) == "video",
                expiresAt: data["expiresAt"] as? String,
                completion: completion
            )
        }
    }
}
