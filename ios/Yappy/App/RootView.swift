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
    case settingsSection(SettingsPage)
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
    case community
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
        .sheet(item: $container.sessionNotice) { notice in
            ThemedSheet {
                NotificationDetailsView(
                    kind: "account_suspended", title: notice.title, bodyText: notice.body,
                    detail: notice.detail, until: notice.until, supportUrl: notice.supportUrl,
                    onDismiss: { container.sessionNotice = nil }
                )
            }
        }
    }
}

private struct SignedInNav: View {
    @Environment(\.neu) private var colors
    @EnvironmentObject private var container: AppContainer
    @State private var selectedTab: MainTab = .chats
    @State private var paths: [MainTab: [Route]] = [:]
    @State private var detailTarget: DetailTarget?
    @State private var afterDetails: PendingNavigation?
    @State private var presentedCall: PresentedCall?
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
    /**
     * The namespace both halves of a zoom transition share.
     *
     * Declared at the stack rather than per-screen because that is the only
     * scope that contains both the row being tapped and the screen it becomes.
     * Handed down through the environment — see `Motion.swift` for why not
     * through initialisers.
     */
    @Namespace private var zoom

    init(container: AppContainer) {
        _whatsNew = StateObject(wrappedValue: WhatsNewGate(store: container.session, repo: container.repo))
    }

