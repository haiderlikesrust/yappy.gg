import SwiftUI

enum DetailTarget: Hashable, Identifiable {
    case profile(String, inConversation: String?)
    case group(String)

    var id: String {
        switch self {
        case .profile(let id, let context): return "person:\(id):\(context ?? "")"
        case .group(let id): return "group:\(id)"
        }
    }
}

/// Keeps the underlying chat in place while a person explores its people.
struct DetailSheet: View {
    @Environment(\.neu) private var colors
    let target: DetailTarget
    let onClose: () -> Void
    let onNavigate: (Route) -> Void
    @State private var path: [DetailTarget] = []

    var body: some View {
        NavigationStack(path: $path) {
            screen(target, root: true)
                .navigationDestination(for: DetailTarget.self) { screen($0, root: false) }
        }
        .tint(colors.accent)
    }

    @ViewBuilder
    private func screen(_ target: DetailTarget, root: Bool) -> some View {
        switch target {
        case .profile(let id, let context):
            ProfileScreen(userId: id, onBack: { close(root) },
                          onOpenChat: { onNavigate(.chat($0)) }, inConversation: context,
                          isSheet: true, isSheetRoot: root)
                .neuBackdrop(colors)
        case .group(let id):
            GroupScreen(conversationId: id, onBack: { close(root) },
                        onOpenProfile: { path.append(.profile($0, inConversation: id)) },
                        onOpenCall: { onNavigate(.call($0)) },
                        onOpenSettings: { onNavigate(.groupSettings($0)) },
                        isSheet: true, onOpenConversation: onNavigate)
                .neuBackdrop(colors)
        }
    }

    private func close(_ root: Bool) {
        if root { onClose() }
        else if !path.isEmpty { path.removeLast() }
    }
}
