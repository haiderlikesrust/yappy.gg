import Foundation

/// Just enough of a conversation to draw its header on the first frame.
///
/// Opening a chat fetches the conversation, and until that lands the header has
/// nothing to show — which is why moving between channels flashed "…" and then
/// the real name, once per hop. The list that sent you here already knew the
/// name, so it leaves it behind.
///
/// Deliberately not a `Conversation`: a channel row in a space is a
/// `ChannelEntry`, not a conversation, and inventing a half-populated
/// `Conversation` from one would put a fake object into a cache that other code
/// could mistake for real.
struct ChatHeaderSeed: Equatable {
    var title: String
    var avatarUrl: String?
    var avatarSeed: String
    var badge: String?
    var appearance: ConversationAppearance?
    var subtitle: String?
    var isGroup: Bool
}

/// Seeds the app has picked up while showing lists.
///
/// Not `@Published`: this is read once when a chat opens, and republishing it on
/// every conversation-list refresh would redraw every screen observing the
/// container for something none of them display.
@MainActor
final class HeaderSeedCache {
    private var seeds: [String: ChatHeaderSeed] = [:]

    subscript(id: String) -> ChatHeaderSeed? { seeds[id] }

    func remember(_ conversation: Conversation) {
        seeds[conversation.id] = ChatHeaderSeed(
            title: conversation.displayName,
            avatarUrl: conversation.displayAvatar,
            avatarSeed: conversation.avatarSeed,
            badge: conversation.type == "dm" ? conversation.otherUser?.badge : conversation.badge,
            appearance: conversation.appearance,
            subtitle: Self.subtitle(for: conversation),
            isGroup: conversation.type != "dm"
        )
    }

    func remember(_ conversations: [Conversation]) {
        for conversation in conversations { remember(conversation) }
    }

    /// A channel inherits its space's look: the avatar, the flair and the badge
    /// all belong to the place, and a channel that dropped them would look like
    /// a different room for the half-second before its own fetch returns.
    func remember(channel: ChannelEntry, in space: Conversation) {
        seeds[channel.id] = ChatHeaderSeed(
            title: channel.title ?? "channel",
            avatarUrl: space.displayAvatar,
            avatarSeed: space.avatarSeed,
            badge: space.badge,
            appearance: space.appearance,
            subtitle: "in \(space.displayName) · \(space.memberCount) members",
            isGroup: true
        )
    }

    private static func subtitle(for conversation: Conversation) -> String? {
        if conversation.type == "dm" {
            return conversation.otherUser?.username.map { "@\($0)" }
        }
        if let parent = conversation.parentTitle {
            return "in \(parent) · \(conversation.memberCount) members"
        }
        return "\(conversation.memberCount) members"
    }
}
