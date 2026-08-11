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
    /// Opens the space this channel belongs to — its channel list is how you
    /// get to a sibling.
    var onOpenSpace: (String) -> Void = { _ in }

    @State private var pickerOpen = false
    @State private var pollOpen = false
    @State private var locationOpen = false
    /// Picked but not yet sent — the preview is up while this is set.
    @State private var pendingMedia: PendingMedia?
    @State private var actionTarget: Message?
    @State private var forwardTarget: Message?
    @State private var reactionsTarget: Message?
    @State private var seenByTarget: Message?
    /// Message id the media viewer should open on, or nil when it is closed.
    @State private var viewerAt: String?
    /// Rows currently laid out by the lazy stack. The newest message being
    /// among them is what "at the bottom" means here — cheaper and steadier
    /// than chasing scroll offsets through the inverted list's flip.
    @State private var visibleIds: Set<String> = []
    /// The newest settled seq at the moment the reader scrolled away from the
    /// bottom. Anything newer than this from someone else is what the jump
    /// pill counts.
    @State private var awaySince: Int64?

    var body: some View {
        VStack(spacing: 0) {
            header

            if let endsAt = model.conversation?.endsAt { CampfireBar(endsAt: endsAt) }
            if !model.viewers.isEmpty { hereNowBar }
            if !model.pinned.isEmpty { pinnedBar }

            timeline
                .frame(maxHeight: .infinity)
                // Over the messages, sitting on the composer's top edge.
                .overlay(alignment: .bottom) {
                    let matches = matchingCommands(model.draft, in: model.commands)
                    if !matches.isEmpty {
                        CommandPanel(matches: matches) { command in
                            // Trailing space: every one of these takes an
                            // argument or ends the message, and neither wants
                            // the caret jammed against the name.
                            model.draft = "/\(command.name) "
                            model.draftChanged()
                        }
                        .transition(.opacity)
                    }
                }
                .animation(.easeInOut(duration: 0.18), value: matchingCommands(model.draft, in: model.commands).count)

            Composer(
                // Not `$model.draft`. The side effect belongs to the write, not
                // to the value: `draft` is also assigned by opening a chat with
                // a saved draft, by starting an edit, by cancelling one, and by
                // sending — and an `onChange` on the property told everyone in
                // the conversation you were typing every one of those times,
                // then persisted whatever it saw as your draft. Android has
                // always routed only real edits through the broadcast.
                draft: Binding(
                    get: { model.draft },
                    set: { model.draft = $0; model.draftChanged() }
                ),
                replyTo: model.replyTo,
                editing: model.editing,
                pickerOpen: pickerOpen,
                canSend: !model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                accentOverride: model.conversation?.appearance?.titleColor,
                mentionable: model.mentionable,
                onSend: model.send,
                onCancelReply: { model.setReplyTo(nil) },
                onCancelEdit: model.cancelEditing,
                onTogglePicker: {
                    pickerOpen.toggle()
                    // The drawer and the keyboard want the same 300pt. Without
                    // this they both take it and the composer ends up off
                    // screen.
                    if pickerOpen {
                        // Fresh packs and recents on every open, so a pack made
                        // a minute ago is already here — no restart required.
                        model.refreshPickers()
                        UIApplication.shared.sendAction(
                            #selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil
                        )
                    }
                },
                onOpenPoll: { pollOpen = true },
                onOpenLocation: { locationOpen = true },
                onPickMedia: { pendingMedia = PendingMedia(picked: $0) },
                onSendVoice: { data, durationMs in
                    model.sendVoiceNote(data: data, durationMs: durationMs)
                },
                onSendVideoNote: { url, durationMs in
                    model.sendVideoNote(fileUrl: url, durationMs: durationMs)
                }
            )

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
                    onEmoji: { model.draft += $0; model.draftChanged() }
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
        // Only a channel has a space to go back out to.
        .simultaneousGesture(spaceId != nil ? backToSpaceSwipe : nil)
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
        /// Somebody screenshotted this conversation.
        ///
        /// iOS tells us afterwards and never beforehand, so this is a courtesy
        /// to the room rather than a control over it — nothing here could have
        /// stopped the capture, and a phone pointed at the screen is invisible
        /// to it entirely. Only fires while this chat is the one on screen,
        /// which is what makes "this conversation" true.
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.userDidTakeScreenshotNotification)) { _ in
            model.reportScreenshot()
        }
        .sheet(item: $actionTarget) { target in
            MessageActions(
                message: target,
                isMine: target.senderId == model.meId,
                isPinned: model.pinned.contains { $0.id == target.id },
                // DMs say it with the ticks; the sheet is for groups, where
                // one pair of ticks cannot name who is behind it.
                showSeenBy: target.senderId == model.meId && model.conversation?.type != "dm",
                onReact: { model.toggleReaction(target, emoji: $0) },
                onReply: { model.setReplyTo(target) },
                onThread: { onOpenThread(target.threadRootId ?? target.id) },
                onForward: { forwardTarget = target },
                onWhoReacted: { reactionsTarget = target },
                onSeenBy: { seenByTarget = target },
                onPin: { model.togglePin(target) },
                onEdit: { model.startEditing(target) },
                onDelete: { model.deleteMessage(target, forEveryone: true) },
                onDeleteForMe: { model.deleteMessage(target, forEveryone: false) }
            )
            .presentationDetents([.medium, .large])
            .presentationBackground(colors.surface)
        }
        .sheet(item: $seenByTarget) { target in
            SeenBySheet(entries: model.seenBy(target))
                .presentationDetents([.medium])
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
        // Full screen, because it is a decision rather than a panel: the chat
        // showing through would invite the same mis-tap this exists to catch.
        .fullScreenCover(item: $pendingMedia) { pending in
            AttachmentPreview(
                picked: pending.picked,
                // Whatever was already typed comes with it, so a caption
                // written before opening the picker is not thrown away.
                initialCaption: model.draft,
                onCancel: { pendingMedia = nil },
                onSend: { caption in
                    model.sendImage(pending.picked, caption: caption)
                    model.draft = ""
                    pendingMedia = nil
                }
            )
        }
        .sheet(isPresented: $locationOpen) {
            LocationShareSheet { duration in
                model.shareLocation(duration: duration)
                locationOpen = false
            }
            .presentationDetents([.medium, .large])
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

            if let spaceId {
                NeuIconButton(systemName: "number", label: "Channels", size: 42, iconSize: 17) {
                    onOpenSpace(spaceId)
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

    /// The space this channel belongs to, or nil when there is nothing to
    /// switch between (a DM, or a plain group).
    private var spaceId: String? { model.conversation?.parentId }

    /// A right-to-left drag goes out to the space, where the channels are.
    ///
    /// Mirrors `SwipeToReply` exactly and for the same reasons: attached with
    /// `simultaneousGesture` so it never steals the drag from the scroll view,
    /// bails the moment the gesture looks vertical, and ignores the opposite
    /// direction outright — rightward belongs to reply, and a row-level reply
    /// swipe must keep working while this is attached to the whole screen.
    private var backToSpaceSwipe: some Gesture {
        DragGesture(minimumDistance: 24)
            .onEnded { value in
                guard let spaceId else { return }
                let horizontal = value.translation.width
                guard horizontal < 0 else { return }
                guard abs(horizontal) > abs(value.translation.height) else { return }
                guard abs(horizontal) > 60 else { return }
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                onOpenSpace(spaceId)
            }
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

    /// "Here now" — who else has this conversation open.
    ///
    /// Faces, not a count: the whole value is recognising someone. Capped at
    /// five, past which it stops being people and starts being a crowd meter.
    private var hereNowBar: some View {
        HStack(spacing: 12) {
            HStack(spacing: -8) {
                ForEach(model.viewers.prefix(5)) { person in
                    Avatar(url: person.avatarUrl, name: person.label, id: person.id, size: 22)
                }
            }
            Text(hereNowLabel)
                .font(YappyFont.labelMedium)
                .foregroundStyle(colors.textSecondary)
                .lineLimit(1)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background(colors.dark.opacity(0.08), in: NeuShape(radius: Neu.cornerSmall))
        .padding(.horizontal, 14)
        .padding(.vertical, 4)
    }

    private var hereNowLabel: String {
        let people = model.viewers
        switch people.count {
        case 1: return "\(people[0].label) is here"
        case 2: return "\(people[0].label) and \(people[1].label) are here"
        default: return "\(people.count) people are here"
        }
    }

    // ── Timeline ─────────────────────────────────────────────────────────────

    /// The timeline, drawn upside down.
    ///
    /// Both flips together are the whole trick: the `ScrollView` is mirrored
    /// vertically and so is every row, which cancels out so the content reads
    /// the right way up — but the *scroll origin* is now the bottom of the
    /// screen. Android has had this from the start (`LazyColumn(reverseLayout =
    /// true)`); the iOS port used a forward list anchored with
    /// `defaultScrollAnchor(.bottom)`, and that is the difference behind three
    /// separate bugs:
    ///
    ///  - **The blank chat.** `defaultScrollAnchor` decides where content
    ///    *starts*; it does not re-anchor when the viewport later shrinks.
    ///    Raising the keyboard, opening the slash-command panel or the reply
    ///    bar all shorten the list's height, and the retained offset ends up
    ///    past the end of the content — a `LazyVStack` scrolled into empty
    ///    space unloads its cells, which is a blank white timeline. Anchored at
    ///    the natural origin instead, a shorter viewport simply reveals less
    ///    history and can never scroll into nothing.
    ///  - **Sending a message "fixed" it.** Appending re-ran the layout and
    ///    happened to bring the offset back into range.
    ///  - **Paging threw you up the timeline.** Older pages are appended at the
    ///    far end from the anchor, so the viewport does not move and there is
    ///    nothing to put back. The `hasScrolled` gate and the re-anchoring
    ///    dance both go away with it.
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
            // Newest first: index 0 sits at the anchored end, which the flip
            // puts at the bottom of the screen.
            let ordered = Array(model.messages.reversed())

            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 0) {
                        // Content top, which the flip makes the visual bottom —
                        // where a typist's bubble belongs. At the anchor, its
                        // appearance simply reveals itself; it never moves the
                        // reader.
                        if model.typingLabel != nil {
                            TypingRow(user: typist)
                                .scaleEffect(x: 1, y: -1, anchor: .center)
                                .transition(.opacity)
                        }

                        ForEach(Array(ordered.enumerated()), id: \.element.id) { index, message in
                            // Higher index is further back in time.
                            let older = index + 1 < ordered.count ? ordered[index + 1] : nil
                            let newer = index > 0 ? ordered[index - 1] : nil

                            VStack(spacing: 0) {
                                if YappyTime.crossesDay(older?.createdAt, message.createdAt) {
                                    DaySeparator(label: YappyTime.dayLabel(message.createdAt))
                                }
                                SwipeToReply(
                                    // Nothing to quote on a system line or a deleted
                                    // message, and a message still in flight has no
                                    // server id to reply to yet.
                                    enabled: !message.isSystem && !message.isDeleted && !message.isPending,
                                    onReply: { model.setReplyTo(message) }
                                ) {
                                    row(message: message, previous: older, next: newer)
                                }
                            }
                            .id(message.id)
                            .scaleEffect(x: 1, y: -1, anchor: .center)
                            .onAppear {
                                visibleIds.insert(message.id)
                                model.markRead(upTo: message.seq)
                            }
                            .onDisappear { visibleIds.remove(message.id) }
                        }

                        if model.loadingOlder {
                            NeuSpinner()
                                .padding(.vertical, 12)
                                .scaleEffect(x: 1, y: -1, anchor: .center)
                        }

                        // Reaching the far end means reaching the oldest message.
                        // Safe to fire unguarded: a page lands away from the anchor,
                        // so the reader does not move.
                        Color.clear
                            .frame(height: 1)
                            .onAppear { Task { await model.loadOlder() } }
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                }
                .scaleEffect(x: 1, y: -1, anchor: .center)
                // The indicator is mirrored along with everything else, and a
                // scrollbar that runs the wrong way is worse than none.
                .scrollIndicators(.hidden)
                .scrollDismissesKeyboard(.interactively)
                .overlay(alignment: .bottomTrailing) {
                    if !atBottom {
                        JumpToLatest(count: unseenCount) {
                            guard let newest = model.messages.last else { return }
                            // Content coordinates, not visual ones: the newest
                            // row is the top of the flipped content.
                            withAnimation(.easeOut(duration: 0.3)) {
                                proxy.scrollTo(newest.id, anchor: .top)
                            }
                        }
                        .padding(.trailing, 14)
                        .padding(.bottom, 12)
                        .transition(.scale(scale: 0.7).combined(with: .opacity))
                    }
                }
                .animation(.spring(response: 0.3, dampingFraction: 0.8), value: atBottom)
                .animation(.easeInOut(duration: 0.2), value: model.typingLabel != nil)
                .onChange(of: atBottom) { _, nowAtBottom in
                    awaySince = nowAtBottom
                        ? nil
                        : model.messages.last(where: { !$0.isPending })?.seq
                }
                .onChange(of: model.messages.last?.id) { _, _ in
                    // Your own send returns you to the bottom, however far up
                    // the history you were reading.
                    guard let newest = model.messages.last, newest.senderId == model.meId else { return }
                    withAnimation(.easeOut(duration: 0.25)) {
                        proxy.scrollTo(newest.id, anchor: .top)
                    }
                }
            }
        }
    }

    /// Whether the newest message's row is laid out. Before anything has been
    /// measured there is nothing to be away *from*, so the answer is yes.
    private var atBottom: Bool {
        guard let newest = model.messages.last else { return true }
        if visibleIds.isEmpty { return true }
        return visibleIds.contains(newest.id)
    }

    /// Messages from other people that landed after the reader scrolled away.
    private var unseenCount: Int {
        guard let awaySince else { return 0 }
        return model.messages.filter { $0.seq > awaySince && $0.senderId != model.meId }.count
    }

    /// Whoever has been typing longest, for the bubble's face.
    private var typist: PublicUser? {
        let now = Date()
        guard let entry = model.typing.first(where: { $0.expiresAt > now }) else { return nil }
        return model.members[entry.userId]
    }

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
            receipt: model.receiptState(for: message),
            names: model.memberNames,
            liveLocation: message.location != nil ? model.liveLocations[message.id] : nil,
            onLongPress: { actionTarget = message },
            onStopLocation: { model.stopSharing(messageId: message.id) },
            onDoubleTap: { model.toggleReaction(message, emoji: "❤️") },
            onReaction: { model.toggleReaction(message, emoji: $0) },
            onVote: { model.vote(message, optionId: $0) },
            onOpenThread: { onOpenThread(message.threadRootId ?? message.id) },
            // Opening one photo opens the whole conversation's photos,
            // positioned on this one — swiping between them is what people
            // expect once they are in there.
            onOpenMedia: { viewerAt = message.id },
            onPressComponent: { model.pressComponent($0, messageId: message.id) },
            onMention: openMention
        )
    }

    /// A tapped @mention. Members resolve locally; anyone else costs one
    /// lookup — a mention of someone outside the chat is still a person.
    private func openMention(_ username: String) {
        let needle = username.lowercased()
        if let member = model.members.values.first(where: { $0.username?.lowercased() == needle }) {
            onOpenProfile(member.id)
            return
        }
        Task {
            if let user = try? await container.repo.userByUsername(needle).user {
                onOpenProfile(user.id)
            } else {
                model.error = "Couldn't find @\(username)"
            }
        }
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

/// A pick waiting on confirmation. Wrapped for the same reason as above —
/// `Picked` is a plain value with no identity of its own.
private struct PendingMedia: Identifiable {
    let id = UUID()
    let picked: AttachmentUploader.Picked
}

// ── Swipe to reply ───────────────────────────────────────────────────────────

/// Drag a message to the right to reply to it.
///
/// The long-press sheet still has Reply and always will — this is the shortcut,
/// not the only route. It follows the convention everyone already knows: pull,
/// feel the tick when it will fire, let go.
///
/// Two things make it behave inside a scrolling timeline. The gesture is
/// *simultaneous*, so it never takes the drag away from the scroll view, and it
/// bails the moment a drag looks more vertical than horizontal — scrolling wins
/// ties, because a list that occasionally swallows a scroll is far more
/// annoying than one that occasionally misses a swipe.
///
/// The row is drawn inside the inverted timeline, so a downward drag arrives
/// here with its vertical translation negated. That is why only the *magnitude*
/// of the vertical component is ever read; the horizontal axis is not mirrored
/// and needs no correction.
private struct SwipeToReply<Content: View>: View {
    @Environment(\.neu) private var colors

    let enabled: Bool
    let onReply: () -> Void
    @ViewBuilder var content: () -> Content

    @State private var offset: CGFloat = 0
    /// Past the point where letting go replies. Tracked so the tick fires once
    /// on the way in rather than on every frame.
    @State private var armed = false

    /// Far enough to be deliberate, close enough to reach with a thumb.
    private let trigger: CGFloat = 56
    private let limit: CGFloat = 76

    var body: some View {
        content()
            .offset(x: offset)
            .background(alignment: .leading) { indicator }
            .animation(.interactiveSpring(response: 0.25, dampingFraction: 0.8), value: offset)
            .simultaneousGesture(enabled ? swipe : nil)
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
                guard horizontal > 0 else { return }

                // Resistance past the trigger, so the bubble tells you it has
                // gone as far as it usefully can.
                offset = horizontal <= trigger
                    ? horizontal
                    : min(trigger + (horizontal - trigger) * 0.3, limit)

                if offset >= trigger, !armed {
                    armed = true
                    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                } else if offset < trigger {
                    armed = false
                }
            }
            .onEnded { _ in
                if armed { onReply() }
                armed = false
                offset = 0
            }
    }

    /// Sits at the row's leading edge, behind the bubble, and is uncovered as
    /// the bubble slides off it — so the gesture explains itself the first time
    /// rather than having to be discovered.
    ///
    /// Deliberately given no offset of its own. `.offset` moves what is drawn
    /// but not the layout frame, so `.background` anchors to where the row
    /// *would* be; nudging the arrow further left from there puts it off the
    /// side of the screen, which is where it spent its first draft.
    private var indicator: some View {
        let progress = min(offset / trigger, 1)

        return Image(systemName: "arrowshape.turn.up.left.fill")
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(offset >= trigger ? colors.accent : colors.textTertiary)
            .frame(width: 32, height: 32)
            .background(colors.dark.opacity(0.08), in: Circle())
            .scaleEffect(0.6 + 0.4 * progress)
            .opacity(Double(progress))
            .allowsHitTesting(false)
    }
}

