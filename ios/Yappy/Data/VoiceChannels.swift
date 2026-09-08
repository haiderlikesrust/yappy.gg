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

@MainActor
protocol VoiceChannelAPI {
    func joinVoice(_ id: String) async throws -> VoiceJoinEnvelope
    func leaveVoice(_ id: String) async throws
}

extension YappyRepository: VoiceChannelAPI {
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
        let accountGeneration: UUID?
    }

    @Published private(set) var session: Session?
    @Published private(set) var rosters: [String: [VoiceOccupant]] = [:]
    @Published var error: String?
    private var spaceByChannel: [String: String] = [:]
    let engine: CallEngine
    private let repo: any VoiceChannelAPI
    private let callBusy: () -> Bool
    private let microphonePermission: () async -> Bool
    private let accountGeneration: () -> UUID?
    private var generation = UUID()
    private var operation: Task<Void, Never>?
    private var listeners = Set<AnyCancellable>()

    init(repo: any VoiceChannelAPI, engine: CallEngine, gateway: GatewayClient? = nil,
         callBusy: @escaping () -> Bool,
         microphonePermission: @escaping () async -> Bool = { await CallEngine.requestMicrophone() },
         accountGeneration: @escaping () -> UUID? = { nil }) {
        self.repo = repo
        self.engine = engine
        self.callBusy = callBusy
        self.microphonePermission = microphonePermission
        self.accountGeneration = accountGeneration
        gateway?.events.sink { [weak self] event in
            guard event.type == "voice.state",
                  let id = event.data["channelId"]?.stringValue,
                  let people = event.data["participants"]?.decoded(as: [VoiceOccupant].self)
            else { return }
            if let spaceId = event.data["spaceId"]?.stringValue { self?.spaceByChannel[id] = spaceId }
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

    func remember(_ channels: [ChannelEntry], spaceId: String) {
        let live = Set(channels.filter(\.isVoice).map(\.id))
        for id in Array(spaceByChannel.keys) where spaceByChannel[id] == spaceId && !live.contains(id) {
            spaceByChannel.removeValue(forKey: id)
            rosters.removeValue(forKey: id)
        }
        for channel in channels where channel.isVoice {
            spaceByChannel[channel.id] = spaceId
            rosters[channel.id] = channel.voiceParticipants
        }
    }

    func count(in conversationId: String) -> Int {
        if let people = rosters[conversationId] { return people.count }
        return Set(spaceByChannel.filter { $0.value == conversationId }.keys
            .flatMap { rosters[$0, default: []].map(\.id) }).count
    }

    func join(channelId: String, spaceId: String, title: String) {
        guard !callBusy() else { error = "Leave your call before joining a voice channel."; return }
        guard session?.channelId != channelId else { return }
        leave()
        error = nil
        let attempt = UUID()
        generation = attempt
        let account = accountGeneration()
        session = Session(channelId: channelId, spaceId: spaceId, title: title, accountGeneration: account)
        let previous = operation
        operation = Task { [weak self] in
            await previous?.value
            guard let self, generation == attempt, accountGeneration() == account else { return }
            let granted = await microphonePermission()
            guard generation == attempt, accountGeneration() == account else { return }
            guard !callBusy() else {
                leave()
                error = "Leave your call before joining a voice channel."
                return
            }
            do {
                let ticket = try await repo.joinVoice(channelId)
                guard generation == attempt, !callBusy(), accountGeneration() == account else {
                    if accountGeneration() == account { try? await repo.leaveVoice(channelId) }
                    if generation == attempt { leave() }
                    return
                }
                spaceByChannel[channelId] = spaceId
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
        operation = Task { [repo, accountGeneration] in
            await previous?.value
            guard accountGeneration() == departing.accountGeneration else { return }
            try? await repo.leaveVoice(departing.channelId)
        }
    }

    func toggleMute() async {
        let attempt = generation
        guard session != nil, engine.media.state == .connected else { return }
        if !engine.media.micEnabled {
            guard await microphonePermission() else {
                error = "Microphone access is off. You can listen, or enable it in iPhone Settings."
                return
            }
        }
        guard generation == attempt else { return }
        await engine.setMicEnabled(!engine.media.micEnabled)
        if generation == attempt { error = engine.media.error }
    }

    func reset() {
        leave()
        rosters = [:]
        spaceByChannel = [:]
        error = nil
    }

    func waitUntilSettled() async { await operation?.value }
}
