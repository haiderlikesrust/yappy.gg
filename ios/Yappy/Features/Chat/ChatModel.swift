import Combine
import Foundation

struct TypingUser {
    let userId: String
    let expiresAt: Date
}

@MainActor
final class ChatModel: ObservableObject {
    @Published private(set) var conversation: Conversation?
    @Published private(set) var messages: [Message] = []
    @Published private(set) var pinned: [Message] = []
    @Published private(set) var loading = true
    @Published private(set) var loadingOlder = false
    @Published private(set) var hasMore = true
    @Published private(set) var members: [String: PublicUser] = [:]
    @Published private(set) var commands: [BotCommand] = []
    @Published private(set) var meId: String?
    @Published private(set) var typing: [TypingUser] = []
    @Published private(set) var stickerPacks: [StickerPack] = []
    @Published private(set) var recentStickers: [Sticker] = []
    @Published private(set) var gifs: [GifResult] = []
    @Published private(set) var gifsLoading = false
    /// customId of a button waiting on the server, so it can show a spinner.
    @Published private(set) var pressingComponent: String?
    /// What the list that sent us here already knew, drawn until the real
    /// conversation lands.
    @Published private(set) var headerSeed: ChatHeaderSeed?
    /// userId → their read/delivered watermarks. The ticks on outgoing bubbles
    /// and the seen-by sheet are both views over this one dictionary.
    @Published private(set) var receipts: [String: ReceiptEntry] = [:]
    @Published var error: String?

    @Published var draft = ""
    @Published var replyTo: Message?
    @Published var editing: Message?
    @Published var gifQuery = ""

    private var conversationId = ""
    private var container: AppContainer?
    private var cancellables = Set<AnyCancellable>()
    private var typingTask: Task<Void, Never>?
    private var readAckTask: Task<Void, Never>?
    /// The highest seq the user has actually had on screen, and the highest the
    /// server has been told about.
    private var highestRead: Int64 = 0
    private var ackedRead: Int64 = 0
    private var gifTask: Task<Void, Never>?
    private var sweeper: Task<Void, Never>?
    private var lastTypingSent = Date.distantPast
    private var started = false

    var typingLabel: String? {
        let now = Date()
        let active = typing.filter { $0.expiresAt > now }
        guard !active.isEmpty else { return nil }

        let names = active.compactMap { members[$0.userId]?.label }
        switch names.count {
        case 0: return "typing…"
        case 1: return "\(names[0]) is typing…"
        case 2: return "\(names[0]) and \(names[1]) are typing…"
        default: return "\(names.count) people are typing…"
        }
    }

    /// Everyone who can be @-mentioned here — the composer's autocomplete pool.
    var mentionable: [PublicUser] {
        members.values.filter { $0.id != meId }.sorted { $0.label < $1.label }
    }

    var isPinned: (String) -> Bool {
        { [pinned] id in pinned.contains { $0.id == id } }
    }

    // ── Receipts ─────────────────────────────────────────────────────────────

    /// The tick an outgoing bubble shows.
    ///
    /// DMs get the full WhatsApp ladder. Groups skip the delivered rung on
    /// purpose: "delivered to all" needs every member's watermark aggregated
    /// live, and the honest signals a group actually has are "it is on the
    /// server" and "everyone has read it" — the in-between is what the seen-by
    /// sheet is for.
    func receiptState(for message: Message) -> MessageReceiptState {
        guard message.senderId == meId else { return .none }
        if message.isPending { return .pending }

        let others = receipts.values.filter { $0.user.id != meId }
        guard !others.isEmpty else { return .sent }

        if conversation?.type == "dm" {
            guard let theirs = others.first else { return .sent }
            if theirs.seq >= message.seq { return .read }
            if theirs.deliveredSeq >= message.seq { return .delivered }
            return .sent
        }

        return others.allSatisfy { $0.seq >= message.seq } ? .read : .sent
    }

    /// Who has read this message — the seen-by sheet. Excludes the sender;
    /// members who turned read receipts off are absent from the source data.
    func seenBy(_ message: Message) -> [ReceiptEntry] {
        receipts.values
            .filter { $0.user.id != message.senderId && $0.seq >= message.seq }
            .sorted { $0.user.label < $1.user.label }
    }

