import AudioToolbox
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
    case about
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
                SignedInNav(container: container)
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
    /// The banner for a message that arrived while the person was elsewhere in
    /// the app. One at a time — a newer message replaces it rather than queueing
    /// behind it, because by the time a queue drained its contents would be old.
    @State private var banner: InAppBanner?
    @State private var bannerListener: AnyCancellable?
    @State private var bannerDismiss: Task<Void, Never>?
    /// Release notes. Owned here rather than in Settings so it can be shown
    /// once at the conversation list — never on top of a chat someone opened
    /// from a notification, and never while a call is ringing.
    @StateObject private var whatsNew: WhatsNewGate
    /// Real state, not a computed binding. A `Binding(get:set:)` handed to
    /// `isPresented` gets `set(false)` during ordinary reconciliation, and with
    /// `markSeen()` in that setter the release was marked read without the
    /// sheet ever appearing — the note was consumed and lost.
    @State private var whatsNewOpen = false

    init(container: AppContainer) {
        _whatsNew = StateObject(wrappedValue: WhatsNewGate(store: container.session, repo: container.repo))
    }

    var body: some View {
        stack
            .onAppear { consumeLink() }
            .task {
                await whatsNew.check()
                // Decided once, here, rather than continuously in a binding:
                // the sheet should reflect the moment the notes arrived, not
                // re-open itself later because the stack happened to empty.
                whatsNewOpen = !whatsNew.pending.isEmpty
                    && path.isEmpty && ringing == nil && inviteCode == nil
            }
            .onAppear(perform: observeCalls)
            .onAppear(perform: observeBanners)
            .onDisappear {
                ringListener?.cancel()
                ringExpiry?.cancel()
                bannerListener?.cancel()
                bannerDismiss?.cancel()
            }
            .overlay(alignment: .top) {
                if let banner {
                    InAppBannerView(banner: banner) {
                        bannerDismiss?.cancel()
                        self.banner = nil
                        path.append(.chat(banner.conversationId))
                    }
                    .transition(.move(edge: .top).combined(with: .opacity))
                }
            }
            .animation(.easeOut(duration: 0.25), value: banner?.id)
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
            // Only at the list, and only when nothing else is on screen. An
            // update note that covers an incoming call or a chat opened from a
            // notification is worse than one that waits for the next launch.
            .sheet(isPresented: $whatsNewOpen, onDismiss: { whatsNew.markSeen() }) {
                WhatsNewSheet(notes: whatsNew.pending)
                    .presentationDetents([.large])
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

    // ── In-app notifications ─────────────────────────────────────────────────

    /**
     * A message landed somewhere you are not looking.
     *
     * Socket-driven, not push-driven: it works with notification permission
     * denied, and it beats APNs by a second — which is why `PushService` now
     * keeps the system banner quiet for messages while the app is foreground,
     * or every message would announce itself twice.
     *
     * What suppresses it: your own messages, the chat currently on screen,
     * muted conversations (and mentions-only ones — a level that says "only
     * when someone names me" should not banner smalltalk), and the in-app
     * setting itself.
     */
    private func observeBanners() {
        guard bannerListener == nil else { return }
        bannerListener = container.gateway.events.sink { event in
            guard event.type == "message.create" else { return }
            let data = event.data

            guard let conversationId = data["conversationId"]?.stringValue,
                  let messageId = data["id"]?.stringValue,
                  let senderId = data["senderId"]?.stringValue,
                  senderId != container.session.userId,
                  conversationId != PushService.shared.foregroundConversationId
            else { return }

            let prefs = container.me?.notifications
            guard prefs?["inApp"]?.boolValue ?? true else { return }
            guard (container.notificationLevels[conversationId] ?? "all") == "all" else { return }

            let sender = data["sender"]?["displayName"]?.stringValue
                ?? data["sender"]?["username"]?.stringValue
                ?? "Someone"
            let seed = container.headerSeeds[conversationId]
            let isGroupish = seed != nil && seed?.title != sender

            let preview: String
            if prefs?["showPreview"]?.boolValue == false {
                preview = "New message"
            } else if let content = data["content"]?.stringValue, !content.isEmpty {
                preview = content
            } else if case .array(let attachments)? = data["attachments"], !attachments.isEmpty {
                preview = "Sent a photo"
            } else if data["stickerId"]?.stringValue != nil {
                preview = "Sent a sticker"
            } else if data["gif"]?["url"]?.stringValue != nil {
                preview = "Sent a GIF"
            } else {
                preview = "New message"
            }

            banner = InAppBanner(
                id: messageId,
                conversationId: conversationId,
                title: seed?.title ?? sender,
                body: isGroupish ? "\(sender): \(preview)" : preview,
                avatarUrl: data["sender"]?["avatarUrl"]?.stringValue ?? seed?.avatarUrl,
                avatarSeed: senderId
            )

            if prefs?["inAppSound"]?.boolValue ?? true {
                AudioServicesPlaySystemSound(1007)
            }

            bannerDismiss?.cancel()
            bannerDismiss = Task {
                try? await Task.sleep(for: .seconds(4))
                guard !Task.isCancelled else { return }
                if banner?.id == messageId { banner = nil }
            }
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
                onOpenThread: { path.append(.thread(conversationId: id, rootId: $0)) },
                // Replace rather than push: flicking between channels should
                // not build a back stack you have to unwind one chat at a time.
                onSwitchChannel: { replaceTop(with: .chat($0)) }
            )

        case .thread(let conversationId, let rootId):
            ThreadScreen(conversationId: conversationId, rootId: rootId, onBack: pop)

        case .newChat:
            NewChatScreen(onBack: pop, onOpenChat: { replaceTop(with: .chat($0)) })

        case .about:
            AboutScreen(onBack: pop)

        case .settings:
            SettingsScreen(onBack: pop, onOpenAbout: { path.append(.about) })

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

/// One in-app notification's worth of information.
private struct InAppBanner: Identifiable, Equatable {
    let id: String
    let conversationId: String
    let title: String
    let body: String
    let avatarUrl: String?
    let avatarSeed: String
}

/// The banner itself: a floating card at the top, shaped like the app rather
/// than like the system's — this is yappy speaking inside its own walls.
private struct InAppBannerView: View {
    @Environment(\.neu) private var colors

    let banner: InAppBanner
    let onTap: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Avatar(url: banner.avatarUrl, name: banner.title, id: banner.avatarSeed, size: 40)

            VStack(alignment: .leading, spacing: 2) {
                Text(banner.title)
                    .font(YappyFont.titleSmallBold)
                    .foregroundStyle(colors.textPrimary)
                    .lineLimit(1)
                Text(banner.body)
                    .font(YappyFont.bodyMedium)
                    .foregroundStyle(colors.textSecondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(colors.surfaceRaised)
                .shadow(color: .black.opacity(0.18), radius: 14, y: 6)
        )
        .padding(.horizontal, 12)
        .padding(.top, 6)
        .contentShape(Rectangle())
        .onTapGesture(perform: onTap)
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
struct ThemedSheetBackground: View {
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        (scheme == .dark ? NeuColors.dark : NeuColors.light).surface
            .ignoresSafeArea()
    }
}