// ── Typing bubble ────────────────────────────────────────────────────────────

/// The three dots at the foot of the timeline while someone writes. The header
/// already says who in words; this is the version people actually watch for.
private struct TypingRow: View {
    @Environment(\.neu) private var colors
    let user: PublicUser?

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            Avatar(
                url: user?.avatarUrl,
                name: user?.label,
                id: user?.id ?? "typing",
                size: 26
            )
            TypingDots()
                .padding(.horizontal, 15)
                .padding(.vertical, 13)
                .background(colors.incoming, in: Capsule())
            Spacer(minLength: 0)
        }
        .padding(.top, 8)
        .accessibilityLabel("\(user?.label ?? "Someone") is typing")
    }
}

private struct TypingDots: View {
    @Environment(\.neu) private var colors
    @State private var tick = 0

    var body: some View {
        HStack(spacing: 4) {
            ForEach(0..<3, id: \.self) { index in
                Circle()
                    .fill(colors.textTertiary)
                    .frame(width: 7, height: 7)
                    .opacity(tick % 3 == index ? 1 : 0.35)
                    .scaleEffect(tick % 3 == index ? 1.15 : 0.85)
            }
        }
        .animation(.easeInOut(duration: 0.28), value: tick)
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(340))
                tick += 1
            }
        }
    }
}

