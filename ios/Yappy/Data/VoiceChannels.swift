import Combine
import Foundation

struct VoiceOccupant: Codable, Hashable, Identifiable {
    let id: String
    var username: String?
    var displayName: String?
    var avatarUrl: String?
    var isMuted: Bool?
    var label: String { displayName ?? username ?? "someone" }
}

struct VoiceJoinEnvelope: Decodable {
    let token: String
    let url: String
    let participants: [VoiceOccupant]
}

extension YappyRepository {
    func joinVoice(_ id: String) async throws -> VoiceJoinEnvelope {
        try await api.post("/conversations/\(id)/voice/join", .object([:]))
    }

    func leaveVoice(_ id: String) async throws {
        try await api.send("POST", "/conversations/\(id)/voice/leave")
    }
}

/// One app-owned seat. Operations drain in order so a late join cannot revive
/// a departed seat or remove a replacement seat in the same channel.
@MainActor
final class VoiceChannels: ObservableObject {
    struct Session {
        let channelId: String
        let spaceId: String
        let title: String
    }

    @Published private(set) var session: Session?
    @Published private(set) var rosters: [String: [VoiceOccupant]] = [:]
    @Published var error: String?
    let engine: CallEngine
    private let repo: YappyRepository
    private let callBusy: () -> Bool
    private var generation = UUID()
    private var operation: Task<Void, Never>?
    private var listeners = Set<AnyCancellable>()

    init(repo: YappyRepository, engine: CallEngine, gateway: GatewayClient,
         callBusy: @escaping () -> Bool) {
        self.repo = repo
        self.engine = engine
        self.callBusy = callBusy
        gateway.events.sink { [weak self] event in
            guard event.type == "voice.state",
                  let id = event.data["channelId"]?.stringValue,
                  let people = event.data["participants"]?.decoded(as: [VoiceOccupant].self)
            else { return }
            self?.rosters[id] = people
        }.store(in: &listeners)
        engine.$media.sink { [weak self] media in
            guard let self, session != nil else { return }
            if media.state == .failed || media.state == .disconnected {
                error = media.error ?? "Voice disconnected. Tap the channel to rejoin."
                leave()
            }
        }.store(in: &listeners)
    }

    func remember(_ channels: [ChannelEntry]) {
        for channel in channels where channel.isVoice { rosters[channel.id] = channel.voiceParticipants }
    }

    func join(channelId: String, spaceId: String, title: String) {
        guard !callBusy() else { error = "Leave your call before joining a voice channel."; return }
        guard session?.channelId != channelId else { return }
        leave()
        error = nil
        let attempt = UUID()
        generation = attempt
        session = Session(channelId: channelId, spaceId: spaceId, title: title)
        let previous = operation
        operation = Task { [weak self] in
            await previous?.value
            guard let self, generation == attempt else { return }
            let granted = await CallEngine.requestMicrophone()
            guard generation == attempt, !callBusy() else { return }
            do {
                let ticket = try await repo.joinVoice(channelId)
                guard generation == attempt, !callBusy() else {
                    try? await repo.leaveVoice(channelId)
                    return
                }
                rosters[channelId] = ticket.participants
                await engine.connect(url: CallEngine.resolveUrl(ticket.url), token: ticket.token,
                                     publishAudio: granted)
            } catch {
                guard generation == attempt else { return }
                self.error = error.localizedDescription
                leave()
            }
        }
    }

    /// Clears local ownership synchronously, before CallKit can adopt the engine.
    func leave(deactivateSession: Bool = true) {
        generation = UUID()
        guard let departing = session else { return }
        session = nil
        engine.close(deactivateSession: deactivateSession)
        let previous = operation
        operation = Task { [repo] in
            await previous?.value
            try? await repo.leaveVoice(departing.channelId)
        }
    }

    func toggleMute() async {
        let attempt = generation
        guard session != nil, engine.media.state == .connected else { return }
        if !engine.media.micEnabled {
            guard await CallEngine.requestMicrophone() else {
                error = "Microphone access is off. You can listen, or enable it in iPhone Settings."
                return
            }
        }
        guard generation == attempt else { return }
        await engine.setMicEnabled(!engine.media.micEnabled)
    }

    func reset() {
        leave()
        rosters = [:]
        error = nil
    }
}