    // ── Lifecycle ────────────────────────────────────────────────────────────

    func start(_ container: AppContainer, conversationId: String) {
        guard !started else { return }
        started = true
        self.container = container
        self.conversationId = conversationId
        meId = container.session.userId
        headerSeed = container.headerSeeds[conversationId]

        load()
        observeGateway(container)
        loadPickers()
    }

    func stop() {
        container?.gateway.typing(conversationId, started: false)
        typingTask?.cancel()
        readAckTask?.cancel()
        sweeper?.cancel()

        // Hand the timeline over before anything can return early below — this
        // is what the next visit draws, and it has to include the message that
        // was just sent. Pending rows are dropped: a placeholder restored as a
        // placeholder would sit there for ever with no request behind it.
        container?.rememberTimeline(
            messages.filter { !$0.isPending },
            receipts: receipts,
            for: conversationId
        )

        // Leaving is the last chance to record what was read — the 500ms
        // debounce is very often still pending when someone glances at a
        // channel and taps straight back.
        guard let container, highestRead > ackedRead else { return }
        let seq = highestRead
        let id = conversationId
        let repo = container.repo
        ackedRead = seq
        // Detached, because this model is being torn down with the view and a
        // task owned by it would be cancelled before the request went out.
        Task.detached { _ = try? await repo.markRead(id, seq: seq) }
        container.conversationRead.send(id)
    }

    private func load() {
        guard let container else { return }

        // Paint the last-seen page while the real one is fetched. Read marks
        // and the subscription wait for the fresh copy — acting on a cached
        // page would acknowledge messages the person has not seen yet.
        //
        // Memory first, disk only as the cold-start fallback. The disk slot is
        // written when a *fetch* completes, so it is a snapshot of the chat as
        // it was when you last opened it — send a message and it is instantly
        // out of date. Painting that on re-entry showed the timeline without
        // the message you had just sent, and then the fetch put it back: the
        // message appeared to send itself a second time. What you last had on
        // screen is the honest thing to redraw.
        if messages.isEmpty {
            if let remembered = container.timeline(for: conversationId) {
                messages = remembered.messages
                // Restored together with the messages, or every one of your own
                // bubbles would redraw as a single grey check and then turn
                // blue again as the receipts land.
                receipts = remembered.receipts
                for message in remembered.messages {
                    if let sender = message.sender { members[sender.id] = sender }
                }
                loading = false
            } else if let cached = DiskCache.decode(HistoryEnvelope.self, key: "history_\(conversationId)") {
                messages = cached.messages
                for message in cached.messages {
                    if let sender = message.sender { members[sender.id] = sender }
                }
                loading = false
            }
        }

        Task {
            do {
                // Three fetches, started together. Serially these were three
                // round trips end to end before the first bubble could settle;
                // the timeline needs only the second of them.
                let conversationTask = Task { try await container.repo.conversation(self.conversationId).conversation }
                let historyTask = Task { try await container.repo.history(self.conversationId, limit: 50) }
                let pinsTask = Task { (try? await container.repo.pins(self.conversationId).pins.map(\.message)) ?? [] }

                let conversation = try await conversationTask.value
                let history = try await historyTask.value
                let pins = await pinsTask.value

                var people: [String: PublicUser] = members
                if let other = conversation.otherUser { people[other.id] = other }
                for member in conversation.memberPreview { people[member.id] = member }
                for message in history.messages {
                    if let sender = message.sender { people[sender.id] = sender }
                }

                self.conversation = conversation
                container.headerSeeds.remember(conversation)
                messages = history.messages
                pinned = pins
                hasMore = history.hasMore
                loading = false
                draft = conversation.selfState?.draft ?? ""
                members = people

                container.gateway.subscribe(conversationId)
                markRead(upTo: history.messages.last?.seq ?? 0)

                // Independent follow-ups, in parallel rather than one after the
                // other. Fetched once per conversation: the command list is
                // small, and the composer must answer a "/" keypress instantly.
                Task { [weak self] in
                    guard let self, let container = self.container else { return }
                    if let list = try? await container.repo.conversationCommands(self.conversationId).commands {
                        self.commands = list
                    }
                }

                // Everyone's read/delivered watermarks, for the ticks. Live
                // receipt events keep it current from here on.
                Task { [weak self] in
                    guard let self, let container = self.container else { return }
                    if let entries = try? await container.repo.receipts(self.conversationId).readBy {
                        self.receipts = Dictionary(
                            entries.map { ($0.user.id, $0) },
                            uniquingKeysWith: { first, _ in first }
                        )
                    }
                }

                // Full member list for @-mention autocomplete. Groups only — a
                // DM's two participants are already in the map.
                if conversation.type != "dm" {
                    Task { [weak self] in
                        guard let self, let container = self.container else { return }
                        if let list = try? await container.repo.members(self.conversationId).members {
                            for entry in list { self.members[entry.user.id] = entry.user }
                        }
                    }
                }
            } catch let failure as ApiError {
                loading = false
                error = failure.message
            } catch {
                loading = false
            }
        }
    }