// ── Jump to latest ───────────────────────────────────────────────────────────

/// The way back down. Floats over the timeline once the newest message has
/// scrolled off, wearing a count of what has arrived since.
private struct JumpToLatest: View {
    @Environment(\.neu) private var colors
    let count: Int
    let onTap: () -> Void

    var body: some View {
        Image(systemName: "chevron.down")
            .font(.system(size: 17, weight: .semibold))
            .foregroundStyle(colors.textSecondary)
            .frame(width: 44, height: 44)
            .neu(Circle(), colors, state: .raised, elevation: 7)
            .overlay(alignment: .topTrailing) {
                if count > 0 {
                    Text(count > 99 ? "99+" : "\(count)")
                        .font(YappyFont.labelSmall)
                        .foregroundStyle(colors.onAccent)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(colors.accent, in: Capsule())
                        .offset(x: 6, y: -6)
                }
            }
            .contentShape(Circle())
            .softTap(action: onTap)
            .accessibilityLabel(count > 0 ? "\(count) new messages, jump to latest" : "Jump to latest")
    }
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
    let showSeenBy: Bool
    let onReact: (String) -> Void
    let onReply: () -> Void
    let onThread: () -> Void
    let onForward: () -> Void
    let onWhoReacted: () -> Void
    let onSeenBy: () -> Void
    let onPin: () -> Void
    let onEdit: () -> Void
    let onDelete: () -> Void
    let onDeleteForMe: () -> Void

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
                if showSeenBy {
                    row("eye", "Seen by") { onSeenBy() }
                }
                if let content = message.content, !content.isEmpty {
                    row("doc.on.doc", "Copy text") { UIPasteboard.general.string = content }
                }
                row("pin.fill", isPinned ? "Unpin" : "Pin") { onPin() }

