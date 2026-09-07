import SwiftUI

/// One left rail for the whole screen.
///
/// Chips, section headings, the active strip, cards and rows all measure from
/// the same edge. They used to measure from four different ones — 20 for the
/// chips, 24 for ACTIVE NOW, 26 for a card's avatar, 30 for PLACES — which is
/// the kind of thing nobody can name and everybody can see.
private enum Rail {
    static let side: CGFloat = 24
    /// The list's own inset; rows and cards add their content padding to it.
    static let list: CGFloat = 12
    /// `SectionLabel` carries six points of its own, inside the list's inset.
    static let label: CGFloat = side - list - 6
}

struct ConversationsScreen: View {
    @Environment(\.neu) private var colors
    @EnvironmentObject private var container: AppContainer
    @StateObject private var model = ConversationsModel()
    /// Home of the one lit chip capsule, so it can slide between chips
    /// instead of blinking out of one and into the next.
    @Namespace private var chipSlide

    let onOpenChat: (String) -> Void
    /// A space opens its channel list; it has no timeline of its own.
    let onOpenSpace: (String) -> Void
    let onNewChat: () -> Void
    /// Mentions and notices, in one notification inbox.
    var onOpenMentions: () -> Void = {}
    var onCatchUp: () -> Void = {}
    /// Where a "People on yappy" search result goes. Defaulted so the existing
    /// call site keeps compiling; RootView should pass its `.profile` route.
    var onOpenProfile: (String) -> Void = { _ in }

