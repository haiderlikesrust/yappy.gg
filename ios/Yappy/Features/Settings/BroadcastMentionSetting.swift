import SwiftUI

enum BroadcastMentionPolicy {
    static let preferenceKey = "broadcastMentions"

    static func suppresses(_ message: JSONValue, for userId: String, preferences: JSONValue?, level: String) -> Bool {
        // On "all", a broadcast is still an ordinary message.
        guard level == "mentions", preferences?[preferenceKey]?.boolValue == false,
              case .array(let entities)? = message["entities"] else { return false }
        // A personal mention takes priority when a message also calls the room.
        if entities.contains(where: { $0["type"]?.stringValue == "mention" && $0["userId"]?.stringValue == userId }) { return false }
        return entities.contains { ["mention_all", "mention_role"].contains($0["type"]?.stringValue ?? "") }
    }
}

struct BroadcastMentionSetting: View {
    @Environment(\.neu) private var colors
    @EnvironmentObject private var container: AppContainer
    @State private var saving = false
    @State private var error: String?

    private var enabled: Bool { container.me?.notifications?[BroadcastMentionPolicy.preferenceKey]?.boolValue ?? true }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Toggle(isOn: Binding(get: { enabled }, set: save)) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Broadcast mentions").font(YappyFont.bodyMedium)
                    Text("Off: @everyone and role mentions arrive as ordinary messages on All, and stay quiet on Mentions. Your own name still notifies you.")
                        .font(YappyFont.labelSmall).foregroundStyle(colors.textSecondary)
                }
            }
            .tint(colors.accent)
            .disabled(saving || container.me == nil)
            if saving { ProgressView("Saving…").font(YappyFont.labelSmall) }
            if let error {
                Text(error).font(YappyFont.labelSmall).foregroundStyle(colors.textSecondary)
            }
        }
        .padding(14)
    }

    private func save(_ next: Bool) {
        guard !saving else { return }
        saving = true; error = nil
        Task {
            defer { saving = false }
            do {
                let user = try await container.repo.updateNotificationFlag(BroadcastMentionPolicy.preferenceKey, next).user
                guard container.session.userId == user.id else { return }
                guard user.notifications?[BroadcastMentionPolicy.preferenceKey]?.boolValue == next else {
                    error = "This setting isn’t available on the server yet. Your preference hasn’t changed."
                    return
                }
                container.setMe(user)
                await container.refreshBadge()
            } catch { self.error = "Couldn’t save. Try the switch again when you’re connected." }
        }
    }
}
