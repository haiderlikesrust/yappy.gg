import Foundation
import LiveKit

/// Global media-runtime policy. Lives here because this is the only file
/// allowed to import LiveKit; the interface is plain Swift so CallSystem and
/// CallEngine can call it without breaking that rule.
enum CallMediaRuntime {
    /// Take the AVAudioSession away from the SDK, permanently.
    ///
    /// LiveKit's default automatic session management calls `setActive(true)`
    /// when the mic publishes. Under CallKit that is a fight over a session
    /// CallKit owns, and the SDK loses it mid-answer: "Failed to configure
    /// audio session" on the receiving phone, and a call with no audio in
    /// either direction. CallKit activates; CallEngine sets the category;
    /// the SDK touches nothing.
    static func claimAudioSession() {
        AudioManager.shared.audioSession.isAutomaticConfigurationEnabled = false
    }

    /// Gate the WebRTC audio engine on CallKit's session handover.
    ///
    /// A room connected between "answered" and `didActivate` must not start
    /// its audio unit yet — starting on a session that is not active is the
    /// audio-unit failure family (-4010 and friends). The SDK queues the
    /// pending publish and starts the engine the moment the gate opens.
    static func setAudioEngineRunnable(_ runnable: Bool) {
        try? AudioManager.shared.setEngineAvailability(runnable ? .default : .none)
    }
}

/// The SFU client, and the only file in the app that imports LiveKit.
///
/// Media never touches our backend — this talks straight to LiveKit using the
/// scoped token the API mints per join. Everything the call screen needs is
/// behind `CallMediaTransport`, so replacing the SFU later is this one file and
/// no UI change.
final class LiveKitTransport: NSObject, CallMediaTransport {
    // `nonisolated(unsafe)`: these are written once at setup and then only read
    // from the SDK's delegate queue. The alternative is an actor hop on every
    // speaking-change, which fires several times a second during a call.
    nonisolated(unsafe) var onStateChange: ((MediaState) -> Void)?
    nonisolated(unsafe) var onSpeakersChange: ((Set<String>) -> Void)?
    nonisolated(unsafe) var onParticipantCountChange: ((Int) -> Void)?

    /// Written on connect and cleared on disconnect, both from the call screen's
    /// main-actor context; the delegate only ever reads it.
    nonisolated(unsafe) private var room: Room?

    func connect(url: String, token: String, publishAudio: Bool) async throws {
        let room = Room(delegate: self)
        self.room = room

        try await room.connect(url: url, token: token)
        if publishAudio {
            try await room.localParticipant.setMicrophone(enabled: true)
        }
        onParticipantCountChange?(room.remoteParticipants.count)
    }

    func setMicrophoneEnabled(_ enabled: Bool) async {
        _ = try? await room?.localParticipant.setMicrophone(enabled: enabled)
    }

    func disconnect() async {
        await room?.disconnect()
        room = nil
    }
}

extension LiveKitTransport: RoomDelegate {
    func room(_: Room, didUpdateConnectionState state: ConnectionState, from _: ConnectionState) {
        switch state {
        case .connected: onStateChange?(.connected)
        case .connecting: onStateChange?(.connecting)
        case .reconnecting: onStateChange?(.reconnecting)
        case .disconnected: onStateChange?(.disconnected)
        // `disconnecting` is a transition, not a state worth showing: the UI
        // would flash "Disconnected" a beat before the room actually goes.
        default: break
        }
    }

    func room(_: Room, didFailToConnectWithError _: LiveKitError?) {
        onStateChange?(.failed)
    }

    /// Drives the "who is talking" ring on the participant tiles.
    ///
    /// LiveKit identities are our user ids — the backend mints them that way —
    /// so these map straight onto the roster without a lookup table.
    func room(_: Room, didUpdateSpeakingParticipants participants: [Participant]) {
        onSpeakersChange?(Set(participants.compactMap { $0.identity?.stringValue }))
    }

    func room(_ room: Room, participantDidConnect _: RemoteParticipant) {
        onParticipantCountChange?(room.remoteParticipants.count)
    }

    func room(_ room: Room, participantDidDisconnect _: RemoteParticipant) {
        onParticipantCountChange?(room.remoteParticipants.count)
    }
}
