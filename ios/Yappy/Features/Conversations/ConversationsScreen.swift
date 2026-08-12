import SwiftUI

struct ConversationsScreen: View {
    @Environment(\.neu) private var colors
    @EnvironmentObject private var container: AppContainer
    @StateObject private var model = ConversationsModel()

    let onOpenChat: (String) -> Void
    /// A space opens its channel list; it has no timeline of its own.
    let onOpenSpace: (String) -> Void
    let onNewChat: () -> Void
    let onSettings: () -> Void
    let onExplore: () -> Void

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            VStack(spacing: 0) {
                header
                    .padding(.horizontal, 20)
                    .padding(.vertical, 14)

                NeuTextField(
                    text: $model.query,
                    placeholder: "Search",
                    radius: Neu.cornerPill,
                    autocapitalization: .never
                ) {
                    Image(systemName: "magnifyingglass")
                        .font(.system(size: 16))
                        .foregroundStyle(colors.textTertiary)
                }
                .padding(.horizontal, 20)

                if !model.online.isEmpty, !model.showArchived {
                    activeNow
                        .padding(.top, 14)
                        .transition(.opacity)
                }

                content.padding(.top, 12)
            }
            // The Active Now strip lands a beat after the cached list paints;
            // unanimated, its arrival shoved the whole list down in one frame.
            .animation(.easeOut(duration: 0.25), value: model.online.isEmpty)

            NeuIconButton(
                systemName: "plus",
                label: "New chat",
                size: 62,
                iconSize: 27,
                accent: true,
                action: onNewChat
            )
            .padding(.trailing, 22)
            .padding(.bottom, 34)
        }
        .navigationBarHidden(true)
        .onAppear { model.start(container) }
    }

    // ── Header ───────────────────────────────────────────────────────────────

    private var header: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                // The lockup is the one place the app says its own name: mark
                // then wordmark, both in the brand gradient so they read as one
                // object rather than a logo next to a title.
                HStack(spacing: 9) {
                    LogoMarkGradient(height: 22)
                    Text("yappy")
                        .font(YappyFont.wordmark)
                        .headlineTracking()
                        .gradientFill(brandGradient(colors))
                }

                // A quiet status line instead of a banner: it matters, but not
                // enough to steal a row from the list.
                if model.showArchived {
                    Text("Archived")
                        .font(YappyFont.labelSmall)
                        .foregroundStyle(colors.textTertiary)
                } else if model.showConnecting {
                    HStack(spacing: 5) {
                        Image(systemName: "wifi.slash")
                            .font(.system(size: 10))
                        Text("Connecting…")
                            .font(YappyFont.labelSmall)
                    }
                    .foregroundStyle(colors.textTertiary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            NeuIconButton(systemName: "safari", label: "Explore public groups", action: onExplore)
            NeuIconButton(
                systemName: "archivebox",
                label: "Archived",
                active: model.showArchived,
                action: model.toggleArchived
            )
            // Your own face is the door to settings — apps have profiles, yappy
            // has people.
            Avatar(
                url: container.me?.avatarUrl,
                name: container.me?.displayName,
                id: container.me?.id ?? "me",
                size: 44,
                presence: "online"
            )
            .softTap(action: onSettings)
        }
    }

    // ── Active now ───────────────────────────────────────────────────────────

    private var activeNow: some View {
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
            .padding(.horizontal, 20)
        }
    }

    // ── List ─────────────────────────────────────────────────────────────────

    @ViewBuilder
    private var content: some View {
        if model.loading {
            Spacer()
            NeuSpinner()
            Spacer()
        } else if model.visible.isEmpty, model.searchHits.isEmpty {
            // "No chats yet" is only true if a fetch said so. A dead network
            // with an empty cache gets an honest error, not an empty account.
            if model.loadFailed {
                LoadFailed(onRetry: model.retry)
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
                            .padding(.leading, 12)
                            .padding(.top, 4)

                        ForEach(model.places) { conversation in
                            ConversationRow(
                                conversation: conversation,
                                isTyping: model.isTyping(conversation.id),
                                asCard: true,
                                onTap: {
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
                            .padding(.vertical, 5)
                        }
                    }

                    if !model.people.isEmpty {
                        SectionLabel(text: "People")
                            .padding(.leading, 12)
                            .padding(.top, model.places.isEmpty ? 4 : 14)

                        ForEach(model.people) { conversation in
                            ConversationRow(
                                conversation: conversation,
                                isTyping: model.isTyping(conversation.id),
                                asCard: false,
                                onTap: { onOpenChat(conversation.id) },
                                onPin: { model.togglePin(conversation) },
                                onMute: { model.toggleMute(conversation) },
                                onArchive: { model.archive(conversation) }
                            )
                        }
                    }

                    // Server-side message search under the local filter results.
                    if !model.query.isEmpty, !model.searchHits.isEmpty {
                        SectionLabel(text: "Messages")
                            .padding(.leading, 12)
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
                }
                .padding(.horizontal, 12)
                .padding(.bottom, 110)
            }
            .scrollDismissesKeyboard(.interactively)
        }
    }
}

// ── Row ──────────────────────────────────────────────────────────────────────

private struct ConversationRow: View {
    @Environment(\.neu) private var colors

    let conversation: Conversation
    let isTyping: Bool
    let asCard: Bool
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
                        Text("\(conversation.memberCount) members")
                            .font(YappyFont.labelSmall)
                            .foregroundStyle(colors.textTertiary)
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
        .contextMenu {
            Button(conversation.selfState?.isPinned == true ? "Unpin" : "Pin to top", action: onPin)
            Button(conversation.isMuted ? "Unmute" : "Mute", action: onMute)
            Button("Archive", action: onArchive)
        }
    }

    private var previewText: String {
        let preview = conversation.lastMessage?.preview?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return preview.isEmpty ? "No messages yet" : preview
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

            // The pulse: people are in this group right now.
            if conversation.hereCount > 0, conversation.type != "dm" {
                HStack(spacing: 4) {
                    Circle().fill(colors.success).frame(width: 6, height: 6)
                    Text("\(conversation.hereCount) here")
                        .font(YappyFont.labelSmall)
                        .foregroundStyle(colors.success)
                }
                .padding(.horizontal, 7)
                .padding(.vertical, 2)
                .background(colors.success.opacity(0.14), in: Capsule())
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
                // An unanswered mention outranks a plain unread count.
                if (conversation.selfState?.mentionCount ?? 0) > 0 {
                    Text("@")
                        .font(YappyFont.labelSmall)
                        .foregroundStyle(colors.onAccent)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(colors.danger, in: Capsule())
                }
                if unread > 0 {
                    Text(unread > 99 ? "99+" : "\(unread)")
                        .font(YappyFont.labelSmall)
                        .foregroundStyle(colors.onAccent)
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
            Image(systemName: archived ? "archivebox" : "plus")
                .font(.system(size: 34, weight: .light))
                .foregroundStyle(colors.textTertiary)
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
