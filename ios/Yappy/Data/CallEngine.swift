import AVFoundation
import Combine
import Foundation

/// The media half of a call.
///
/// Everything about *who may join* — permission, ringing, the roster, the call
/// record — is the backend's job and works without any of this. What this owns
/// is the device side: the audio session, the route, the mic, and the state the
/// call screen renders.
///
/// The SFU is deliberately behind `CallMediaTransport`. The screen sees a
/// published state and four verbs, so attaching LiveKit (or swapping it later)
/// is one conforming type and no UI change — and the UI cannot accidentally
/// depend on an SDK's types.
enum MediaState {
    case idle
    case connecting
    case connected
    case reconnecting
    case failed
    case disconnected
}

struct CallMedia {
    var state: MediaState = .idle
    /// Transport identities are our user ids — the backend mints them that way.
    var speaking: Set<String> = []
    var remoteCount: Int = 0
    var micEnabled: Bool = true
    var error: String?
}

/// What an SFU client has to provide. Everything here is what the call screen
/// actually asks for; nothing about a particular vendor leaks through.
protocol CallMediaTransport: AnyObject {
    func connect(url: String, token: String, publishAudio: Bool) async throws
    func setMicrophoneEnabled(_ enabled: Bool) async
    func disconnect() async
    /// Called with the transport's view of the room whenever it changes.
    var onStateChange: ((MediaState) -> Void)? { get set }
    var onSpeakersChange: ((Set<String>) -> Void)? { get set }
    var onParticipantCountChange: ((Int) -> Void)? { get set }
}

@MainActor
final class CallEngine: ObservableObject {
    @Published private(set) var media = CallMedia()

    private var transport: CallMediaTransport?
    private let makeTransport: () -> CallMediaTransport?

    /// - Parameter transportFactory: Returns the SFU client to use, or nil when
    ///   the build has none linked. Nil is a supported state, not a bug: the
    ///   call still rings, the roster still updates and the record still lands
    ///   in the thread — there is simply no audio path, and the screen says so
    ///   rather than pretending.
    init(transportFactory: @escaping () -> CallMediaTransport? = { nil }) {
        makeTransport = transportFactory
    }

    /// - Parameter url: The SFU's websocket URL as the *server* sees it.
    ///   Rewritten by `resolveUrl` for the simulator, because the backend has no
    ///   idea it is talking to a client whose "localhost" may be elsewhere.
    /// - Parameter activateSession: False when the call runs under CallKit,
    ///   which owns activation — the system activates the session when the
    ///   call is answered, and an app that activates first is the classic way
    ///   lock-screen answers end up with dead audio. The category is still
    ///   ours to set either way.
    func connect(
        url: String,
        token: String,
        publishAudio: Bool = true,
        activateSession: Bool = true
    ) async {
        guard transport == nil else { return }
        media.state = .connecting
        media.error = nil

        // Calls belong on the loudspeaker by default; a voice call held to the
        // ear is a phone-app affordance we do not have proximity handling for
        // yet. Configured before connecting so the first audio unit the
        // transport creates already gets the right route.
        configureAudioSession(activate: activateSession)
        setSpeaker(true)

        guard let transport = makeTransport() else {
            media.state = .failed
            media.error = "This build has no audio transport linked."
            return
        }
        self.transport = transport

        transport.onStateChange = { [weak self] state in
            Task { @MainActor in self?.media.state = state }
        }
        // Drives the "who is talking" ring on the participant tiles.
        transport.onSpeakersChange = { [weak self] speakers in
            Task { @MainActor in self?.media.speaking = speakers }
        }
        transport.onParticipantCountChange = { [weak self] count in
            Task { @MainActor in self?.media.remoteCount = count }
        }

        do {
            try await transport.connect(url: url, token: token, publishAudio: publishAudio)
            media.state = .connected
            media.micEnabled = publishAudio
        } catch {
            media.state = .failed
            media.error = error.localizedDescription
        }
    }

    func setMicEnabled(_ enabled: Bool) async {
        media.micEnabled = enabled
        await transport?.setMicrophoneEnabled(enabled)
    }

    func setSpeaker(_ on: Bool) {
        let session = AVAudioSession.sharedInstance()
        try? session.overrideOutputAudioPort(on ? .speaker : .none)
    }

    /// Idempotent: the screen's disposal and an explicit hang-up both call it.
    func close() {
        let leaving = transport
        transport = nil
        Task { await leaving?.disconnect() }

        // Handing the session back matters more than it looks: leaving the app
        // in `.playAndRecord` keeps the orange mic indicator lit and ducks every
        // other app's audio long after the call is over.
        try? AVAudioSession.sharedInstance().setActive(
            false,
            options: .notifyOthersOnDeactivation
        )
        media = CallMedia(state: .disconnected)
    }

    private func configureAudioSession(activate: Bool) {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(
            .playAndRecord,
            mode: .voiceChat,
            // HFP is the two-way profile a call needs; A2DP is listed too so a
            // pair of headphones that only advertises playback still gets the
            // audio instead of it going out the loudspeaker mid-conversation.
            options: [.allowBluetoothHFP, .allowBluetoothA2DP, .defaultToSpeaker]
        )
        if activate { try? session.setActive(true) }
    }

    /// Asks for the microphone. Denied is a supported answer: the caller still
    /// joins and can hear everyone. Refusing to connect someone who declined a
    /// permission would be punishing them for the wrong thing.
    static func requestMicrophone() async -> Bool {
        await AVAudioApplication.requestRecordPermission()
    }

    static var microphoneGranted: Bool {
        AVAudioApplication.shared.recordPermission == .granted
    }

    /// The API returns the SFU URL from its own environment, where "localhost"
    /// means the machine the server runs on. The simulator shares the host's
    /// loopback so that name already resolves correctly here — unlike the
    /// Android emulator, which has to rewrite it to 10.0.2.2. Kept as a seam
    /// anyway, because a physical device on the LAN needs the same treatment.
    static func resolveUrl(_ url: String) -> String { url }
}
