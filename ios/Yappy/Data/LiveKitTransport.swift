import Foundation
import LiveKit

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
