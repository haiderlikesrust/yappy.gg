import Combine
import UIKit

/// Home-screen quick actions use pinned conversations first, then recent ones.
/// The account id prevents a stale launcher item from opening another account's chat.
@MainActor
final class ConversationShortcuts: ObservableObject {
    static let shared = ConversationShortcuts()
    struct Request {
        let userId: String
        let link: DeepLink
    }
    @Published var pending: Request?

    func update(_ conversations: [Conversation], userId: String) {
        let sorted = conversations.sorted {
            let left = $0.selfState?.isPinned == true
            let right = $1.selfState?.isPinned == true
            if left != right { return left }
            if $0.lastMessageAt != $1.lastMessageAt { return ($0.lastMessageAt ?? "") > ($1.lastMessageAt ?? "") }
            return $0.id < $1.id
        }
        UIApplication.shared.shortcutItems = sorted.prefix(4).map { conversation in
            UIApplicationShortcutItem(
                type: "gg.yappy.app.conversation",
                localizedTitle: conversation.displayName,
                localizedSubtitle: conversation.isSpace ? "Open place" : "Open conversation",
                icon: UIApplicationShortcutIcon(systemImageName: conversation.type == "dm" ? "person.fill" : "person.2.fill"),
                userInfo: ["id": conversation.id as NSString, "userId": userId as NSString,
                           "kind": (conversation.isSpace ? "space" : "conversation") as NSString]
            )
        }
    }

    @discardableResult
    func open(_ item: UIApplicationShortcutItem) -> Bool {
        guard item.type == "gg.yappy.app.conversation",
              let id = item.userInfo?["id"] as? String, !id.isEmpty,
              let userId = item.userInfo?["userId"] as? String else { return false }
        pending = Request(userId: userId, link: item.userInfo?["kind"] as? String == "space"
                          ? .space(id) : .conversation(id))
        return true
    }

    func clear() {
        UIApplication.shared.shortcutItems = []
        pending = nil
    }
}

final class ShortcutSceneDelegate: NSObject, UIWindowSceneDelegate {
    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        if let item = options.shortcutItem { ConversationShortcuts.shared.open(item) }
    }

    func windowScene(_ windowScene: UIWindowScene, performActionFor shortcutItem: UIApplicationShortcutItem,
                     completionHandler: @escaping (Bool) -> Void) {
        completionHandler(ConversationShortcuts.shared.open(shortcutItem))
    }
}