                if isMine, message.type == "text", !message.isDeleted {
                    row("pencil", "Edit") { onEdit() }
                }
                // Offered for *anyone's* message, unlike "for everyone": hiding
                // something from your own timeline needs no authority over the
                // person who said it, and being unable to dismiss a message
                // someone else sent is exactly when you most want to.
                if !message.isDeleted {
                    row("eye.slash", "Delete for me") { onDeleteForMe() }
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

// ── Seen by ──────────────────────────────────────────────────────────────────

/// Who has read a group message. Fed from the watermarks the chat already
/// holds, so opening it costs nothing — and members who turned read receipts
/// off are simply absent, the same as everywhere else receipts appear.
private struct SeenBySheet: View {
    @Environment(\.neu) private var colors

    let entries: [ReceiptEntry]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Text(entries.isEmpty ? "Seen by nobody yet" : "Seen by \(entries.count)")
                    .font(YappyFont.titleMedium)
                    .foregroundStyle(colors.textPrimary)
                    .padding(.bottom, entries.isEmpty ? 0 : 12)

                ForEach(entries) { entry in
                    HStack(spacing: 12) {
                        Avatar(
                            url: entry.user.avatarUrl,
                            name: entry.user.displayName ?? entry.user.username,
                            id: entry.user.id,
                            size: 40
                        )
                        VStack(alignment: .leading, spacing: 1) {
                            Text(entry.user.displayName ?? entry.user.username ?? "unknown")
                                .font(YappyFont.titleSmall)
                                .foregroundStyle(colors.textPrimary)
                            if let username = entry.user.username {
                                Text("@\(username)")
                                    .font(YappyFont.labelSmall)
                                    .foregroundStyle(colors.textTertiary)
                            }
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.vertical, 8)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 20)
            .padding(.top, 22)
            .padding(.bottom, 28)
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

/// The campfire countdown.
///
/// Always visible rather than tucked into a settings screen, because the end is
/// the whole point of the room — a temporary place whose temporariness you have
/// to go looking for is just a group that deletes itself by surprise. Ticks once
/// a minute until the last hour, then every second, so the final stretch reads
/// as urgent without burning a frame a second all day.
struct CampfireBar: View {
    let endsAt: String
    @Environment(\.neu) private var colors
    @State private var remaining: TimeInterval = 0

    private var deadline: Date? { YappyTime.parse(endsAt) }
    private var urgent: Bool { remaining < 3600 }

    var body: some View {
        HStack(spacing: 9) {
            Text("🔥").font(YappyFont.labelMedium)
            Text(
                remaining <= 0
                    ? "This campfire is going out…"
                    : "Burns down in \(Self.countdown(remaining))"
            )
            .font(YappyFont.labelMedium)
            .foregroundStyle(urgent ? colors.danger : colors.textSecondary)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(
            urgent ? colors.danger.opacity(0.14) : colors.dark.opacity(0.08),
            in: NeuShape(radius: Neu.cornerSmall)
        )
        .padding(.horizontal, 14)
        .padding(.vertical, 4)
        .task(id: endsAt) {
            guard let deadline else { return }
            while !Task.isCancelled {
                remaining = deadline.timeIntervalSinceNow
                // Nanoseconds, and the interval widens once the end is far
                // enough away that a per-second redraw buys nothing.
                try? await Task.sleep(nanoseconds: remaining < 3600 ? 1_000_000_000 : 60_000_000_000)
            }
        }
    }

    /// Coarse on purpose: nobody needs "6 days, 4 hours, 12 minutes and 9 seconds".
    static func countdown(_ interval: TimeInterval) -> String {
        let seconds = Int(max(interval, 0))
        let days = seconds / 86_400
        let hours = (seconds % 86_400) / 3_600
        let minutes = (seconds % 3_600) / 60
        if days > 0 { return hours > 0 ? "\(days)d \(hours)h" : "\(days)d" }
        if hours > 0 { return minutes > 0 ? "\(hours)h \(minutes)m" : "\(hours)h" }
        if minutes > 0 { return "\(minutes)m \(seconds % 60)s" }
        return "\(seconds)s"
    }
}
