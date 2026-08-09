import SwiftUI

/// Every destination the signed-in stack can reach.
///
/// An enum rather than string routes: a typo in `"chat/\(id)"` is a runtime
/// blank screen, whereas a missing case here does not compile.
enum Route: Hashable {
    case chat(String)
    case thread(conversationId: String, rootId: String)
    case newChat
    case settings
    case profile(String)
    case group(String)
    case groupSettings(String)
    case call(String)
    case space(String)
    case explore
}

struct RootView: View {
    @EnvironmentObject private var container: AppContainer

    var body: some View {
        ThemedSheet {
            switch container.signedIn {
            case .none:
                // Still reading the stored token. A spinner rather than a flash
                // of the sign-in screen, which is what users of a logged-in app
                // notice.
                NeuSpinner()

            case .some(false):
                AuthFlow { container.onAuthenticated() }
                    .transition(.opacity)

            case .some(true):
                SignedInNav()
                    .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.22), value: container.signedIn)
    }
}

private struct SignedInNav: View {
    @EnvironmentObject private var container: AppContainer
    @State private var path: [Route] = []
    @State private var inviteCode: String?

    var body: some View {
        stack
            .onAppear { consumeLink() }
            .onChange(of: container.pendingLink) { _, _ in consumeLink() }
            .sheet(item: Binding(
                get: { inviteCode.map(InviteCode.init) },
                set: { inviteCode = $0?.value }
            )) { code in
                InviteSheet(
                    code: code.value,
                    onJoined: { id, isSpace in
                        inviteCode = nil
                        // A space has no messages of its own; opening it as a
                        // chat lands on a permanently empty timeline with a
                        // composer, and the only way out is to back up and find
                        // the space in the list.
                        path.append(isSpace ? .space(id) : .chat(id))
                    },
                    onDismiss: { inviteCode = nil }
                )
                .presentationDetents([.medium])
                .presentationBackground(Color(.clear))
                .background(ThemedSheetBackground())
            }
    }

    /// Links can land before this view exists — a cold start from a tapped
    /// notification does — so the pending link is read on appear as well as on
    /// change, and cleared once acted on.
    private func consumeLink() {
        guard let link = container.pendingLink else { return }
        container.pendingLink = nil

        switch link {
        case .conversation(let id):
            // Replace rather than stack: tapping three notifications should not
            // leave three chats piled on the back stack.
            path = [.chat(id)]
        case .invite(let code):
            inviteCode = code
        }
    }

    private var stack: some View {
        NavigationStack(path: $path) {
            ConversationsScreen(
                // A space has no timeline of its own, so tapping it opens its
                // channel list rather than a chat with nothing in it.
                onOpenChat: { path.append(.chat($0)) },
                onOpenSpace: { path.append(.space($0)) },
                onNewChat: { path.append(.newChat) },
                onSettings: { path.append(.settings) },
                onExplore: { path.append(.explore) }
            )
            .navigationDestination(for: Route.self) { route in
                destination(route)
            }
        }
        .tint(.accentColor)
    }

    @ViewBuilder
    private func destination(_ route: Route) -> some View {
        switch route {
        case .chat(let id):
            ChatScreen(
                conversationId: id,
                onBack: pop,
                onOpenProfile: { path.append(.profile($0)) },
                onOpenGroup: { path.append(.group($0)) },
                onOpenCall: { path.append(.call($0)) },
                onOpenThread: { path.append(.thread(conversationId: id, rootId: $0)) }
            )

        case .thread(let conversationId, let rootId):
            ThreadScreen(conversationId: conversationId, rootId: rootId, onBack: pop)

        case .newChat:
            NewChatScreen(onBack: pop, onOpenChat: { replaceTop(with: .chat($0)) })

        case .settings:
            SettingsScreen(onBack: pop)

        case .profile(let id):
            ProfileScreen(userId: id, onBack: pop, onOpenChat: { path.append(.chat($0)) })

        case .group(let id):
            GroupScreen(
                conversationId: id,
                onBack: pop,
                onOpenProfile: { path.append(.profile($0)) },
                onOpenCall: { path.append(.call($0)) },
                onOpenSettings: { path.append(.groupSettings($0)) }
            )

        case .groupSettings(let id):
            GroupSettingsScreen(conversationId: id, onBack: pop)

        case .call(let id):
            CallScreen(callId: id, onLeave: pop)

        case .space(let id):
            SpaceScreen(
                spaceId: id,
                onBack: pop,
                onOpenChannel: { path.append(.chat($0)) },
                // A space's people and settings are the group screens: the
                // membership and roles genuinely are the same objects.
                onOpenMembers: { path.append(.group(id)) },
                onOpenSettings: { path.append(.groupSettings(id)) }
            )

        case .explore:
            ExploreScreen(onBack: pop, onOpenChat: { replaceTop(with: .chat($0)) })
        }
    }

    private func pop() {
        guard !path.isEmpty else { return }
        path.removeLast()
    }

    /// Used where a screen's job is to *produce* a conversation — the new-chat
    /// picker and Explore. Leaving them on the stack means Back from the chat
    /// lands on a picker the user is done with.
    private func replaceTop(with route: Route) {
        if !path.isEmpty { path.removeLast() }
        path.append(route)
    }
}

/// `sheet(item:)` needs an `Identifiable`; a bare code string is not one.
private struct InviteCode: Identifiable {
    let value: String
    var id: String { value }

    init(_ value: String) { self.value = value }
}

/// A sheet is its own presentation context and does not inherit the sheet
/// colour, so it paints the surface itself.
private struct ThemedSheetBackground: View {
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        (scheme == .dark ? NeuColors.dark : NeuColors.light).surface
            .ignoresSafeArea()
    }
}