    /// Page in the previous fifty messages.
    ///
    /// Nothing here has to preserve a scroll position. The timeline is drawn
    /// inverted, so a prepend lands at the far end from the scroll anchor and
    /// the reader simply gains more history above them — which is also why this
    /// can be fired the moment the oldest bubble comes into view, with no
    /// "has the user scrolled yet" gate.
    func loadOlder() async {
        guard let container, !loadingOlder, hasMore, let oldest = messages.first?.seq else { return }
        loadingOlder = true
        defer { loadingOlder = false }

        guard let page = try? await container.repo.history(conversationId, before: oldest, limit: 50) else {
            return
        }
        // Prepend, and de-duplicate by id: a live event can land in the same
        // window a page request is covering.
        var seen = Set(messages.map(\.id))
        let fresh = page.messages.filter { seen.insert($0.id).inserted }
        guard !fresh.isEmpty else {
            hasMore = page.hasMore
            return
        }
        messages = fresh + messages
        hasMore = page.hasMore
        for message in fresh {
            if let sender = message.sender { members[sender.id] = sender }
        }
    }

    private func loadPickers() {
        guard let container else { return }
        Task {
            if let packs = try? await container.repo.installedPacks().packs { stickerPacks = packs }
            if let recent = try? await container.repo.recentStickers().stickers { recentStickers = recent }
            if let recentGifs = try? await container.repo.recentGifs().results { gifs = recentGifs }
        }
    }

    // ── Composing ────────────────────────────────────────────────────────────

