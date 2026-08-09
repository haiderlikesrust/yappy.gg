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
        Task {
            do {
                let conversation = try await container.repo.conversation(conversationId).conversation
                let history = try await container.repo.history(conversationId, limit: 50)
                let pins = (try? await container.repo.pins(conversationId).pins.map(\.message)) ?? []

                var people: [String: PublicUser] = [:]
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

                // Fetched once per conversation: the list is small, changes only
                // when a bot is added or updates its manifest, and the composer
                // must be able to answer a "/" keypress instantly.
                if let list = try? await container.repo.conversationCommands(conversationId).commands {
                    commands = list
                }

                // Full member list for @-mention autocomplete. Groups only — a
                // DM's two participants are already in the map.
                if conversation.type != "dm",
                   let list = try? await container.repo.members(conversationId).members {
                    for entry in list { members[entry.user.id] = entry.user }
                }
            } catch let failure as ApiError {
                loading = false
                error = failure.message
            } catch {
                loading = false
            }
        }
    }

    func loadOlder() {
        guard let container, !loadingOlder, hasMore, let oldest = messages.first?.seq else { return }
        loadingOlder = true

        Task {
            defer { loadingOlder = false }
            guard let page = try? await container.repo.history(conversationId, before: oldest, limit: 50) else {
                return
            }
            // Prepend, and de-duplicate by id: a live event can land in the same
            // window a page request is covering.
            var seen = Set(messages.map(\.id))
            let fresh = page.messages.filter { seen.insert($0.id).inserted }
            messages = fresh + messages
            hasMore = page.hasMore
            for message in fresh {
                if let sender = message.sender { members[sender.id] = sender }
            }
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
    private func mentionSpans(in text: String) -> [YappyRepository.MentionSpan] {
        var spans: [YappyRepository.MentionSpan] = []
        let characters = Array(text)

        for user in members.values {
            guard let username = user.username else { continue }
            let needle = Array("@\(username)")
            guard !needle.isEmpty, characters.count >= needle.count else { continue }

            for start in 0 ... (characters.count - needle.count) {
                guard Array(characters[start ..< start + needle.count]) == needle else { continue }
                let after = characters.indices.contains(start + needle.count)
                    ? characters[start + needle.count]
                    : nil
                // A trailing letter or digit means this is a longer username
                // that merely starts with ours.
                if after == nil || !(after!.isLetter || after!.isNumber) {
                    spans.append(.init(offset: start, length: needle.count, userId: user.id))
                }
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

        case "poll.vote":
            guard target == conversationId, let messageId = data["messageId"]?.stringValue else { return }
            Task {
                let around = messages.first { $0.id == messageId }?.seq
                if let refreshed = try? await container.repo.history(conversationId, around: around).messages
                    .first(where: { $0.id == messageId }) {
                    replace(refreshed)
                }
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
        // Pending messages sort last so a placeholder stays at the bottom of the
        // timeline until the server gives it a real seq.
        messages.sort { lhs, rhs in
            let left = lhs.isPending ? Int64.max : lhs.seq
            let right = rhs.isPending ? Int64.max : rhs.seq
            return left < right
        }
        if let sender = message.sender { members[sender.id] = sender }
    }

    private func replacePending(nonce: String, with message: Message) {
        if let index = messages.firstIndex(where: { $0.id == nonce }) {
            messages[index] = message
        } else {
            appendIfMissing(message)
        }
        // A socket echo can arrive before the HTTP response does, leaving both
        // the placeholder's replacement and the pushed copy in the list.
        var seen = Set<String>()
        messages = messages.filter { seen.insert($0.id).inserted }
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
