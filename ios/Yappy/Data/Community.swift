import Foundation

struct CommunityActivity: Decodable, Identifiable {
    let id: String; let kind: String; let conversationId: String; let conversationTitle: String?
    let messageId: String?; let seq: Int64?; let title: String; let body: String; let createdAt: String
}
struct CommunityRoom: Decodable, Identifiable {
    var id: String { conversationId }
    let conversationId: String; let title: String; let unreadCount: Int
}
struct CommunityCatchUp: Decodable { let items: [CommunityActivity]; let rooms: [CommunityRoom] }
struct CommunityEvent: Decodable, Identifiable {
    let id: String; let conversationId: String; let conversationTitle: String
    let title: String; let description: String; let location: String
    let startsAt: String; let endsAt: String?; let cancelledAt: String?; let response: String?
    let remind: Bool; let going: Int; let maybe: Int; let canManage: Bool
}
struct CommunityEvents: Decodable { let events: [CommunityEvent] }
struct CommunityReminder: Decodable, Identifiable {
    let id: String; let conversationId: String; let messageId: String?; let seq: Int64?; let eventId: String?
    let dueAt: String; let title: String; let conversationTitle: String?
}
struct CommunityReminders: Decodable { let reminders: [CommunityReminder] }
struct CommunityScheduled: Decodable, Identifiable {
    let id: String; let conversationId: String; let conversationTitle: String?; let content: String
    let sendAt: String; let failedAt: String?; let failure: String?
}
struct CommunitySchedule: Decodable { let messages: [CommunityScheduled] }
struct SavedCollection: Decodable, Identifiable { let id: String; var name: String; let count: Int }
struct SavedCollections: Decodable { let collections: [SavedCollection] }
struct CollectionItem: Decodable, Identifiable {
    var id: String { messageId }
    let messageId: String; let conversationId: String; let conversationTitle: String?; let seq: Int64
    let content: String; let sender: String; let savedAt: String; let collectionId: String?; let note: String
}
struct CollectionItems: Decodable { let items: [CollectionItem] }
struct SavedDetails: Decodable { let collectionId: String?; let note: String }
struct CommunityProfile: Decodable {
    var tags: [String]?; var language: String?; var welcome: String?; var rules: String?; var startChannelId: String?
}
struct WelcomeChannel: Decodable, Identifiable { let id: String; let title: String? }
struct CommunityWelcome: Decodable { let profile: CommunityProfile; let seen: Bool; let canManage: Bool; let channels: [WelcomeChannel] }

extension YappyRepository {
    func community<T: Decodable>(_ path: String, query: [String: String?] = [:]) async throws -> T {
        try await api.get("/community" + path, query: query)
    }
    func changeCommunity(_ method: String, _ path: String, _ body: JSONValue? = nil) async throws {
        try await api.send(method, "/community" + path, body: body)
    }
}

enum CommunityTime {
    static func date(_ value: String) -> Date {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let result = formatter.date(from: value) { return result }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value) ?? .distantPast
    }
    static func label(_ value: String) -> String { date(value).formatted(date: .abbreviated, time: .shortened) }
    static func wire(_ value: Date) -> String { ISO8601DateFormatter().string(from: value) }
}
