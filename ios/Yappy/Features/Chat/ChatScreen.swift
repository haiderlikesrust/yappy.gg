import SwiftUI

struct ChatScreen: View {
    @Environment(\.neu) private var colors
    @EnvironmentObject private var container: AppContainer
    @StateObject private var model = ChatModel()

    let conversationId: String
    let onBack: () -> Void
    let onOpenProfile: (String) -> Void
    let onOpenGroup: (String) -> Void
    let onOpenCall: (String) -> Void
    let onOpenThread: (String) -> Void

    @State private var pickerOpen = false
    @State private var pollOpen = false
    @State private var actionTarget: Message?
    @State private var forwardTarget: Message?
    @State private var reactionsTarget: Message?
    /// Message id the media viewer should open on, or nil when it is closed.
    @State private var viewerAt: String?
    @State private var atBottom = true

    var body: some View {
        VStack(spacing: 0) {
            header

            if !model.pinned.isEmpty { pinnedBar }

            timeline
                .frame(maxHeight: .infinity)

            Composer(
                draft: $model.draft,
                replyTo: model.replyTo,
                editing: model.editing,
                pickerOpen: pickerOpen,
                canSend: !model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                accentOverride: model.conversation?.appearance?.titleColor,
                mentionable: model.mentionable,
                commands: model.commands,
                onSend: model.send,
                onCancelReply: { model.setReplyTo(nil) },
                onCancelEdit: model.cancelEditing,
                onTogglePicker: { pickerOpen.toggle() },
                onOpenPoll: { pollOpen = true },
                onPickMedia: model.sendImage
            )
            .onChange(of: model.draft) { _, _ in model.draftChanged() }

            if pickerOpen {
                PickerSheet(
                    packs: model.stickerPacks,
                    recentStickers: model.recentStickers,
                    gifs: model.gifs,
                    gifQuery: model.gifQuery,
                    gifsLoading: model.gifsLoading,
                    onGifQueryChange: model.searchGifs,
                    onSticker: { model.sendSticker($0); pickerOpen = false },
                    onGif: { model.sendGif($0); pickerOpen = false },
                    onEmoji: { model.draft += $0 }
                )
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            // Send failures are worth a line of their own: the bubble can
            // disappear, so without this the message would just vanish.
            if let error = model.error {
                Text(error)
                    .font(YappyFont.labelSmall)
                    .foregroundStyle(colors.danger)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 20)
                    .padding(.vertical, 4)
                    .task {
                        try? await Task.sleep(for: .seconds(4))
                        model.error = nil
                    }
            }
        }
        .animation(.easeInOut(duration: 0.2), value: pickerOpen)
        .animation(.easeInOut(duration: 0.2), value: model.pinned.count)
        .navigationBarBackButtonHidden(true)
        .toolbar(.hidden, for: .navigationBar)
        .onAppear {
            model.start(container, conversationId: conversationId)
            // A push for the chat you are already reading is noise; the message
            // is arriving over the socket and is already on screen.
            PushService.shared.foregroundConversationId = conversationId
        }
        .onDisappear {
            model.stop()
            if PushService.shared.foregroundConversationId == conversationId {
                PushService.shared.foregroundConversationId = nil
            }
        }
        .sheet(item: $actionTarget) { target in
            MessageActions(
                message: target,
                isMine: target.senderId == model.meId,
                isPinned: model.pinned.contains { $0.id == target.id },
                onReact: { model.toggleReaction(target, emoji: $0) },
                onReply: { model.setReplyTo(target) },
                onThread: { onOpenThread(target.threadRootId ?? target.id) },
                onForward: { forwardTarget = target },
                onWhoReacted: { reactionsTarget = target },
                onPin: { model.togglePin(target) },
                onEdit: { model.startEditing(target) },
                onDelete: { model.deleteMessage(target, forEveryone: true) }
            )
            .presentationDetents([.medium, .large])
            .presentationBackground(colors.surface)
        }
        .sheet(item: $forwardTarget) { target in
            ForwardPicker(
                candidates: model.forwardCandidates,
                onPick: { conversation in
                    model.forward(target, to: conversation.id)
                    forwardTarget = nil
                }
            )
            .presentationDetents([.medium])
            .presentationBackground(colors.surface)
        }
        .sheet(item: $reactionsTarget) { target in
            ReactionList(load: { await model.reactionDetails(for: target) })
                .presentationDetents([.medium])
                .presentationBackground(colors.surface)
        }
        .sheet(isPresented: $pollOpen) {
            PollComposer(
                onDismiss: { pollOpen = false },
                onCreate: { question, options, multi in
                    model.sendPoll(question: question, options: options, multiSelect: multi)
                    pollOpen = false
                }
            )
            .presentationDetents([.large])
            .presentationBackground(colors.surface)
        }
        .fullScreenCover(item: Binding(
            get: { viewerAt.map(ViewerAnchor.init) },
            set: { viewerAt = $0?.id }
        )) { anchor in
            // Built from the loaded timeline rather than a separate fetch:
            // whatever is on screen is what you can swipe through, which is both
            // cheap and exactly what someone tapping a photo expects.
            MediaViewer(
                items: viewerItems,
                initialIndex: viewerItems.firstIndex { $0.id == anchor.id } ?? 0,
                onDismiss: { viewerAt = nil }
            )
        }
    }