    func draftChanged() {
        guard let container else { return }

        // Throttled to one every three seconds: the server refreshes an 8s TTL,
        // so anything faster is wasted frames on every other member's device.
        let now = Date()
        if !draft.isEmpty, now.timeIntervalSince(lastTypingSent) > 3 {
            lastTypingSent = now
            container.gateway.typing(conversationId, started: true)
        }

        typingTask?.cancel()
        typingTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(4))
            guard !Task.isCancelled, let self else { return }
            container.gateway.typing(conversationId, started: false)
            lastTypingSent = .distantPast
            // The draft is synced to the server so it follows the user across
            // devices, but only once they stop typing.
            _ = try? await container.repo.setConversationState(conversationId, draft: draft)
        }
    }

    func setReplyTo(_ message: Message?) {
        replyTo = message
        editing = nil
    }

    func startEditing(_ message: Message) {
        editing = message
        draft = message.content ?? ""
        replyTo = nil
    }

    func cancelEditing() {
        editing = nil
        draft = ""
    }

    /// Send with an optimistic bubble.
    ///
    /// The nonce is generated here and reused as the local message id, so when
    /// the server's copy arrives over the socket it replaces the placeholder
    /// instead of appearing beside it.
    func send() {
        guard let container else { return }
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }

        if let target = editing {
            draft = ""
            editing = nil
            Task {
                if let updated = try? await container.repo.editMessage(
                    conversationId, messageId: target.id, content: text
                ) {
                    replace(updated.message)
                }
            }
            return
        }

        let nonce = YappyRepository.newNonce()
        let pendingReply = replyTo
        let optimistic = Message(
            id: nonce,
            conversationId: conversationId,
            seq: Message.pendingSeq,
            type: "text",
            content: text,
            sender: meId.flatMap { members[$0] },
            senderId: meId,
            replyTo: pendingReply.map {
                ReplyStub(id: $0.id, seq: $0.seq, senderId: $0.senderId, preview: $0.content, type: $0.type)
            },
            createdAt: YappyTime.now(),
            nonce: nonce
        )

        messages.append(optimistic)
        draft = ""
        replyTo = nil
        container.gateway.typing(conversationId, started: false)

        Task {
            do {
                let sent = try await container.repo.sendText(
                    conversationId,
                    text: text,
                    nonce: nonce,
                    replyToId: pendingReply?.id,
                    mentions: mentionSpans(in: text)
                )
                replacePending(nonce: nonce, with: sent.message)
            } catch let failure as ApiError {
                // Leave the bubble in place but surface the reason — silently
                // dropping a message the user watched appear is much worse.
                error = failure.message
            } catch {
                self.error = "Could not send that."
            }
        }
    }

    /// Send a picked photo.
    ///
    /// The bubble appears immediately showing the *local* file, so the upload
    /// happens behind something the user can already see. A failed upload
    /// removes the bubble and surfaces the reason rather than leaving a
    /// permanent ghost.
    func sendImage(_ picked: AttachmentUploader.Picked) {
        guard let container else { return }
        let nonce = YappyRepository.newNonce()
        let caption = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let localUrl = LocalMediaCache.shared.store(picked.data, id: nonce)

        let optimistic = Message(
            id: nonce,
            conversationId: conversationId,
            seq: Message.pendingSeq,
            type: "image",
            content: caption.isEmpty ? nil : caption,
            sender: meId.flatMap { members[$0] },
            senderId: meId,
            attachments: [
                Attachment(
                    id: nonce,
                    url: localUrl,
                    mimeType: picked.mimeType,
                    width: picked.width,
                    height: picked.height
                ),
            ],
            createdAt: YappyTime.now(),
            nonce: nonce
        )

        messages.append(optimistic)
        draft = ""

        Task {
            do {
                let uploaded = try await container.uploader.upload(picked)
                let sent = try await container.repo.sendAttachment(
                    conversationId,
                    attachmentIds: [uploaded.mediaId],
                    caption: caption.isEmpty ? nil : caption,
                    nonce: nonce
                )
                replacePending(nonce: nonce, with: sent.message)
            } catch {
                messages.removeAll { $0.id == nonce }
                self.error = (error as? ApiError)?.message ?? "Could not send that photo"
            }
            LocalMediaCache.shared.discard(id: nonce)
        }
    }

    func sendSticker(_ sticker: Sticker) {
        guard let container else { return }
        Task {
            if let sent = try? await container.repo.sendSticker(conversationId, stickerId: sticker.id) {
                appendIfMissing(sent.message)
            }
        }
    }

    func sendGif(_ gif: GifResult) {
        guard let container else { return }
        Task {
            if let sent = try? await container.repo.sendGif(conversationId, gif: gif) {
                appendIfMissing(sent.message)
            }
            _ = try? await container.repo.rememberGif(gif)
        }
    }

    func sendPoll(question: String, options: [String], multiSelect: Bool) {
        guard let container else { return }
        Task {
            if let sent = try? await container.repo.sendPoll(
                conversationId, question: question, options: options, multiSelect: multiSelect
            ) {
                appendIfMissing(sent.message)
            }
        }
    }

    /// Press a button on a bot's message.
    ///
    /// Not optimistic. Everywhere else in this app a local guess is right often
    /// enough to be worth it, but a button's effect is the bot's to decide — it
    /// may approve a sign-in, refuse, or find the request already expired — and
    /// showing an outcome we invented would sometimes be a lie about something
    /// that matters. So: spinner, then whatever the server says the message now
    /// is.
    func pressComponent(_ button: MessageButton, messageId: String) {
        guard let container, pressingComponent == nil else { return }
        pressingComponent = button.customId

        Task {
            defer { pressingComponent = nil }
            do {
                let updated = try await container.repo.pressComponent(
                    conversationId, messageId: messageId, customId: button.customId
                )
                replace(updated.message)
            } catch let failure as ApiError {
                error = failure.message
            } catch {}
        }
    }

    /// Mentions are derived from the final text rather than tracked while
    /// typing: whatever "@username" tokens survive editing are what gets sent,
    /// which matches what the user sees.
    /// Offsets are UTF-16 code units, not Swift `Character`s.
    ///
    /// The whole stack that reads these back is JavaScript, where a string is
    /// indexed by UTF-16 code unit, and Android emits `String.indexOf`, which is
    /// the same. Counting graphemes here meant any mention typed after an emoji
    /// was stored a unit or two short of where it actually is — one offset for
    /// "🎉", seven for a family emoji.
    private func mentionSpans(in text: String) -> [YappyRepository.MentionSpan] {
        var spans: [YappyRepository.MentionSpan] = []

        for user in members.values {
            guard let username = user.username, !username.isEmpty else { continue }
            let needle = "@\(username)"
            var searchFrom = text.startIndex

            while let found = text.range(of: needle, range: searchFrom ..< text.endIndex) {
                let after = found.upperBound < text.endIndex ? text[found.upperBound] : nil
                // A trailing letter or digit means this is a longer username
                // that merely starts with ours.
                if after == nil || !(after!.isLetter || after!.isNumber) {
                    let offset = text.utf16.distance(from: text.utf16.startIndex, to: found.lowerBound)
                    spans.append(.init(offset: offset, length: needle.utf16.count, userId: user.id))
                }
                searchFrom = found.upperBound
            }
        }
        return spans
    }

    func forward(_ message: Message, to conversationId: String) {
        guard let container else { return }
        Task {
            try? await container.repo.forward(messageIds: [message.id], toConversationIds: [conversationId])
        }
    }

    // ── Message actions ──────────────────────────────────────────────────────

    func toggleReaction(_ message: Message, emoji: String) {
        guard let container else { return }
        let had = message.myReactions.contains(emoji)

        // Applied locally first: a reaction that waits for a round trip feels
        // broken, and the server event will reconcile either way.
        patch(message.id) { current in
            let next = (current.reactions[emoji] ?? 0) + (had ? -1 : 1)
            if next <= 0 {
                current.reactions.removeValue(forKey: emoji)
            } else {
                current.reactions[emoji] = next
            }
            if had {
                current.myReactions.removeAll { $0 == emoji }
            } else {
                current.myReactions.append(emoji)
            }
        }

        Task {
            if had {
                try? await container.repo.unreact(conversationId, messageId: message.id, emoji: emoji)
            } else {
                try? await container.repo.react(conversationId, messageId: message.id, emoji: emoji)
            }
        }
    }

    func togglePin(_ message: Message) {
        guard let container else { return }
        let currentlyPinned = pinned.contains { $0.id == message.id }
        Task {
            do {
                if currentlyPinned {
                    try await container.repo.unpin(conversationId, messageId: message.id)
                    pinned.removeAll { $0.id == message.id }
                } else {
                    try await container.repo.pin(conversationId, messageId: message.id)
                    pinned.append(message)
                }
            } catch {}
        }
    }

    func deleteMessage(_ message: Message, forEveryone: Bool) {
        guard let container else { return }
        Task {
            try? await container.repo.deleteMessage(
                conversationId, messageId: message.id, forEveryone: forEveryone
            )
            patch(message.id) {
                $0.deletedAt = YappyTime.now()
                $0.content = nil
            }
        }
    }

    func vote(_ message: Message, optionId: String) {
        guard let container, let poll = message.poll else { return }
        let next: [String]
        if poll.multiSelect, poll.myVotes.contains(optionId) {
            next = poll.myVotes.filter { $0 != optionId }
        } else if poll.multiSelect {
            next = poll.myVotes + [optionId]
        } else if poll.myVotes.contains(optionId) {
            next = []
        } else {
            next = [optionId]
        }

        patch(message.id) { $0.poll?.myVotes = next }
        Task {
            try? await container.repo.votePoll(conversationId, messageId: message.id, optionIds: next)
        }
    }

    func reactionDetails(for message: Message) async -> [ReactionDetail] {
        guard let container else { return [] }
        return (try? await container.repo.reactionsFor(conversationId, messageId: message.id).reactions) ?? []
    }

    func forwardCandidates() async -> [Conversation] {
        guard let container else { return [] }
        return (try? await container.repo.conversations().conversations) ?? []
    }

    // ── GIF picker ───────────────────────────────────────────────────────────

    func searchGifs(_ query: String) {
        guard let container else { return }
        gifQuery = query
        gifsLoading = true
        gifTask?.cancel()

        gifTask = Task {
            try? await Task.sleep(for: .milliseconds(300)) // debounce keystrokes
            guard !Task.isCancelled, gifQuery == query else { return }
            let result = query.isEmpty
                ? try? await container.repo.recentGifs()
                : try? await container.repo.searchGifs(query)
            guard !Task.isCancelled else { return }
            gifs = result?.results ?? []
            gifsLoading = false
        }
    }

    // ── Read state ───────────────────────────────────────────────────────────

    /// Debounced: scrolling fires this constantly and only the highest matters.
    ///
    /// The highest is tracked rather than "whatever fired last". Rows report
    /// themselves as they appear, and scrolling *up* through history makes the
    /// most recent call the *oldest* message — acking that would move the read
    /// cursor backwards and leave the badge up.
    func markRead(upTo seq: Int64) {
        guard seq > highestRead else { return }
        highestRead = seq

        readAckTask?.cancel()
        readAckTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(500))
            guard !Task.isCancelled, let self else { return }
            await flushRead()
        }
    }

    /// Records the highest message actually seen.
    ///
    /// Over the socket when it is up, because this fires on every scroll and a
    /// round-tripped request each time is wasteful for something nobody waits
    /// on. Over REST when it is not: a socket that is still connecting drops
    /// sends on the floor, and that is exactly the moment a chat opened from a
    /// cold start does its first ack — which is why a channel you had read
    /// still showed "1" until you typed in it.
    private func flushRead() async {
        guard let container, highestRead > ackedRead else { return }
        let seq = highestRead
        ackedRead = seq

        if container.gateway.state.isConnected {
            container.gateway.markRead(conversationId, seq: seq)
        } else if (try? await container.repo.markRead(conversationId, seq: seq)) == nil {
            // Let a later scroll or the flush on leaving try again.
            ackedRead = 0
            return
        }

        conversation?.selfState?.lastReadSeq = seq
        conversation?.selfState?.unreadCount = 0
        conversation?.selfState?.mentionCount = 0
        // The server echoes this back as conversation.state_update, but not
        // always before the user is looking at the list again.
        container.conversationRead.send(conversationId)
    }

    // ── Calls ────────────────────────────────────────────────────────────────

    func startCall(video: Bool) async -> String? {
        guard let container else { return nil }
        return try? await container.repo.startCall(conversationId, video: video).call.id
    }

    // ── Live events ──────────────────────────────────────────────────────────

    private func observeGateway(_ container: AppContainer) {
        container.gateway.events
            .sink { [weak self] event in self?.handle(event, container) }
            .store(in: &cancellables)

        // Reconnecting is the moment to reconcile.
        //
        // Anything the server dispatched while the socket was down was never
        // delivered, and READY carries sequence numbers and previews — not
        // message bodies. Nothing used to pull the difference, so an open chat
        // simply never showed what it missed: the conversation row's preview
        // updated in the list while the timeline sat unchanged, until the chat
        // was closed and reopened and `load()` refetched over REST. That is the
        // whole of "the bot never replied, but the reply is there when I go
        // back in".
        container.gateway.$state
            .map(\.isConnected)
            .removeDuplicates()
            .sink { [weak self] connected in
                guard let self, connected else { return }
                container.gateway.subscribe(conversationId)
                Task { await self.reconcile() }
            }
            .store(in: &cancellables)

        // Typing indicators expire client-side too; the stop event can be lost.
        sweeper = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(2))
                guard let self else { return }
                let now = Date()
                let live = typing.filter { $0.expiresAt > now }
                if live.count != typing.count { typing = live }
            }
        }
    }

    /// Pull whatever landed while the socket was down.
    ///
    /// Guarded on `loading` so the initial connect — `@Published` replays its
    /// current value the moment this subscribes — does not fire a second fetch
    /// on top of the one `load()` is already doing.
    private func reconcile() async {
        guard let container, !loading else { return }
        let head = messages.last(where: { !$0.isPending })?.seq ?? 0
        guard let page = try? await container.repo.history(conversationId, after: head, limit: 50) else {
            return
        }
        for message in page.messages { appendIfMissing(message) }
        if let newest = page.messages.last?.seq { markRead(upTo: newest) }
    }

    private func handle(_ event: GatewayEvent, _ container: AppContainer) {
        let data = event.data
        let target = data["conversationId"]?.stringValue

        switch event.type {
        case "message.create":
            guard target == conversationId, let message = Self.decodeMessage(data) else { return }
            appendIfMissing(message)
            markRead(upTo: message.seq)

        case "message.update":
            guard target == conversationId, let message = Self.decodeMessage(data) else { return }
            replace(message)

        case "message.delete":
            guard target == conversationId, let id = data["id"]?.stringValue else { return }
            patch(id) {
                $0.deletedAt = YappyTime.now()
                $0.content = nil
            }

        case "reaction.add", "reaction.remove":
            guard target == conversationId,
                  let id = data["messageId"]?.stringValue,
                  let emoji = data["emoji"]?.stringValue
            else { return }
            // Skip our own echo — the optimistic update already applied it, and
            // re-applying would double-count.
            if let userId = data["userId"]?.stringValue, userId == meId { return }

            let adding = event.type == "reaction.add"
            patch(id) { current in
                let next = (current.reactions[emoji] ?? 0) + (adding ? 1 : -1)
                if next <= 0 {
                    current.reactions.removeValue(forKey: emoji)
                } else {
                    current.reactions[emoji] = next
                }
            }

        case "typing.start":
            guard target == conversationId,
                  let userId = data["userId"]?.stringValue,
                  userId != meId
            else { return }
            typing.removeAll { $0.userId == userId }
            typing.append(TypingUser(userId: userId, expiresAt: Date().addingTimeInterval(8)))

        case "typing.stop":
            guard let userId = data["userId"]?.stringValue else { return }
            typing.removeAll { $0.userId == userId }

        case "pin.add", "pin.remove":
            guard target == conversationId else { return }
            Task {
                if let pins = try? await container.repo.pins(conversationId).pins.map(\.message) {
                    pinned = pins
                }
            }

        // Close rides the same refetch as a vote: the payload carries neither
        // tallies nor state, and the message row is the single source of both.
        // Without the close case a poll went on looking open — votes still
        // updating — until the chat was reopened.
        case "poll.vote", "poll.close":
            guard target == conversationId, let messageId = data["messageId"]?.stringValue else { return }
            Task {
                let around = messages.first { $0.id == messageId }?.seq
                if let refreshed = try? await container.repo.history(conversationId, around: around).messages
                    .first(where: { $0.id == messageId }) {
                    replace(refreshed)
                }
            }

        /**
         * Somebody's watermark moved. Monotonic by construction server-side,
         * but clamped here too — events can arrive out of order across a
         * reconnect, and a tick that goes backwards reads as a glitch.
         * A read at seq N implies delivery at N, which is also how the server
         * writes it.
         */
        case "read.receipt":
            guard target == conversationId,
                  let userId = data["userId"]?.stringValue,
                  userId != meId,
                  let seq = data["seq"]?.int64Value
            else { return }
            if var entry = receipts[userId] {
                entry.seq = max(entry.seq, seq)
                entry.deliveredSeq = max(entry.deliveredSeq, seq)
                entry.readAt = data["readAt"]?.stringValue ?? entry.readAt
                receipts[userId] = entry
            } else if let user = members[userId] {
                var entry = ReceiptEntry(user: user)
                entry.seq = seq
                entry.deliveredSeq = seq
                entry.readAt = data["readAt"]?.stringValue
                receipts[userId] = entry
            }

        case "delivery.receipt":
            guard target == conversationId,
                  let userId = data["userId"]?.stringValue,
                  userId != meId,
                  let seq = data["seq"]?.int64Value
            else { return }
            if var entry = receipts[userId] {
                entry.deliveredSeq = max(entry.deliveredSeq, seq)
                receipts[userId] = entry
            } else if let user = members[userId] {
                var entry = ReceiptEntry(user: user)
                entry.deliveredSeq = seq
                receipts[userId] = entry
            }

        /**
         * Someone in this chat changed their name or picture. Sender snapshots
         * ride on every message row, so the timeline keeps showing the old
         * identity until each row is told otherwise — the header and the
         * mention pool via `members`, the bubbles via their embedded sender.
         */
        case "user.update":
            guard let payload = try? JSONEncoder().encode(data),
                  let user = try? JSONDecoder().decode(PublicUser.self, from: payload)
            else { return }
            guard members[user.id] != nil || messages.contains(where: { $0.senderId == user.id }) else { return }
            members[user.id] = user
            for index in messages.indices where messages[index].senderId == user.id {
                messages[index].sender = user
            }

        default:
            break
        }
    }

    // ── List helpers ─────────────────────────────────────────────────────────

    private func appendIfMissing(_ message: Message) {
        guard !messages.contains(where: { $0.id == message.id }) else { return }
        // Replace the optimistic placeholder if this is our own message coming
        // back with a real id and seq.
        if let nonce = message.nonce {
            messages.removeAll { $0.nonce == nonce }
        }
        messages.append(message)
        resort()
        if let sender = message.sender { members[sender.id] = sender }
    }

    /// Pending messages sort last so a placeholder stays at the bottom of the
    /// timeline until the server gives it a real seq.
    ///
    /// `createdAt` then `id` break the tie, because `sort` is not stable and two
    /// photos sent in quick succession are both pending and both key to
    /// `Int64.max` — without a tiebreak they can swap places on any resort.
    private func resort() {
        messages.sort { lhs, rhs in
            let left = lhs.isPending ? Int64.max : lhs.seq
            let right = rhs.isPending ? Int64.max : rhs.seq
            if left != right { return left < right }
            if lhs.createdAt != rhs.createdAt { return lhs.createdAt < rhs.createdAt }
            return lhs.id < rhs.id
        }
    }

    private func replacePending(nonce: String, with message: Message) {
        if let index = messages.firstIndex(where: { $0.id == nonce }) {
            var settled = message
            // Keep what the placeholder already knew and the reply is missing.
            //
            // A server that answers a send without the quote would otherwise
            // make a reply lose it the instant it was confirmed — the bubble
            // renders correctly for one frame and then drops to a plain
            // message, and only reopening the conversation brings it back.
            // The client is not guessing here: it is the side that chose the
            // message being replied to.
            if settled.replyTo == nil { settled.replyTo = messages[index].replyTo }
            messages[index] = settled
        } else {
            appendIfMissing(message)
        }
        // A socket echo can arrive before the HTTP response does, leaving both
        // the placeholder's replacement and the pushed copy in the list.
        var seen = Set<String>()
        messages = messages.filter { seen.insert($0.id).inserted }
        // The placeholder sorted last while it was pending; now that it has a
        // real seq it may belong further up. A bot that answers faster than our
        // own POST returns — which is most of them — otherwise left its reply
        // stranded above the message it was answering, permanently, because
        // settling in place never re-sorted.
        resort()
    }

    private func replace(_ message: Message) {
        guard let index = messages.firstIndex(where: { $0.id == message.id }) else { return }
        messages[index] = message
    }

    private func patch(_ id: String, _ transform: (inout Message) -> Void) {
        guard let index = messages.firstIndex(where: { $0.id == id }) else { return }
        transform(&messages[index])
    }

    private static func decodeMessage(_ value: JSONValue) -> Message? {
        guard let data = try? JSONEncoder().encode(value) else { return nil }
        return try? JSONDecoder().decode(Message.self, from: data)
    }
}

/// Holds a picked photo's bytes on disk just long enough for the optimistic
/// bubble to render them.
///
/// The alternative — keeping the `Data` on the message — would pin a multi-
/// megabyte buffer inside published state that SwiftUI diffs on every keystroke.
/// A file URL is eight bytes and the image loader already knows how to read one.
final class LocalMediaCache {
    static let shared = LocalMediaCache()

    private let directory: URL

    private init() {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("outgoing", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    func store(_ data: Data, id: String) -> String {
        let url = directory.appendingPathComponent(id)
        try? data.write(to: url, options: .atomic)
        return url.absoluteString
    }

    func discard(id: String) {
        try? FileManager.default.removeItem(at: directory.appendingPathComponent(id))
    }
}