    var body: some View {
        VStack(spacing: 0) {
                // Not in the archive: it is already one filtered view, and
                // chips over it would be filters on a filter.
                if !model.showArchived {
                    filterChips
                        .padding(.horizontal, Rail.side)
                        .padding(.top, 4)
                }

                if !model.online.isEmpty, !model.showArchived {
                    activeNow
                        .padding(.top, 14)
                        .transition(.opacity)
                }

                content.padding(.top, 12)
            }
        .navigationTitle(model.showArchived ? "Archived" : "yappy")
        // Inline, because the title slot holds the lockup below. A large
        // "Chats" spent sixty points of a phone screen restating the tab that
        // is already lit at the bottom of it, and said nothing about whose
        // app this is.
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .navigationBar)
        .searchable(text: $model.query, prompt: "People, places and messages")
        .toolbar {
            if model.showArchived {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Back to chats", systemImage: "chevron.left", action: model.toggleArchived)
                }
            } else {
                ToolbarItem(placement: .principal) { lockup }
            }
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button("Catch up", systemImage: "sparkles", action: onCatchUp)
                Button(action: onOpenMentions) {
                    Image(systemName: "bell")
                        .overlay(alignment: .topTrailing) {
                            if notificationCount > 0 {
                                Text(notificationCount > 99 ? "99+" : "\(notificationCount)")
                                    .font(.system(size: 10, weight: .bold))
                                    .foregroundStyle(colors.onAccent)
                                    .padding(.horizontal, 4).padding(.vertical, 2)
                                    .background(colors.accent, in: Capsule()).offset(x: 9, y: -7)
                            }
                        }
                }
                .accessibilityLabel("Notifications, \(notificationCount) unread")
                Button("New chat", systemImage: "square.and.pencil", action: onNewChat)
            }
        }
        .onAppear { model.start(container) }
    }

    /// The one place the app says its own name: mark then wordmark, both in
    /// the brand gradient so they read as one object rather than a logo next
    /// to a title. Under it, the quiet status line — it matters, but not
    /// enough to steal a row from the list.
    private var lockup: some View {
        VStack(spacing: 1) {
            HStack(spacing: 7) {
                LogoMarkGradient(height: 17)
                Text("yappy")
                    .font(YappyFont.wordmark)
                    .headlineTracking()
                    .gradientFill(brandGradient(colors))
            }

            if model.showConnecting {
                Label("Connecting…", systemImage: "wifi.slash")
                    .font(YappyFont.labelSmall)
                    .foregroundStyle(colors.textTertiary)
            } else if !statusLine.isEmpty {
                Text(statusLine)
                    .font(YappyFont.labelSmall)
                    .foregroundStyle(colors.textTertiary)
                    .contentTransition(.numericText())
                    .animation(.snappy(duration: 0.25), value: model.online.count)
                    .animation(.snappy(duration: 0.25), value: model.unreadTotal)
            }
        }
        .accessibilityElement(children: .combine)
    }

    /// Who is around, how much is waiting. Empty when neither is true, so the
    /// lockup centres on its own rather than over a blank second line.
    private var statusLine: String {
        var parts: [String] = []
        let on = model.online.count
        if on > 0 { parts.append(on == 1 ? "1 friend on" : "\(on) friends on") }
        if model.unreadTotal > 0 { parts.append("\(model.unreadTotal) unread") }
        return parts.joined(separator: " · ")
    }

    private var notificationCount: Int {
        let countMuted = container.me?.notifications?["mutedBadge"]?.boolValue != false
        return container.unreadNotifications + model.conversations.reduce(0) { sum, conversation in
            let muted = conversation.selfState?.notificationLevel == "none"
                || YappyTime.parse(conversation.selfState?.mutedUntil).map { $0 > Date() } == true
            return sum + (muted && !countMuted ? 0 : conversation.selfState?.mentionCount ?? 0)
        }
    }

    // ── Active now ───────────────────────────────────────────────────────────

    private var activeNow: some View {
        VStack(alignment: .leading, spacing: 8) {
            ActiveNowLabel()
                .padding(.horizontal, Rail.side)

            activeNowStrip
        }
    }

    private var activeNowStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 14) {
                ForEach(model.online) { entry in
                    VStack(spacing: 4) {
                        Avatar(
                            url: entry.user.avatarUrl,
                            name: entry.user.label,
                            id: entry.user.id,
                            size: 54,
                            presence: entry.status
                        )
                        Text(entry.user.displayName?.split(separator: " ").first.map(String.init) ?? entry.user.label)
                            .font(YappyFont.labelSmall)
                            .foregroundStyle(colors.textSecondary)
                            .lineLimit(1)
                    }
                    .frame(width: 62)
                    .softTap { model.startDm(entry.user.id, onOpened: onOpenChat) }
                }
            }
            .padding(.horizontal, Rail.side)
        }
    }

    // ── Filter chips ─────────────────────────────────────────────────────────

    /// One-tap views of the list: All, Unread, mentions. The answer to a home
    /// screen that has outgrown a screenful — see `HomeFilter` for the rules.
    private var filterChips: some View {
        HStack(spacing: 8) {
            ForEach(ConversationsModel.HomeFilter.allCases, id: \.self) { filter in
                let selected = model.filter == filter
                let count = chipCount(filter)
                Text(count > 0 ? "\(filter.label) \(count)" : filter.label)
                    .font(YappyFont.labelMedium)
                    .foregroundStyle(selected ? colors.onAccent : colors.textSecondary)
                    // Digits roll rather than snap, same as the row badges:
                    // three more unread reads as counting, not repainting.
                    .contentTransition(.numericText(value: Double(count)))
                    .animation(.snappy(duration: 0.25), value: count)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 6)
                    .background {
                        // One capsule, not three. The lit fill is a single
                        // shared object that slides to whichever chip is
                        // selected — the accent as light, and the light
                        // *moves*, rather than one lamp going out while
                        // another comes on.
                        if selected {
                            Capsule()
                                .fill(colors.accentGradient)
                                .matchedGeometryEffect(id: "selection", in: chipSlide)
                        } else {
                            Capsule().fill(colors.veil)
                        }
                    }
                    .contentShape(Capsule())
                    .softTap {
                        Haptics.select()
                        model.filter = selected ? .all : filter
                    }
                    .accessibilityLabel(filter == .mentions ? "Mentions" : filter.label)
                    .accessibilityValue(count > 0 ? String(count) : "")
                    .accessibilityAddTraits(selected ? .isSelected : [])
            }
            Spacer(minLength: 0)
        }
        .animation(.snappy(duration: 0.2), value: model.filter)
    }

    /// The number a chip wears; zero means it wears none. All never counts —
    /// a total row count is inventory, not news.
    private func chipCount(_ filter: ConversationsModel.HomeFilter) -> Int {
        switch filter {
        case .all: return 0
        case .unread: return model.chipUnread
        case .mentions: return model.chipMentions
        }
    }

    // ── List ─────────────────────────────────────────────────────────────────

    @ViewBuilder
    private var content: some View {
        if model.loading {
            ScrollView {
                SkeletonRows(count: 9, avatarSize: 48).padding(.top, 6)
            }
            .scrollDisabled(true)
        } else if model.visible.isEmpty, model.searchHits.isEmpty, model.searchPeople.isEmpty {
            // Server results count as results: "Nothing matches that" over a
            // list of matching people or messages was reachable when this
            // check only counted conversation rows.
            // "No chats yet" is only true if a fetch said so. A dead network
            // with an empty cache gets an honest error, not an empty account.
            if model.loadFailed {
                LoadFailed(onRetry: model.retry)
            } else if model.filter != .all, model.query.isEmpty {
                // An empty *filter* is good news, and it must not borrow the
                // empty-account copy — "No chats yet" over a lit Unread chip
                // reads as forty conversations gone.
                VStack(spacing: 6) {
                    Spacer()
                    Text("You're all caught up")
                        .font(YappyFont.titleMedium)
                        .foregroundStyle(colors.textSecondary)
                    Text(model.filter == .mentions
                        ? "Nobody is waiting on you."
                        : "Nothing unread.")
                        .font(YappyFont.bodyMedium)
                        .foregroundStyle(colors.textTertiary)
                    Spacer()
                }
            } else {
                EmptyConversations(archived: model.showArchived, searching: !model.query.isEmpty)
            }
        } else {
            ScrollView {
                LazyVStack(spacing: 2) {
                    // Group-first, structurally: places are cards, people are
                    // rows. The home screen argues the product's thesis.
                    if !model.places.isEmpty {
                        SectionLabel(text: "Places")
                            .padding(.leading, Rail.label)
                            .padding(.top, 4)

                        ForEach(model.places) { conversation in
                            SwipeRow(
                                pinned: conversation.selfState?.isPinned == true,
                                onPin: { model.togglePin(conversation) },
                                onArchive: { model.archive(conversation) }
                            ) {
                                ConversationRow(
                                    conversation: conversation,
                                    isTyping: model.isTyping(conversation.id),
                                    asCard: true,
                                    markedUnread: model.unreadReminders.contains(conversation.id),
                                    onUnread: { model.toggleUnreadReminder(conversation.id) },
                                    onTap: {
                                        model.clearUnreadReminder(conversation.id)
                                        if conversation.isSpace {
                                            onOpenSpace(conversation.id)
                                        } else {
                                            onOpenChat(conversation.id)
                                        }
                                    },
                                    onPin: { model.togglePin(conversation) },
                                    onMute: { model.toggleMute(conversation) },
                                    onArchive: { model.archive(conversation) }
                                )
                            }
                            // Named for whichever route the tap above actually
                            // pushes, or the card would grow into a screen it
                            // is not becoming.
                            .zoomSource(conversation.isSpace ? .space(conversation.id) : .chat(conversation.id))
                            .padding(.horizontal, Rail.side - Rail.list)
                            .padding(.vertical, 5)
                        }
                    }

                    if !model.people.isEmpty {
                        SectionLabel(text: "People")
                            .padding(.leading, Rail.label)
                            .padding(.top, model.places.isEmpty ? 4 : 14)

                        ForEach(model.people) { conversation in
                            SwipeRow(
                                pinned: conversation.selfState?.isPinned == true,
                                onPin: { model.togglePin(conversation) },
                                onArchive: { model.archive(conversation) }
                            ) {
                                ConversationRow(
                                    conversation: conversation,
                                    isTyping: model.isTyping(conversation.id),
                                    asCard: false,
                                    markedUnread: model.unreadReminders.contains(conversation.id),
                                    onUnread: { model.toggleUnreadReminder(conversation.id) },
                                    onTap: {
                                        model.clearUnreadReminder(conversation.id)
                                        onOpenChat(conversation.id)
                                    },
                                    onPin: { model.togglePin(conversation) },
                                    onMute: { model.toggleMute(conversation) },
                                    onArchive: { model.archive(conversation) }
                                )
                            }
                            .zoomSource(.chat(conversation.id))
                        }
                    }

                    // People on yappy who match — the half of search the local
                    // filter can never answer, since it only sees your own list.
                    if !model.query.isEmpty, !model.searchPeople.isEmpty {
                        SectionLabel(text: "People on yappy")
                            .padding(.leading, Rail.label)
                            .padding(.top, 16)

                        ForEach(model.searchPeople) { person in
                            PersonSearchRow(person: person)
                                .softTap { onOpenProfile(person.id) }
                                .zoomSource(.profile(person.id))
                        }
                    }

                    // Server-side message search under the local filter results.
                    if !model.query.isEmpty, !model.searchHits.isEmpty {
                        SectionLabel(text: "Messages")
                            .padding(.leading, Rail.label)
                            .padding(.top, 16)

                        ForEach(model.searchHits) { hit in
                            SearchHitRow(
                                hit: hit,
                                conversationName: model.conversations
                                    .first { $0.id == hit.conversationId }?.displayName
                            )
                            .softTap { onOpenChat(hit.conversationId) }
                        }
                    }

                    /*
                     * Archived, at the foot of the list rather than as a fourth
                     * circle in the header — the same move the web made and
                     * Android now matches.
                     *
                     * Hidden while searching: a filtered list has an end that
                     * means something else.
                     */
                    if model.query.isEmpty {
                        HStack(spacing: 10) {
                            Image(systemName: "archivebox")
                                .font(.system(size: 15))
                            Text(model.showArchived ? "Back to your chats" : "Archived")
                                .font(YappyFont.titleSmall)
                            Spacer(minLength: 0)
                        }
                        .foregroundStyle(model.showArchived ? colors.accent : colors.textSecondary)
                        .padding(.horizontal, Rail.side - Rail.list)
                        .padding(.vertical, 12)
                        .padding(.top, 12)
                        .contentShape(Rectangle())
                        .softTap(action: model.toggleArchived)
                    }
                }
                .padding(.horizontal, Rail.list)
                // The tab bar reserves its own space now. This was clearance
                // for the floating compose button the refresh removed, and
                // without it the list ended in a hand's width of nothing.
                .padding(.bottom, 20)
            }
            .scrollDismissesKeyboard(.interactively)
            // The list had no manual refresh at all: it repainted on a gateway
            // event or on a cold start, and a person who suspected it was stale
            // had to kill the app to find out. The gesture everyone already
            // tries is the one that was missing.
            .refreshable {
                await model.refresh()
                // The gesture deserves an answer even when nothing changed —
                // otherwise a fresh list and a dead network feel identical.
                Haptics.success()
            }
            // The other half of the model's reorder freeze: rows must not
            // re-sort under a live drag. See `setScrolling`.
            .onScrollPhaseChange { _, newPhase in
                model.setScrolling(newPhase != .idle)
            }
        }
    }
}

