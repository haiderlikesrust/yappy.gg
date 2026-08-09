import Combine
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
    /// The call currently ringing this device, if any. Item-driven so the
    /// cover dismisses itself the moment the ring is cleared.
    @State private var ringing: Call?
    @State private var ringListener: AnyCancellable?
    @State private var ringExpiry: Task<Void, Never>?

    var body: some View {
        stack
            .onAppear { consumeLink() }
            .onAppear(perform: observeCalls)
            .onDisappear {
                ringListener?.cancel()
                ringExpiry?.cancel()
            }
            .onChange(of: container.pendingLink) { _, _ in consumeLink() }
            .fullScreenCover(item: $ringing) { call in
                IncomingCallScreen(
                    call: call,
                    onAccept: {
                        ringExpiry?.cancel()
                        ringing = nil
                        path.append(.call(call.id))
                    },
                    onDecline: {
                        ringExpiry?.cancel()
                        ringing = nil
                        Task { _ = try? await container.repo.declineCall(call.id) }
                    }
                )
            }
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

    // ── Incoming calls ───────────────────────────────────────────────────────

    /**
     * The gateway rings; this answers.
     *
     * `call.ring` is delivered to each invitee's user topic and, until this
     * listener, iOS dropped it on the floor — an incoming call was a push
     * banner if notifications happened to be set up, and nothing at all with
     * the app open. The payload is the hydrated call, so it decodes as the
     * same `Call` the call screen uses.
     */
    private func observeCalls() {
        guard ringListener == nil else { return }
        ringListener = container.gateway.events.sink { event in
            switch event.type {
            case "call.ring":
                guard let payload = try? JSONEncoder().encode(event.data),
                      let call = try? JSONDecoder().decode(Call.self, from: payload),
                      !call.id.isEmpty
                else { return }
                // Never ring the person who started it: their own devices are
                // not invitees today, but a payload bug must not produce a
                // phone that rings itself.
                guard call.initiatorId != container.session.userId else { return }
                ringing = call
                armRingExpiry(call)

            // The caller hung up, everyone declined, or the ring timed out
            // server-side. The cover must not outlive the call it offers.
            case "call.end":
                guard let id = event.data["id"]?.stringValue, ringing?.id == id else { return }
                ringExpiry?.cancel()
                ringing = nil

            case "call.update":
                guard let id = event.data["id"]?.stringValue,
                      ringing?.id == id,
                      let state = event.data["state"]?.stringValue,
                      state == "ended"
                else { return }
                ringExpiry?.cancel()
                ringing = nil

            default:
                break
            }
        }
    }

    /// Stop ringing at the server's deadline even if the end event is lost —
    /// the same absolute-deadline rule the protocol asks of clients.
    private func armRingExpiry(_ call: Call) {
        ringExpiry?.cancel()
        let deadline = YappyTime.parse(call.ringExpiresAt)
        let seconds = deadline.map { max(1, $0.timeIntervalSinceNow) } ?? 45
        ringExpiry = Task {
            try? await Task.sleep(for: .seconds(seconds))
            guard !Task.isCancelled else { return }
            if ringing?.id == call.id { ringing = nil }
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

/// Somebody is calling.
///
/// Deliberately spare: a face, a name, what kind of call, and the two answers.
/// Everything else a call screen owns — the roster, mute, the timer — belongs
/// to `CallScreen`, which Accept navigates into. This view's whole job is to
/// exist within a second of the ring event and be impossible to misread.
private struct IncomingCallScreen: View {
    @Environment(\.neu) private var colors

    let call: Call
    let onAccept: () -> Void
    let onDecline: () -> Void

    private var caller: PublicUser? {
        call.participants.first { $0.user.id == call.initiatorId }?.user
    }

    var body: some View {
        VStack(spacing: 0) {
            Spacer()

            Avatar(
                url: caller?.avatarUrl,
                name: caller?.displayName ?? caller?.username,
                id: caller?.id ?? call.id,
                size: 108
            )

            Text(caller?.displayName ?? caller?.username ?? "Unknown caller")
                .font(YappyFont.displaySmall)
                .foregroundStyle(colors.textPrimary)
                .padding(.top, 20)

            Text(call.mode == "video" ? "Incoming video call" : "Incoming call")
                .font(YappyFont.labelMedium)
                .foregroundStyle(colors.textSecondary)
                .padding(.top, 6)

            Spacer()

            HStack(spacing: 72) {
                answer(
                    label: "Decline",
                    icon: "phone.down.fill",
                    tint: colors.danger,
                    action: onDecline
                )
                answer(
                    label: "Accept",
                    icon: "phone.fill",
                    tint: colors.success,
                    action: onAccept
                )
            }
            .padding(.bottom, 64)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(colors.surface.ignoresSafeArea())
    }

    private func answer(label: String, icon: String, tint: Color, action: @escaping () -> Void) -> some View {
        VStack(spacing: 10) {
            Button(action: action) {
                Image(systemName: icon)
                    .font(.system(size: 26, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 72, height: 72)
                    .background(Circle().fill(tint))
            }
            .buttonStyle(.plain)

            Text(label)
                .font(YappyFont.labelMedium)
                .foregroundStyle(colors.textSecondary)
        }
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