    // ── Header ───────────────────────────────────────────────────────────────

    /// The real conversation once it arrives, and until then whatever the list
    /// that sent us here already knew. Only a chat opened from a deep link — no
    /// list, no seed — still shows a placeholder.
    private var head: ChatHeaderSeed {
        if let conversation = model.conversation {
            return ChatHeaderSeed(
                title: conversation.displayName,
                avatarUrl: conversation.displayAvatar,
                avatarSeed: conversation.avatarSeed,
                badge: conversation.type == "dm" ? conversation.otherUser?.badge : conversation.badge,
                appearance: conversation.appearance,
                subtitle: subtitle,
                isGroup: conversation.type != "dm"
            )
        }
        return model.headerSeed ?? ChatHeaderSeed(
            title: "…",
            avatarSeed: conversationId,
            isGroup: false
        )
    }

    private var header: some View {
        let head = head

        return HStack(spacing: 10) {
            NeuIconButton(systemName: "chevron.left", label: "Back", size: 42, iconSize: 18, action: onBack)

            HStack(spacing: 10) {
                FlairAvatar(
                    appearance: head.appearance,
                    url: head.avatarUrl,
                    name: head.title,
                    id: head.avatarSeed,
                    size: 40,
                    shape: head.isGroup ? .place : .person
                )

                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 5) {
                        Text(head.title)
                            .font(YappyFont.titleMedium)
                            .foregroundStyle(head.appearance?.titleColor ?? colors.textPrimary)
                            .lineLimit(1)
                        BadgeMark(badge: head.badge, size: 15)
                        if let emoji = head.appearance?.emoji {
                            Text(emoji).font(YappyFont.titleSmall)
                        }
                    }
                    // Typing wins over the seed's subtitle the moment it starts.
                    if let subtitle = model.typingLabel ?? head.subtitle {
                        Text(subtitle)
                            .font(YappyFont.labelSmall)
                            .foregroundStyle(colors.accent)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
            }
            .softTap {
                // A DM's header is a person; a group's header is a place. Until
                // the real conversation lands there is nothing to open — the
                // seed knows the name, not the ids.
                guard let conversation = model.conversation else { return }
                if conversation.type == "dm" {
                    if let id = conversation.otherUser?.id { onOpenProfile(id) }
                } else {
                    // A channel's own profile is nearly empty — its people,
                    // roles and settings all live on the space.
                    onOpenGroup(conversation.parentId ?? conversationId)
                }
            }

            NeuIconButton(systemName: "phone.fill", label: "Voice call", size: 42, iconSize: 18) {
                Task { if let id = await model.startCall(video: false) { onOpenCall(id) } }
            }
            NeuIconButton(systemName: "video.fill", label: "Video call", size: 42, iconSize: 18) {
                Task { if let id = await model.startCall(video: true) { onOpenCall(id) } }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    private var subtitle: String? {
        guard let conversation = model.conversation else { return nil }
        if conversation.type == "dm" {
            return conversation.otherUser?.username.map { "@\($0)" }
        }
        // A channel says where it lives — the title alone ("general") is
        // meaningless out of context.
        if let parent = conversation.parentTitle {
            return "in \(parent) · \(conversation.memberCount) members"
        }
        return "\(conversation.memberCount) members"
    }

    private var pinnedBar: some View {
        HStack(spacing: 9) {
            Image(systemName: "pin.fill")
                .font(.system(size: 12))
                .foregroundStyle(colors.accent)
            VStack(alignment: .leading, spacing: 0) {
                Text(model.pinned.count > 1 ? "\(model.pinned.count) pinned messages" : "Pinned message")
                    .font(YappyFont.labelSmall)
                    .foregroundStyle(colors.accent)
                Text(model.pinned[0].content ?? "Attachment")
                    .font(YappyFont.bodyMedium)
                    .foregroundStyle(colors.textSecondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(colors.dark.opacity(0.08), in: NeuShape(radius: Neu.cornerSmall))
        .padding(.horizontal, 14)
        .padding(.vertical, 4)
    }

    // ── Timeline ─────────────────────────────────────────────────────────────

    @ViewBuilder
    private var timeline: some View {
        if model.loading {
            NeuSpinner().frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if model.messages.isEmpty {
            Text("Say something to get started")
                .font(YappyFont.bodyMedium)
                .foregroundStyle(colors.textTertiary)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 0) {
                        if model.loadingOlder {
                            NeuSpinner().padding(.vertical, 12)
                        }

                        ForEach(Array(model.messages.enumerated()), id: \.element.id) { index, message in
                            let previous = index > 0 ? model.messages[index - 1] : nil
                            let next = index + 1 < model.messages.count ? model.messages[index + 1] : nil

                            if YappyTime.crossesDay(previous?.createdAt, message.createdAt) {
                                DaySeparator(label: YappyTime.dayLabel(message.createdAt))
                            }

                            row(message: message, previous: previous, next: next)
                                .id(message.id)
                                .onAppear {
                                    if index == 0 { model.loadOlder() }
                                    model.markRead(upTo: message.seq)
                                }
                        }

                        // A zero-height anchor is more reliable than scrolling to
                        // the last message: a tall bubble scrolled "to top" still
                        // leaves its own bottom off screen.
                        Color.clear
                            .frame(height: 1)
                            .id(bottomAnchor)
                            .onAppear { atBottom = true }
                            .onDisappear { atBottom = false }
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                }
                .defaultScrollAnchor(.bottom)
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: model.messages.count) { _, _ in
                    // Stick to the bottom only when already near it — yanking the
                    // viewport while someone is reading scrollback is the classic
                    // chat-app annoyance.
                    guard atBottom else { return }
                    withAnimation(.easeOut(duration: 0.2)) {
                        proxy.scrollTo(bottomAnchor, anchor: .bottom)
                    }
                }
            }
        }
    }

    private let bottomAnchor = "bottom-anchor"

    private func row(message: Message, previous: Message?, next: Message?) -> some View {
        let isMine = message.senderId != nil && message.senderId == model.meId
        let grouped = previous?.senderId == message.senderId
            && previous?.isSystem == false
            && !message.isSystem
        // Avatar only on the last bubble of a run — that is what visually groups
        // consecutive messages from one person.
        let showAvatar = !isMine && (next?.senderId != message.senderId || next?.isSystem == true)

        return MessageBubble(
            message: message,
            isMine: isMine,
            showAvatar: showAvatar,
            isGrouped: grouped,
            isPinned: model.pinned.contains { $0.id == message.id },
            appearance: model.conversation?.appearance,
            myUserId: model.meId,
            pressingComponent: model.pressingComponent,
            onLongPress: { actionTarget = message },
            onReaction: { model.toggleReaction(message, emoji: $0) },
            onVote: { model.vote(message, optionId: $0) },
            onOpenThread: { onOpenThread(message.threadRootId ?? message.id) },
            // Opening one photo opens the whole conversation's photos,
            // positioned on this one — swiping between them is what people
            // expect once they are in there.
            onOpenMedia: { viewerAt = message.id },
            onPressComponent: { model.pressComponent($0, messageId: message.id) }
        )
    }

    private var viewerItems: [ViewerItem] {
        model.messages.compactMap { message in
            guard let attachment = message.firstImage else { return nil }
            return ViewerItem(
                id: message.id,
                url: attachment.url,
                caption: message.content,
                senderName: message.sender?.label,
                filename: attachment.filename
            )
        }
    }
}

/// `fullScreenCover(item:)` needs an `Identifiable`; a bare id string is not.
private struct ViewerAnchor: Identifiable {
    let id: String
}

private struct DaySeparator: View {
    @Environment(\.neu) private var colors
    let label: String

    var body: some View {
        Text(label)
            .font(YappyFont.labelSmall)
            .foregroundStyle(colors.textTertiary)
            .padding(.horizontal, 14)
            .padding(.vertical, 5)
            .background(colors.dark.opacity(0.10), in: Capsule())
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
    }
}

// ── Action sheet ─────────────────────────────────────────────────────────────

private struct MessageActions: View {
    @Environment(\.neu) private var colors
    @Environment(\.dismiss) private var dismiss

    let message: Message
    let isMine: Bool
    let isPinned: Bool
    let onReact: (String) -> Void
    let onReply: () -> Void
    let onThread: () -> Void
    let onForward: () -> Void
    let onWhoReacted: () -> Void
    let onPin: () -> Void
    let onEdit: () -> Void
    let onDelete: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                QuickReactions { emoji in
                    onReact(emoji)
                    dismiss()
                }
                .padding(.bottom, 16)

                row("arrowshape.turn.up.left", "Reply") { onReply() }
                row("bubble.left.and.bubble.right", "Reply in thread") { onThread() }
                row("arrowshape.turn.up.right", "Forward") { onForward() }

                if !message.reactions.isEmpty {
                    row("face.smiling", "Who reacted") { onWhoReacted() }
                }
                if let content = message.content, !content.isEmpty {
                    row("doc.on.doc", "Copy text") { UIPasteboard.general.string = content }
                }
                row("pin.fill", isPinned ? "Unpin" : "Pin") { onPin() }

                if isMine, message.type == "text", !message.isDeleted {
                    row("pencil", "Edit") { onEdit() }
                }
                if isMine, !message.isDeleted {
                    row("trash", "Delete for everyone", danger: true) { onDelete() }
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 20)
            .padding(.bottom, 28)
        }
    }

    private func row(_ symbol: String, _ label: String, danger: Bool = false, action: @escaping () -> Void) -> some View {
        HStack(spacing: 14) {
            Image(systemName: symbol)
                .font(.system(size: 17))
                .foregroundStyle(danger ? colors.danger : colors.textSecondary)
                .frame(width: 22)
            Text(label)
                .font(YappyFont.bodyLarge)
                .foregroundStyle(danger ? colors.danger : colors.textPrimary)
            Spacer(minLength: 0)
        }
        .padding(.vertical, 13)
        .padding(.horizontal, 6)
        .contentShape(Rectangle())
        .softTap {
            action()
            dismiss()
        }
    }
}

// ── Forward picker ───────────────────────────────────────────────────────────

private struct ForwardPicker: View {
    @Environment(\.neu) private var colors

    let candidates: () async -> [Conversation]
    let onPick: (Conversation) -> Void

    @State private var conversations: [Conversation] = []

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Text("Forward to")
                    .font(YappyFont.titleMedium)
                    .foregroundStyle(colors.textPrimary)
                    .padding(.bottom, 10)

                ForEach(conversations.prefix(12)) { conversation in
                    HStack(spacing: 12) {
                        Avatar(
                            url: conversation.displayAvatar,
                            name: conversation.displayName,
                            id: conversation.avatarSeed,
                            size: 38,
                            shape: conversation.type == "dm" ? .person : .place
                        )
                        Text(conversation.displayName)
                            .font(YappyFont.bodyLarge)
                            .foregroundStyle(colors.textPrimary)
                            .lineLimit(1)
                        Spacer(minLength: 0)
                    }
                    .padding(.vertical, 8)
                    .padding(.horizontal, 6)
                    .contentShape(Rectangle())
                    .softTap { onPick(conversation) }
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 20)
            .padding(.bottom, 28)
        }
        .task { conversations = await candidates() }
    }
}

// ── Who reacted ──────────────────────────────────────────────────────────────

private struct ReactionList: View {
    @Environment(\.neu) private var colors
    let load: () async -> [ReactionDetail]

    @State private var details: [ReactionDetail] = []

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Text("Reactions")
                    .font(YappyFont.titleMedium)
                    .foregroundStyle(colors.textPrimary)
                    .padding(.bottom, 10)

                ForEach(details) { detail in
                    HStack(spacing: 10) {
                        Text(detail.emoji).font(YappyFont.titleMedium)
                        Avatar(
                            url: detail.user.avatarUrl,
                            name: detail.user.label,
                            id: detail.user.id,
                            size: 34
                        )
                        Text(detail.user.label)
                            .font(YappyFont.bodyLarge)
                            .foregroundStyle(colors.textPrimary)
                        Spacer(minLength: 0)
                    }
                    .padding(.vertical, 7)
                    .padding(.horizontal, 6)
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 20)
            .padding(.bottom, 28)
        }
        .task { details = await load() }
    }
}
