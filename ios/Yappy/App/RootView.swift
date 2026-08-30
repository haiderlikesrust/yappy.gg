import AudioToolbox
import Combine
import SwiftUI

/// Every destination the signed-in stack can reach.
///
/// An enum rather than string routes: a typo in `"chat/\(id)"` is a runtime
/// blank screen, whereas a missing case here does not compile.
enum Route: Hashable {
    /// `at` is a message seq to land on, when the caller knows which one it
    /// means — the mentions inbox. Without it the chat opens where it always
    /// did, at the newest message.
    case chat(String, at: Int64? = nil)
    case thread(conversationId: String, rootId: String)
    case newChat
    case settings
    case about
    /// The second value is the conversation the profile was opened from,
    /// when there was one. With it the card can also show what that group
    /// knows about the person — their roles there — which is the half
    /// `GET /users/:id` has never had, because it knows about no group.
    case profile(String, inConversation: String? = nil)
    case group(String)
    case groupSettings(String)
    case call(String)
    case space(String)
    case explore
    case mentions
    case audit(String)
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
    /// Rings, answers, and the system call UI all live in CallSystem now —
    /// this view only navigates to the call it says to open.
    @ObservedObject private var callSystem = CallSystem.shared
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
                    && path.isEmpty && inviteCode == nil
                    && callSystem.ringingCallId == nil && callSystem.activeCallId == nil
            }
            .onAppear(perform: observeBanners)
            .onDisappear {
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
            // CallKit owns ringing — lock screen, banner, and full-screen UI
            // are all the system's. What is left for the app is opening the
            // call screen once an answer has connected it.
            .onChange(of: callSystem.openCallId) { _, id in
                guard let id else { return }
                callSystem.openCallId = nil
                if path.last != .call(id) { path.append(.call(id)) }
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

    // ── In-app notifications ─────────────────────────────────────────────

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
        case .user(let id):
            // A scanned profile QR. Straight to the person, where Follow lives.
            path.append(.profile(id))
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
                onExplore: { path.append(.explore) },
                onOpenMentions: { path.append(.mentions) },
                // "People on yappy" search results open the person directly.
                onOpenProfile: { path.append(.profile($0)) }
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
        case .chat(let id, let focusSeq):
            ChatScreen(
                conversationId: id,
                focusSeq: focusSeq,
                onBack: pop,
                // Carrying the room along: a profile opened from a chat can
                // then say what this group knows about them.
                onOpenProfile: { path.append(.profile($0, inConversation: id)) },
                onOpenGroup: { path.append(.group($0)) },
                onOpenCall: { path.append(.call($0)) },
                onOpenThread: { path.append(.thread(conversationId: id, rootId: $0)) },
                // The space is almost always already underneath this channel
                // in the stack — popping back to it is what "out" means, and
                // it reuses the loaded screen instead of pushing a second copy
                // (which is what made Back need two presses). Replace only
                // when the chat arrived with no space beneath it: a deep link.
                onOpenSpace: { id in
                    if let index = path.lastIndex(of: .space(id)), index < path.count - 1 {
                        path.removeSubrange((index + 1)...)
                    } else {
                        replaceTop(with: .space(id))
                    }
                }
            )

        case .thread(let conversationId, let rootId):
            ThreadScreen(conversationId: conversationId, rootId: rootId, onBack: pop)

        case .newChat:
            NewChatScreen(onBack: pop, onOpenChat: { replaceTop(with: .chat($0)) })

        case .about:
            AboutScreen(onBack: pop)

        case .settings:
            SettingsScreen(onBack: pop, onOpenAbout: { path.append(.about) })

        case .profile(let id, let inConversation):
            ProfileScreen(
                userId: id,
                onBack: pop,
                onOpenChat: { path.append(.chat($0)) },
                inConversation: inConversation
            )

        case .group(let id):
            GroupScreen(
                conversationId: id,
                onBack: pop,
                // The member list is the other place a profile is opened
                // from a room, and it should say the same about them.
                onOpenProfile: { path.append(.profile($0, inConversation: id)) },
                onOpenCall: { path.append(.call($0)) },
                onOpenSettings: { path.append(.groupSettings($0)) }
            )

        case .groupSettings(let id):
            GroupSettingsScreen(
                conversationId: id,
                onBack: pop,
                // The audit log is a page of its own — a log is something
                // you scroll, and a sheet is for a glance.
                onOpenAudit: { path.append(.audit(id)) }
            )

        case .call(let id):
            CallScreen(engine: container.callEngine, callId: id, onLeave: pop)

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
            ExploreScreen(
                onBack: pop,
                onOpenChat: { replaceTop(with: .chat($0)) },
                onStartGroup: { path.append(.newChat) }
            )

        case .audit(let id):
            AuditLogScreen(conversationId: id, onBack: pop)

        case .mentions:
            MentionsScreen(
                onBack: pop,
                // Replacing rather than pushing: the inbox is a signpost, and
                // nobody wants to walk back through it out of a conversation.
                onOpenMessage: { conversationId, seq in
                    replaceTop(with: .chat(conversationId, at: seq))
                }
            )
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
