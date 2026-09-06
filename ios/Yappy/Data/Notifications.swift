import Foundation

/// The notice's payload is a snapshot, so history survives a renamed or deleted group.
struct NotificationEntry: Codable, Identifiable {
    let id: String
    var kind: String
    var actor: PublicUser?
    var targetType: String?
    var targetId: String?
    var data: [String: JSONValue] = [:]
    var count: Int = 1
    var readAt: String?
    var createdAt: String

    func text(_ key: String) -> String? { data[key]?.stringValue }

    enum CodingKeys: String, CodingKey {
        case id, kind, actor, targetType, targetId, data, count, readAt, createdAt
    }
}

extension NotificationEntry {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // Without an identity this cannot safely participate in a SwiftUI list.
        id = try c.decode(String.self, forKey: .id)
        kind = c.get(.kind, "")
        actor = c.opt(.actor)
        targetType = c.opt(.targetType)
        targetId = c.opt(.targetId)
        data = c.get(.data, [:])
        count = c.get(.count, 1)
        readAt = c.opt(.readAt)
        createdAt = c.get(.createdAt, "")
    }
}

struct NotificationsEnvelope: Codable {
    var notifications: [NotificationEntry] = []
    var nextCursor: String?

    enum CodingKeys: String, CodingKey { case notifications, nextCursor }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        notifications = c.list(.notifications)
        nextCursor = c.opt(.nextCursor)
    }
}
