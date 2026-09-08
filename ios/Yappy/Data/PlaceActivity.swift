import Combine
import Foundation

struct PlaceActivityRoom: Codable, Hashable, Identifiable {
    let conversationId: String
    var title: String
    var userIds: [String]
    var id: String { conversationId }
}

struct PlaceActivity: Codable, Equatable {
    var reading: [PlaceActivityRoom] = []
    var inVoice: [PlaceActivityRoom] = []

    /// Only expose channels returned by the permission-filtered channel list.
    /// Exclude ourselves even when an older response includes our voice seat.
    func visible(to userId: String, conversations: Set<String>) -> PlaceActivity {
        func filter(_ rooms: [PlaceActivityRoom]) -> [PlaceActivityRoom] {
            rooms.filter { conversations.contains($0.conversationId) }.compactMap { room in
                var room = room
                var seen = Set<String>()
                room.userIds = room.userIds.filter { $0 != userId && seen.insert($0).inserted }
                return room.userIds.isEmpty ? nil : room
            }.sorted { $0.title == $1.title ? $0.id < $1.id : $0.title.localizedStandardCompare($1.title) == .orderedAscending }
        }
        return PlaceActivity(reading: filter(reading), inVoice: filter(inVoice))
    }
}

extension YappyRepository {
    func activity(_ conversationId: String) async throws -> PlaceActivity {
        try await api.get("/conversations/\(conversationId)/activity")
    }
}

@MainActor
final class PlaceActivityModel: ObservableObject {
    @Published private(set) var activity: PlaceActivity?
    @Published private(set) var loading = false
    @Published private(set) var error: String?
    @Published private(set) var checkedAt: Date?
    private(set) var visibleIds: Set<String> = []
    private var revision = 0

    func load(repo: YappyRepository, id: String, isSpace: Bool, userId: String) async {
        revision += 1
        let request = revision
        loading = true
        defer { if revision == request { loading = false } }
        do {
            // Fetch visibility first: a failed channel request must never let
            // a place-wide activity response disclose a hidden channel.
            var visibleIds: Set<String> = [id]
            if isSpace { visibleIds.formUnion(try await repo.channels(id).channels.map(\.id)) }
            let result = try await repo.activity(id)
            guard !Task.isCancelled, request == revision else { return }
            self.visibleIds = visibleIds
            activity = result.visible(to: userId, conversations: visibleIds)
            checkedAt = Date()
            error = nil
        } catch {
            guard !Task.isCancelled, request == revision else { return }
            self.error = activity == nil ? "Couldn’t load activity." : "Couldn’t refresh activity. Showing the last update."
        }
    }

    func affects(_ event: GatewayEvent, placeId: String) -> Bool {
        switch event.type {
        case "ready", "resumed": return true
        case "voice.state":
            return event.data["spaceId"]?.stringValue == placeId
                || visibleIds.contains(event.data["channelId"]?.stringValue ?? "")
        case "presence.viewing":
            return visibleIds.contains(event.data["conversationId"]?.stringValue ?? "")
        case "conversation.update", "member.remove":
            return event.data["id"]?.stringValue == placeId
                || event.data["conversationId"]?.stringValue == placeId
        default: return false
        }
    }
}