    var body: some View {
        tabs
            .onAppear { consumeLink() }
            .task {
                await whatsNew.check()
                // Decided once, here, rather than continuously in a binding:
                // the sheet should reflect the moment the notes arrived, not
                // re-open itself later because the stack happened to empty.
                whatsNewOpen = !whatsNew.pending.isEmpty
                    && selectedTab == .chats && (paths[.chats] ?? []).isEmpty
                    && detailTarget == nil && inviteCode == nil
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
                        selectedTab = .chats
                        push(.chat(banner.conversationId), in: .chats)
                    }
                    .transition(.move(edge: .top).combined(with: .opacity))
                    // A banner announces; it does not insist. Flicking it
                    // upward past ~30pt dismisses it right now instead of
                    // making the person wait out the four-second timer, and
                    // acting in `onChanged` means it leaves under the finger
                    // rather than after the release.
                    .gesture(
                        DragGesture(minimumDistance: 12)
                            .onChanged { value in
                                guard value.translation.height < -30 else { return }
                                bannerDismiss?.cancel()
                                self.banner = nil
                            }
                    )
                }
            }
            // A spring rather than a curve: the card arrives with a little
            // weight, matching how it can now be thrown away.
            .animation(.spring(response: 0.42, dampingFraction: 0.78), value: banner?.id)
            .onChange(of: container.pendingLink) { _, _ in consumeLink() }
            // CallKit owns ringing — lock screen, banner, and full-screen UI
            // are all the system's. What is left for the app is opening the
            // call screen once an answer has connected it.
            .onChange(of: callSystem.openCallId) { _, id in
                guard let id else { return }
                callSystem.openCallId = nil
                presentCall(id)
            }
            .onChange(of: callSystem.activeCallId) { old, next in
                if old != nil, next == nil { presentedCall = nil }
            }
            .onChange(of: callSystem.endedCallId) { _, id in
                if presentedCall?.id == id { presentedCall = nil }
            }
            .sheet(item: $detailTarget, onDismiss: finishDetailNavigation) { target in
                DetailSheet(target: target, onClose: { detailTarget = nil }, onNavigate: { route in
                    afterDetails = PendingNavigation(tab: selectedTab, route: route)
                    detailTarget = nil
                })
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
                .presentationContentInteraction(.resizes)
                .presentationCornerRadius(30)
                .presentationBackground(colors.surface)
            }
            .fullScreenCover(item: $presentedCall) { call in
                ThemedSheet {
                    CallScreen(engine: container.callEngine, callId: call.id,
                               onLeave: { presentedCall = nil }, onMinimize: { presentedCall = nil })
                }
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
                        selectedTab = .chats
                        push(isSpace ? .space(id) : .chat(id), in: .chats)
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
            // The card slides in with a touch to match — the physical half of
            // the same announcement.
            Haptics.tap()

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
        afterDetails = nil

        switch link {
        case .conversation(let id):
            // Replace rather than stack: tapping three notifications should not
            // leave three chats piled on the back stack.
            detailTarget = nil
            selectedTab = .chats
            paths[.chats] = [.chat(id)]
        case .invite(let code):
            inviteCode = code
        case .user(let id):
            // A scanned profile QR. Straight to the person, where Follow lives.
            detailTarget = .profile(id, inConversation: nil)
        }
    }

    private var tabs: some View {
        TabView(selection: $selectedTab) {
            tabStack(.chats)
                .tabItem { Label("Chats", systemImage: "bubble.left.and.bubble.right") }
                .tag(MainTab.chats)
            tabStack(.explore)
                .tabItem { Label("Explore", systemImage: "safari") }
                .tag(MainTab.explore)
            tabStack(.you)
                .tabItem { Label("You", systemImage: "person.crop.circle") }
                .tag(MainTab.you)
        }
        // System tabs adopt the installed iOS appearance, including Liquid
        // Glass on supported systems, without recreating it in custom views.
        .tint(colors.accent)
    }

    private func tabStack(_ tab: MainTab) -> some View {
        NavigationStack(path: Binding(
            get: { paths[tab] ?? [] },
            set: { paths[tab] = $0 }
        )) {
            tabRoot(tab)
                .neuBackdrop(colors)
                .navigationDestination(for: Route.self) { route in
                    destination(route, in: tab).neuBackdrop(colors)
                        // The tab bar belongs to the three roots. Left visible
                        // on a push it sat on top of the chat composer and cut
                        // the last message in half — and it was offering to
                        // switch tabs on a screen whose own back button is the
                        // way out.
                        .toolbar(.hidden, for: .tabBar)
                }
        }
        .environment(\.zoomNamespace, zoom)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if Feature.calling, callSystem.activeCallId != nil, presentedCall == nil {
                CallMiniPlayer(engine: container.callEngine, onOpen: presentCall)
            }
        }
    }

    @ViewBuilder
    private func tabRoot(_ tab: MainTab) -> some View {
        switch tab {
        case .chats:
            ConversationsScreen(
                onOpenChat: { push(.chat($0), in: tab) },
                onOpenSpace: { push(.space($0), in: tab) },
                onNewChat: { push(.newChat, in: tab) },
                onOpenMentions: { push(.mentions, in: tab) },
                onCatchUp: { push(.community, in: tab) },
                onOpenProfile: { detailTarget = .profile($0, inConversation: nil) }
            )
        case .explore:
            ExploreScreen(onBack: {}, onOpenChat: { push(.chat($0), in: tab) },
                          onStartGroup: { push(.newChat, in: tab) }, isTabRoot: true)
        case .you:
            SettingsScreen(onBack: {}, onOpenAbout: { push(.about, in: tab) }, isTabRoot: true,
                           onOpenSection: { push(.settingsSection($0), in: tab) })
        }
    }

    @ViewBuilder
    private func destination(_ route: Route, in tab: MainTab) -> some View {
        switch route {
        case .chat(let id, let focusSeq):
            ChatScreen(
                conversationId: id, onBack: { pop(in: tab) }, focusSeq: focusSeq,
                onOpenProfile: { detailTarget = .profile($0, inConversation: id) },
                onOpenGroup: { detailTarget = .group($0) },
                onOpenCall: presentCall,
                onOpenThread: { push(.thread(conversationId: id, rootId: $0), in: tab) },
                onOpenChannel: { if $0 != id { push(.chat($0), in: tab) } },
                onOpenSpace: { spaceId in
                    var path = paths[tab] ?? []
                    if let index = path.lastIndex(of: .space(spaceId)), index < path.count - 1 {
                        path.removeSubrange((index + 1)...)
                        paths[tab] = path
                    } else { replaceTop(with: .space(spaceId), in: tab) }
                }
            )
            // Keep standard back navigation: zoom's dismissal gesture fights
            // a timeline while it is pinned against its scrolling boundary.
        case .thread(let id, let rootId):
            ThreadScreen(conversationId: id, rootId: rootId, onBack: { pop(in: tab) })
        case .newChat:
            NewChatScreen(onBack: { pop(in: tab) }, onOpenChat: { replaceTop(with: .chat($0), in: tab) })
        case .about:
            AboutScreen(onBack: { pop(in: tab) })
        case .settings:
            SettingsScreen(onBack: { pop(in: tab) }, onOpenAbout: { push(.about, in: tab) },
                           onOpenSection: { push(.settingsSection($0), in: tab) })
        case .settingsSection(let page):
            SettingsScreen(onBack: { pop(in: tab) }, page: page)
        case .profile(let id, let context):
            ProfileScreen(userId: id, onBack: { pop(in: tab) },
                          onOpenChat: { push(.chat($0), in: tab) }, inConversation: context)
        case .group(let id):
            GroupScreen(conversationId: id, onBack: { pop(in: tab) },
                        onOpenProfile: { detailTarget = .profile($0, inConversation: id) },
                        onOpenCall: presentCall, onOpenSettings: { push(.groupSettings($0), in: tab) },
                        onOpenConversation: { push($0, in: tab) })
        case .groupSettings(let id):
            GroupSettingsScreen(conversationId: id, onBack: { pop(in: tab) },
                                onOpenAudit: { push(.audit(id), in: tab) })
        case .call(let id):
            CallScreen(engine: container.callEngine, callId: id,
                       onLeave: { pop(in: tab) }, onMinimize: { pop(in: tab) })
        case .space(let id):
            SpaceScreen(spaceId: id, onBack: { pop(in: tab) },
                        onOpenChannel: { push(.chat($0), in: tab) },
                        onOpenMembers: { detailTarget = .group(id) },
                        onOpenSettings: { push(.groupSettings(id), in: tab) })
                .zoomDestination(.space(id))
        case .explore:
            ExploreScreen(onBack: { pop(in: tab) },
                          onOpenChat: { replaceTop(with: .chat($0), in: tab) },
                          onStartGroup: { push(.newChat, in: tab) })
        case .audit(let id):
            AuditLogScreen(conversationId: id, onBack: { pop(in: tab) })
        case .mentions:
            MentionsScreen(onBack: { pop(in: tab) }, onOpenMessage: { id, seq in
                replaceTop(with: .chat(id, at: seq), in: tab)
            }, onOpenGroup: { detailTarget = .group($0) },
               onOpenProfile: { detailTarget = .profile($0, inConversation: nil) })
        case .community:
            CommunityScreen(onOpenMessage: { id, seq in push(.chat(id, at: seq), in: tab) }, onOpenGroup: { detailTarget = .group($0) })
        }
    }

    private func push(_ route: Route, in tab: MainTab) {
        paths[tab, default: []].append(route)
    }

    private func pop(in tab: MainTab) {
        guard !(paths[tab] ?? []).isEmpty else { return }
        paths[tab]?.removeLast()
    }

    private func replaceTop(with route: Route, in tab: MainTab) {
        pop(in: tab)
        push(route, in: tab)
    }

    private func presentCall(_ id: String) {
        guard Feature.calling else { return }
        if detailTarget != nil {
            afterDetails = PendingNavigation(tab: selectedTab, route: .call(id))
            detailTarget = nil
        } else {
            presentedCall = PresentedCall(id: id)
        }
    }

    private func finishDetailNavigation() {
        guard let pending = afterDetails else { return }
        afterDetails = nil
        selectedTab = pending.tab
        if case .call(let id) = pending.route { presentCall(id) }
        else if paths[pending.tab]?.last != pending.route { push(pending.route, in: pending.tab) }
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
        NeuBackdrop(colors: scheme == .dark ? NeuColors.dark : NeuColors.light)
    }
}

private enum MainTab: Hashable { case chats, explore, you }
private struct PendingNavigation { let tab: MainTab; let route: Route }
private struct PresentedCall: Identifiable { let id: String }