// ── Active now label ─────────────────────────────────────────────────────────

/// The strip's heading, with a breathing presence dot. This pulse is the one
/// ambient loop this screen is allowed, and it earns it the only way anything
/// does: it reports live state — these people are here *right now* — rather
/// than decorating.
private struct ActiveNowLabel: View {
    @Environment(\.neu) private var colors
    @State private var pulsing = false

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(colors.success)
                .frame(width: 5, height: 5)
                .scaleEffect(pulsing ? 1.3 : 1.0)
                .animation(.easeInOut(duration: 1.2).repeatForever(autoreverses: true), value: pulsing)
            Text("ACTIVE NOW")
                .font(YappyFont.labelSmall)
                .tracking(0.3)
                .foregroundStyle(colors.textTertiary)
        }
        .accessibilityElement(children: .combine)
        .onAppear { pulsing = true }
    }
}

// ── Row ──────────────────────────────────────────────────────────────────────

private struct ConversationRow: View {
    @EnvironmentObject private var container: AppContainer
    @Environment(\.neu) private var colors

    let conversation: Conversation
    let isTyping: Bool
    let asCard: Bool
    let markedUnread: Bool
    let onUnread: () -> Void
    let onTap: () -> Void
    let onPin: () -> Void
    let onMute: () -> Void
    let onArchive: () -> Void

    var body: some View {
        let unread = conversation.unread

        // Places are raised cards — they are the few objects the "few raised
        // elements" rule budgets for. People stay flat rows.
        NeuSurface(
            radius: Neu.cornerMedium,
            state: asCard ? .raised : .flat,
            elevation: asCard ? 5 : 0,
            contentPadding: asCard ? 14 : 12,
            onTap: onTap
        ) {
            HStack(spacing: 13) {
                FlairAvatar(
                    appearance: conversation.appearance,
                    url: conversation.displayAvatar,
                    name: conversation.displayName,
                    id: conversation.avatarSeed,
                    size: asCard ? 54 : 48,
                    shape: asCard ? .place : .person
                )

                VStack(alignment: .leading, spacing: 0) {
                    titleRow(unread: unread)

                    if asCard {
                        HStack(spacing: 6) {
                            Text("\(conversation.memberCount) members")
                                .font(YappyFont.labelSmall)
                                .foregroundStyle(colors.textTertiary)
                            // Still green, still a dot, just no longer
                            // shouting from the title line.
                            if conversation.hereCount > 0, conversation.type != "dm" {
                                Circle()
                                    .fill(colors.success)
                                    .frame(width: 5, height: 5)
                                Text("\(conversation.hereCount) here")
                                    .font(YappyFont.labelSmall)
                                    .foregroundStyle(colors.success)
                            }
                        }
                    }

                    if isTyping {
                        Text("typing…")
                            .font(YappyFont.bodyMedium)
                            .italic()
                            .foregroundStyle(colors.accent)
                            .padding(.top, 3)
                    } else {
                        // Blank, not just absent: the server returns an empty
                        // preview for a message that is only a card — a bot's
                        // embed with nothing said around it — and an empty
                        // string would leave the row looking broken rather than
                        // quiet.
                        Text(previewText)
                            .font(YappyFont.bodyMedium)
                            .foregroundStyle(unread > 0 ? colors.textSecondary : colors.textTertiary)
                            .lineLimit(1)
                            .padding(.top, 3)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                trailing(unread: unread)
            }
        }
        // A flaired place washes its own card: the ring's stops laid diagonally
        // across the surface at a whisper, clipped to the card shape. The card
        // stays the sheet's material — this is the group's light falling on it,
        // which is why it sits over the fill rather than replacing it, and why
        // it never exceeds one part in ten.
        .overlay {
            if asCard, let ring = conversation.appearance?.ringColors {
                NeuShape(radius: Neu.cornerMedium)
                    .fill(LinearGradient(
                        colors: ring.map { $0.opacity(0.10) },
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    ))
                    .allowsHitTesting(false)
            }
        }
        .contextMenu {
            Button("Open", systemImage: "bubble.left", action: onTap)
            Button(markedUnread ? "Remove unread reminder" : "Mark unread on this iPhone",
                   systemImage: "envelope.badge", action: onUnread)
            Button(conversation.selfState?.isPinned == true ? "Unpin" : "Pin to top", action: onPin)
            Button(conversation.isMuted ? "Unmute" : "Mute", action: onMute)
            Button("Archive", action: onArchive)

            // Debug builds only, and one-to-one only. It belongs on the row
            // rather than in Settings because it is a property of one
            // conversation — and it is absent on a group because the fan-out
            // only knows how to find the other person in a DM. Offered there,
            // it would seal to nobody but your own devices and post a message
            // the rest of the room could never read.
            #if DEBUG
                if conversation.type == "dm" {
                    Button(container.e2e.isPrivate(conversation.id)
                        ? "Stop encrypting (dev)"
                        : "Encrypt new messages (dev)") {
                        container.e2e.setPrivate(
                            conversation.id,
                            !container.e2e.isPrivate(conversation.id)
                        )
                    }
                }
            #endif
        } preview: {
            ConversationPreview(conversation: conversation)
                .environmentObject(container)
                .environment(\.neu, colors)
        }
    }

    private var previewText: String {
        let preview = conversation.lastMessage?.preview?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return preview.isEmpty ? "No messages yet" : preview
    }

    /// Seconds until the campfire burns out; nil when this is not one.
    private var campfireRemaining: TimeInterval? {
        guard let ends = YappyTime.parse(conversation.endsAt) else { return nil }
        return ends.timeIntervalSince(Date())
    }

    /// Coarse on purpose, exactly as Android rounds: whole days, then whole
    /// hours, then minutes — never less than "1m" while it still burns.
    private static func campfireLabel(_ remaining: TimeInterval) -> String {
        let minutes = Int(remaining / 60)
        if minutes >= 24 * 60 { return "\(minutes / (24 * 60))d" }
        if minutes >= 60 { return "\(minutes / 60)h" }
        return "\(max(minutes, 1))m"
    }

    @ViewBuilder
    private func titleRow(unread: Int) -> some View {
        HStack(spacing: 5) {
            Text(conversation.displayName)
                .font(unread > 0 ? YappyFont.titleMediumBold : YappyFont.titleMedium)
                .foregroundStyle(conversation.appearance?.titleColor ?? colors.textPrimary)
                .lineLimit(1)
                .layoutPriority(1)

            // A DM row shows the *person's* marks; a group row shows the group's
            // own. Same slot either way, because the row is always answering
            // "who is this".
            if conversation.type == "dm" {
                if let other = conversation.otherUser {
                    IdentityMarks(user: other, size: 14)
                }
            } else if conversation.badge != nil {
                BadgeMark(badge: conversation.badge, size: 14)
            }

            if let emoji = conversation.appearance?.emoji {
                Text(emoji).font(YappyFont.titleSmall)
            }

            if conversation.isPublic {
                Image(systemName: "globe")
                    .font(.system(size: 11))
                    .foregroundStyle(conversation.appearance?.titleColor ?? colors.textTertiary)
            }

            // The pet, wearing how the group has been treating it. Groups
            // only — the server never sends one for a DM.
            if let pet = conversation.pet {
                PixelPet(
                    conversationId: conversation.id,
                    stage: pet.stage,
                    mood: pet.mood,
                    size: 22
                )
            }

            /*
             * The pulse moved down to the subtitle.
             *
             * As a tinted pill beside the title it appeared on every card at
             * once — and a signal that is always on is not a signal, it is a
             * texture. Worse, it sat in the title line, so seven of them read
             * as seven things demanding attention when the usual count is one,
             * and the one is you.
             */

            // A campfire announces its own end. On the card, not just inside
            // the chat — a place that is burning down should look different
            // from one that will keep.
            if let remaining = campfireRemaining, remaining > 0 {
                let urgent = remaining < 3600
                HStack(spacing: 3) {
                    Text("🔥").font(YappyFont.labelSmall)
                    Text(Self.campfireLabel(remaining))
                        .font(YappyFont.labelSmall)
                        .foregroundStyle(urgent ? colors.danger : colors.warning)
                }
                .padding(.horizontal, 7)
                .padding(.vertical, 2)
                .background((urgent ? colors.danger : colors.warning).opacity(0.14), in: Capsule())
            }

            if conversation.selfState?.isPinned == true {
                Image(systemName: "pin.fill")
                    .font(.system(size: 10))
                    .foregroundStyle(colors.textTertiary)
            }
            if conversation.isMuted {
                Image(systemName: "bell.slash.fill")
                    .font(.system(size: 10))
                    .foregroundStyle(colors.textTertiary)
            }

            Spacer(minLength: 0)
        }
    }

    @ViewBuilder
    private func trailing(unread: Int) -> some View {
        VStack(alignment: .trailing, spacing: 6) {
            Text(YappyTime.relative(conversation.lastMessageAt))
                .font(YappyFont.labelSmall)
                .foregroundStyle(colors.textTertiary)

            HStack(spacing: 5) {
                /*
                 * One badge, not two.
                 *
                 * This drew a bare red @ circle beside the violet count —
                 * two mismatched shapes crowding one corner, with red
                 * borrowing the alarm register for the most ordinary reason
                 * to open the app. Mentions outrank a plain unread count,
                 * so when there are any the one badge is theirs: "@4" in
                 * the brand yellow. Otherwise the unread count as before.
                 */
                let cardMentions = conversation.selfState?.mentionCount ?? 0
                if markedUnread, unread == 0, cardMentions == 0 {
                    Circle().fill(colors.accent).frame(width: 9, height: 9)
                        .accessibilityLabel("Unread reminder")
                } else if cardMentions > 0 {
                    Text("@\(cardMentions > 99 ? "99+" : String(cardMentions))")
                        .font(YappyFont.labelSmall)
                        .foregroundStyle(colors.onMention)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(colors.mention, in: Capsule())
                } else if unread > 0 {
                    Text(unread > 99 ? "99+" : "\(unread)")
                        .font(YappyFont.labelSmall)
                        .foregroundStyle(colors.onAccent)
                        // Digits roll rather than snap, so three messages
                        // arriving read as counting, not repainting.
                        .contentTransition(.numericText(value: Double(unread)))
                        .animation(.snappy(duration: 0.25), value: unread)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(colors.accent, in: Capsule())
                }
            }

            // Only worth showing to somebody who can join it.
            if Feature.calling, conversation.activeCall != nil {
                HStack(spacing: 3) {
                    Image(systemName: "phone.fill").font(.system(size: 8))
                    Text("Live").font(YappyFont.labelSmall)
                }
                .foregroundStyle(colors.success)
                .padding(.horizontal, 7)
                .padding(.vertical, 2)
                .background(colors.success.opacity(0.16), in: Capsule())
            }
        }
    }
}

// ── Swipe ────────────────────────────────────────────────────────────────────

/// Drag a conversation right to pin it, left to archive it.
///
/// Same mechanics as the timeline's SwipeToReply, and deliberately so — pull,
/// feel the tick when it will fire, let go — because a gesture the thumb
/// already knows from one screen should not behave differently on another.
/// The gesture is *simultaneous*, so it never takes the drag away from the
/// scroll view, and it bails the moment a drag looks more vertical than
/// horizontal — scrolling wins ties. The context menu keeps both actions,
/// exactly as the message sheet kept Reply: this is the shortcut, not the
/// only route.
///
/// Both directions snap back rather than staying dismissed. Pin visibly
/// reorders the row and archive removes it, so the row's own movement is the
/// confirmation — a hole where the row used to be would say less.
private struct SwipeRow<Content: View>: View {
    @Environment(\.neu) private var colors

    let pinned: Bool
    let onPin: () -> Void
    let onArchive: () -> Void
    @ViewBuilder var content: () -> Content

    @State private var offset: CGFloat = 0
    /// Past the point where letting go fires. Tracked so the tick happens once
    /// on the way in rather than on every frame.
    @State private var armed = false

    /// Far enough to be deliberate, close enough to reach with a thumb.
    private let trigger: CGFloat = 64
    private let limit: CGFloat = 84

    var body: some View {
        content()
            .offset(x: offset)
            .background(alignment: offset >= 0 ? .leading : .trailing) { indicator }
            .animation(.interactiveSpring(response: 0.25, dampingFraction: 0.8), value: offset)
            .simultaneousGesture(swipe)
    }

    private var swipe: some Gesture {
        DragGesture(minimumDistance: 16)
            .onChanged { value in
                let horizontal = value.translation.width
                // Vertical intent: leave it to the scroll view entirely.
                guard abs(horizontal) > abs(value.translation.height) else {
                    if offset != 0 { offset = 0; armed = false }
                    return
                }

                // Resistance past the trigger in both directions, so the row
                // tells you it has gone as far as it usefully can.
                if abs(horizontal) <= trigger {
                    offset = horizontal
                } else if horizontal > 0 {
                    offset = min(trigger + (horizontal - trigger) * 0.3, limit)
                } else {
                    offset = -min(trigger + (-horizontal - trigger) * 0.3, limit)
                }

                if abs(offset) >= trigger, !armed {
                    armed = true
                    Haptics.thud()
                } else if abs(offset) < trigger {
                    armed = false
                }
            }
            .onEnded { _ in
                if armed {
                    if offset > 0 { onPin() } else { onArchive() }
                }
                armed = false
                offset = 0
            }
    }

    /// Sits at the row's edge, behind it, uncovered as the row slides off —
    /// so the gesture explains itself the first time. No offset of its own:
    /// `.background` anchors to where the row *would* be.
    private var indicator: some View {
        let rightward = offset >= 0
        let progress = min(abs(offset) / trigger, 1)

        return Image(systemName: rightward ? "pin.fill" : "archivebox.fill")
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(abs(offset) >= trigger ? colors.accent : colors.textTertiary)
            .frame(width: 34, height: 34)
            .background(colors.veil, in: Circle())
            .scaleEffect(0.6 + 0.4 * progress)
            .opacity(Double(progress))
            .padding(.horizontal, 18)
            // The rightward action is a toggle and the icon cannot say which
            // way it will go; the label can.
            .accessibilityLabel(rightward ? (pinned ? "Unpin" : "Pin") : "Archive")
    }
}

// ── Search hit ───────────────────────────────────────────────────────────────

private struct SearchHitRow: View {
    @Environment(\.neu) private var colors
    let hit: SearchHit
    let conversationName: String?

    var body: some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 1) {
                Text(conversationName ?? "Conversation")
                    .font(YappyFont.labelMedium)
                    .foregroundStyle(colors.textTertiary)
                Text(styledSnippet)
                    .font(YappyFont.bodyMedium)
                    .foregroundStyle(colors.textPrimary)
                    .lineLimit(2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            Text(YappyTime.relative(hit.createdAt))
                .font(YappyFont.labelSmall)
                .foregroundStyle(colors.textTertiary)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
    }

    /// Postgres `ts_headline` marks matches with `<em>` tags; render them as
    /// accents rather than showing the reader raw markup.
    private var styledSnippet: AttributedString {
        var result = AttributedString()
        var rest = Substring(hit.snippet)

        while let open = rest.range(of: "<em>") {
            result.append(AttributedString(rest[rest.startIndex ..< open.lowerBound]))
            let afterOpen = rest[open.upperBound...]
            guard let close = afterOpen.range(of: "</em>") else {
                result.append(AttributedString(afterOpen))
                return result
            }
            var highlighted = AttributedString(afterOpen[afterOpen.startIndex ..< close.lowerBound])
            highlighted.foregroundColor = colors.accent
            highlighted.font = YappyFont.body(14, weight: .semibold)
            result.append(highlighted)
            rest = afterOpen[close.upperBound...]
        }

        result.append(AttributedString(rest))
        return result
    }
}

// ── Person search result ─────────────────────────────────────────────────────

/// An account matching the search — someone who may not be in your list at
/// all, which is why the row leads to their profile rather than a chat.
private struct PersonSearchRow: View {
    @Environment(\.neu) private var colors
    let person: PublicUser

    var body: some View {
        HStack(spacing: 12) {
            Avatar(url: person.avatarUrl, name: person.displayName, id: person.id, size: 40)

            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 5) {
                    Text(person.displayName ?? person.username ?? "Someone")
                        .font(YappyFont.titleSmall)
                        .foregroundStyle(colors.textPrimary)
                        .lineLimit(1)
                    IdentityMarks(user: person, size: 13)
                }
                if let username = person.username {
                    Text("@\(username)")
                        .font(YappyFont.labelSmall)
                        .foregroundStyle(colors.textTertiary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
    }
}

// ── Failed load ──────────────────────────────────────────────────────────────

private struct LoadFailed: View {
    @Environment(\.neu) private var colors
    let onRetry: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            Spacer()
            Image(systemName: "wifi.slash")
                .font(.system(size: 34, weight: .light))
                .foregroundStyle(colors.textTertiary)
                .frame(width: 88, height: 88)
                .neu(Circle(), colors, state: .pressed, elevation: 8)

            Text("Couldn't load your chats")
                .font(YappyFont.titleMedium)
                .foregroundStyle(colors.textSecondary)
                .padding(.top, 18)

            Text("Check your connection and try again.")
                .font(YappyFont.bodyMedium)
                .foregroundStyle(colors.textTertiary)
                .multilineTextAlignment(.center)
                .padding(.top, 6)

            Text("Retry")
                .font(YappyFont.titleSmallBold)
                .foregroundStyle(colors.accent)
                .padding(.horizontal, 26)
                .padding(.vertical, 12)
                .neu(Capsule(), colors, state: .raised, elevation: 6)
                .softTap(action: onRetry)
                .padding(.top, 22)
            Spacer()
        }
        .padding(40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// ── Empty state ──────────────────────────────────────────────────────────────

private struct EmptyConversations: View {
    @Environment(\.neu) private var colors
    let archived: Bool
    let searching: Bool

    var body: some View {
        VStack(spacing: 0) {
            Spacer()
            // A brand-new account is greeted by the mark in the brand gradient,
            // not a grey plus — the first screen anyone sees should say whose
            // app this is. The archive and a failed search keep their literal
            // glyphs, because those states are about the list, not the product.
            ZStack {
                if archived || searching {
                    Image(systemName: archived ? "archivebox" : "plus")
                        .font(.system(size: 34, weight: .light))
                        .foregroundStyle(colors.textTertiary)
                } else {
                    LogoMarkGradient(height: 52)
                }
            }
            .frame(width: 88, height: 88)
            .neu(Circle(), colors, state: .pressed, elevation: 8)

            Text(title)
                .font(YappyFont.titleMedium)
                .foregroundStyle(colors.textSecondary)
                .padding(.top, 18)

            Text(blurb)
                .font(YappyFont.bodyMedium)
                .foregroundStyle(colors.textTertiary)
                .multilineTextAlignment(.center)
                .padding(.top, 6)
            Spacer()
        }
        .padding(40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var title: String {
        if searching { return "Nothing matches that" }
        return archived ? "No archived chats" : "Nobody here yet"
    }

    private var blurb: String {
        if searching { return "Try a different search." }
        // Not "start a conversation" — with whom? Somebody who has just
        // arrived knows nobody here, so the one action this used to offer was
        // the one they could not take.
        return archived
            ? "Chats you archive will show up here."
            : "Make a group and send the link to your friends. Tap +, or ask @yapper."
    }
}
