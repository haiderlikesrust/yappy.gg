import Combine
import Foundation
import WidgetKit

@MainActor
final class ConversationsModel: ObservableObject {
    @Published private(set) var conversations: [Conversation] = [] {
        didSet { rebuildSections() }
    }
    @Published private(set) var loading = true
    @Published private(set) var online: [OnlineEntry] = []
    @Published private(set) var searchHits: [SearchHit] = []
    /// Accounts matching the query — the "People on yappy" search section.
    @Published private(set) var searchPeople: [PublicUser] = []
    @Published private(set) var unreadTotal = 0
    @Published private(set) var connected = false
    /// The "Connecting…" label waits out the ordinary launch blip — every cold
    /// start begins disconnected for a few hundred milliseconds, and flashing
    /// the label for that instant made a healthy app look flaky. It only shows
    /// when being offline has lasted long enough to be a fact.
    @Published private(set) var showConnecting = false
    /// True only when there is nothing to show *and* the fetch failed. "No
    /// chats yet" is a claim about the account; a dead network has no business
    /// making it.
    @Published private(set) var loadFailed = false
    @Published var showArchived = false
    @Published var query = "" {
        didSet {
            rebuildSections()
            queryChanged()
        }
    }

    /**
     * One-tap views of the same list, Telegram's answer to the same problem:
     * past a screenful of chats the question stops being "what is here" and
     * becomes "what needs me". A filter, not a folder — nothing moves
     * anywhere, and All is always one tap back.
     *
     * Session-only on purpose. A filter that survives relaunch is a trap: the
     * app reopens showing three chats, and the other forty look deleted.
     */
    enum HomeFilter: CaseIterable {
        case all, unread, mentions

        var label: String {
            switch self {
            case .all: return "All"
            case .unread: return "Unread"
            case .mentions: return "@"
            }
        }

        func admits(_ conversation: Conversation) -> Bool {
            switch self {
            case .all: return true
            case .unread:
                return conversation.unread > 0
                    || (conversation.selfState?.mentionCount ?? 0) > 0
            case .mentions:
                return (conversation.selfState?.mentionCount ?? 0) > 0
            }
        }
    }

    @Published var filter: HomeFilter = .all {
        didSet { rebuildSections() }
    }

    /// conversationId → when the newest typing signal expires.
    @Published private(set) var typingUntil: [String: Date] = [:]

    private var container: AppContainer?
    private var cancellables = Set<AnyCancellable>()
    private var searchTask: Task<Void, Never>?
    private var connectingDebounce: Task<Void, Never>?
    private var sweeper: Task<Void, Never>?
    private var presenceRefresh: Task<Void, Never>?
    private var started = false

    func isTyping(_ conversationId: String) -> Bool {
        guard let until = typingUntil[conversationId] else { return false }
        return until > Date()
    }

    /// Pinned first, then by recency. Sorted here rather than trusting the
    /// server's order, because live events mutate the list in place and the
    /// ordering has to survive that without a refetch.
    ///
    /// Stored, not computed. These were three computed properties reading each
    /// other — `visible` filtered and sorted, and `places` and `people` each
    /// called it again — and the screen reads all three, so drawing it ran the
    /// sort three times. That is per body evaluation, and the body re-runs on
    /// every typing indicator, presence tick and arriving message, plus every
    /// keystroke in the search box, where `localizedCaseInsensitiveContains`
    /// makes the filter half the cost too.
    private(set) var visible: [Conversation] = []
    private(set) var places: [Conversation] = []
    private(set) var people: [Conversation] = []

    /**
     * The list must not reorder under a finger.
     *
     * Every arriving message re-sorts by recency, and when one lands mid-drag
     * the row you were reaching for moves — which reads as the scroll
     * breaking, not as freshness. So while a scroll gesture is live the
     * sections are frozen: rebuilds note that they were asked for and run
     * once, when the scroll settles. `conversations` itself stays current the
     * whole time; only the drawn order waits.
     */
    private var scrolling = false
    private var rebuildDeferred = false

    func setScrolling(_ active: Bool) {
        guard scrolling != active else { return }
        scrolling = active
        if !active, rebuildDeferred {
            rebuildDeferred = false
            // `visible` and friends are plain vars that normally ride the
            // @Published change that triggered the rebuild. This rebuild has
            // no such carrier, so it announces itself.
            objectWillChange.send()
            rebuildSections()
        }
    }

    private func rebuildSections() {
        guard !scrolling else {
            rebuildDeferred = true
            return
        }
        // The empty query is the case that runs constantly — every typing
        // indicator, presence tick and arriving message rebuilds these — and it
        // matched everything anyway, after paying `localizedCaseInsensitiveContains`
        // per row to find that out. Now it pays nothing and hands over the same
        // storage; the sort below is what copies it.
        var sorted: [Conversation]
        if query.isEmpty {
            sorted = conversations
        } else {
            sorted = conversations.filter { conversation in
                conversation.displayName.localizedCaseInsensitiveContains(query)
                    || (conversation.lastMessage?.preview?.localizedCaseInsensitiveContains(query) ?? false)
            }
        }

        // The chip composes with the query: both narrow, whichever was
        // reached for second narrows further. Applied after the query filter
        // only because that branch reuses storage when it can.
        if filter != .all {
            sorted = sorted.filter(filter.admits)
        }

        sorted.sort { lhs, rhs in
            let lhsPinned = lhs.selfState?.isPinned ?? false
            let rhsPinned = rhs.selfState?.isPinned ?? false
            if lhsPinned != rhsPinned { return lhsPinned }
            return (lhs.lastMessageAt ?? "") > (rhs.lastMessageAt ?? "")
        }

        // One walk, not two. These were two more `filter`s over the whole list,
        // each allocating its own array, to answer one question per row.
        var placesNext: [Conversation] = []
        var peopleNext: [Conversation] = []
        for conversation in sorted {
            if conversation.type == "dm" {
                peopleNext.append(conversation)
            } else {
                placesNext.append(conversation)
            }
        }

        visible = sorted
        places = placesNext
        people = peopleNext
    }

    func start(_ container: AppContainer) {
        guard !started else { return }
        started = true
        self.container = container

        // Last launch's list, drawn in the first frame. The network fetch that
        // follows replaces it; this only decides whether the person opening the
        // app sees their chats or a spinner while that fetch is in flight.
        if let cached = DiskCache.decode(ConversationsEnvelope.self, key: "conversations") {
            conversations = cached.conversations
            container.headerSeeds.remember(cached.conversations)
            loading = false
        }

        load()
        observeGateway(container)
    }

    // ── Loading ──────────────────────────────────────────────────────────────

    /// Four independent fetches, four tasks.
    ///
    /// These used to run in one task, serially — and the list was only
    /// assigned after *all* of them answered, so the screen everyone opens the
    /// app to sat behind three round trips of which it needed exactly one.
    /// Now the list paints when the list arrives; the badge count, the Active
    /// Now strip and the profile each land whenever they land.
    func load() {
        guard let container else { return }
        Task { await fetchList(container) }
        loadSidecars(container)
    }

    /**
     * Pull-to-refresh.
     *
     * Separate from `load()` for one reason: `refreshable` shows its spinner
     * until the closure it was given *returns*, and `load()` returns the
     * instant it has spawned its tasks. Wired to that, the spinner snapped away
     * before a single byte had arrived — which reads as a refresh that did
     * nothing, on the gesture whose entire purpose is confirming that something
     * happened.
     *
     * Only the list is awaited. The badge, the Active Now strip and the profile
     * are along for the ride and nobody pulled down to see them.
     */
    func refresh() async {
        guard let container else { return }
        loadSidecars(container)
        await fetchList(container)
    }

    private func fetchList(_ container: AppContainer) async {
        do {
            let result = try await container.repo.conversations(archived: showArchived)
            conversations = result.conversations
            container.headerSeeds.remember(result.conversations)
            container.rememberNotificationLevels(result.conversations)
            loading = false
            loadFailed = false

            /**
             * Nudge the home-screen widget.
             *
             * The widget reads the same disk snapshot this request just wrote,
             * so by here it already has fresh data and only needs to be told to
             * look. This is what makes the widget agree with the app whenever
             * both are seen in the same minute — its own half-hourly timeline
             * is the floor, not the mechanism.
             *
             * Gated on the same condition as the cache write itself: the
             * archived list does not write a snapshot, so reloading after one
             * would redraw the widget from whatever the main list left behind,
             * for no reason.
             */
            if !showArchived { WidgetCenter.shared.reloadAllTimelines() }

            // Persist cursors so the next gateway IDENTIFY can ask for a delta
            // instead of a full snapshot.
            container.session.saveCursors(
                Dictionary(
                    result.conversations.map { ($0.id, $0.latestSeq) },
                    uniquingKeysWith: { first, _ in first }
                )
            )
        } catch {
            loading = false
            // Only an error state when there is nothing else to draw: with a
            // cached list on screen, a failed refresh is invisible and the
            // gateway reconnect will retry it anyway.
            loadFailed = conversations.isEmpty
        }
    }

    /// The three fetches the list does not wait for. Each lands whenever it
    /// lands; none of them blocks the screen everyone opens the app to.
    private func loadSidecars(_ container: AppContainer) {
        Task { [weak self] in
            if let badge = try? await container.repo.badge() {
                self?.unreadTotal = badge.unreadConversations
            }
        }
        Task { [weak self] in
            if let onlineNow = try? await container.repo.onlineContacts().online {
                self?.online = onlineNow
            }
        }
        // The profile lives on the container so every screen that draws your
        // face sees the same one.
        Task { if container.me == nil { await container.loadMe() } }
    }

    func toggleArchived() {
        showArchived.toggle()
        // The chips are hidden in the archive, so a lit one must not keep
        // filtering a list that can no longer say it is filtered.
        filter = .all
        loading = true
        load()
    }

    func retry() {
        loading = true
        loadFailed = false
        load()
    }

    private func queryChanged() {
        // One search box, three result sets: conversations filter locally and
        // instantly; messages and people hit the server, debounced, together.
        searchTask?.cancel()
        let trimmed = query.trimmingCharacters(in: .whitespaces)
        guard trimmed.count >= 2, let container else {
            searchHits = []
            searchPeople = []
            return
        }
        searchTask = Task {
            try? await Task.sleep(for: .milliseconds(350))
            guard !Task.isCancelled else { return }
            let hits = (try? await container.repo.searchMessages(trimmed).results) ?? []
            // Finding yourself in your own search is never the answer.
            let meId = container.session.userId
            let people = ((try? await container.repo.searchUsers(trimmed).users) ?? [])
                .filter { $0.id != meId }
            guard !Task.isCancelled, query.trimmingCharacters(in: .whitespaces) == trimmed else { return }
            searchHits = hits
            searchPeople = people
        }
    }

    // ── Row actions ──────────────────────────────────────────────────────────

    func togglePin(_ conversation: Conversation) {
        guard let container else { return }
        let next = !(conversation.selfState?.isPinned ?? false)
        patch(conversation.id) { $0.selfState?.isPinned = next }
        Task { try? await container.repo.setConversationState(conversation.id, pinned: next) }
    }

    func toggleMute(_ conversation: Conversation) {
        guard let container else { return }
        let next = !conversation.isMuted
        patch(conversation.id) {
            $0.selfState?.notificationLevel = next ? "none" : "all"
            $0.selfState?.mutedUntil = nil
        }
        // The in-app banner consults this; a mute must silence it immediately,
        // not after the next list refetch.
        container.notificationLevels[conversation.id] = next ? "none" : "all"
        Task { try? await container.repo.setConversationState(conversation.id, muted: next) }
    }

    func archive(_ conversation: Conversation) {
        guard let container else { return }
        let archived = !showArchived
        conversations.removeAll { $0.id == conversation.id }
        Task { try? await container.repo.setConversationState(conversation.id, archived: archived) }
    }

    /// Open (or create) the DM behind an Active Now bubble.
    func startDm(_ userId: String, onOpened: @escaping (String) -> Void) {
        guard let container else { return }
        Task {
            if let id = try? await container.repo.createDm(userId: userId).conversation.id {
                onOpened(id)
            }
        }
    }

    // ── Live updates ─────────────────────────────────────────────────────────

    /// The list is patched in place from gateway events rather than refetched: a
    /// refetch per incoming message would make a busy account issue a request
    /// every few seconds, and the scroll position would fight the user.
    private func observeGateway(_ container: AppContainer) {
        container.gateway.events
            .sink { [weak self] event in self?.handle(event, container) }
            .store(in: &cancellables)

        container.conversationRead
            .sink { [weak self] id in
                self?.patch(id) {
                    $0.selfState?.unreadCount = 0
                    $0.selfState?.mentionCount = 0
                }
            }
            .store(in: &cancellables)

        container.gateway.$state
            .sink { [weak self] state in
                guard let self else { return }
                connected = state.isConnected
                if state.isConnected {
                    connectingDebounce?.cancel()
                    connectingDebounce = nil
                    showConnecting = false
                    // Reconnecting is the moment to reconcile: events that
                    // arrived while the socket was down were never delivered.
                    load()
                } else if connectingDebounce == nil {
                    connectingDebounce = Task { [weak self] in
                        try? await Task.sleep(for: .seconds(1.5))
                        guard let self, !Task.isCancelled else { return }
                        if !connected { showConnecting = true }
                        connectingDebounce = nil
                    }
                }
            }
            .store(in: &cancellables)

        // Prune expired typing signals so "typing…" cannot outlive the typist.
        sweeper = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(2))
                guard let self else { return }
                let now = Date()
                let live = typingUntil.filter { $0.value > now }
                if live.count != typingUntil.count { typingUntil = live }
            }
        }
    }

    private func handle(_ event: GatewayEvent, _ container: AppContainer) {
        let data = event.data

        switch event.type {
        case "message.create":
            guard let conversationId = data["conversationId"]?.stringValue,
                  let seq = data["seq"]?.int64Value
            else { return }
            let preview = data["content"]?.stringValue
            let createdAt = data["createdAt"]?.stringValue

            guard conversations.contains(where: { $0.id == conversationId }) else {
                // First message in a conversation this client has never seen.
                // The only case that justifies a fetch.
                Task {
                    if let fresh = try? await container.repo.conversation(conversationId).conversation,
                       // Channels are never home-list rows — they live inside
                       // their space, and the list endpoint excludes them.
                       // Without this, the first message in any channel planted
                       // it on the home screen as a phantom top-level group.
                       fresh.type != "channel" {
                        conversations.insert(fresh, at: 0)
                    }
                }
                return
            }

            patch(conversationId) { conversation in
                conversation.latestSeq = seq
                conversation.lastMessageAt = createdAt ?? conversation.lastMessageAt
                if conversation.lastMessage != nil {
                    conversation.lastMessage?.seq = seq
                    conversation.lastMessage?.preview = preview
                } else {
                    conversation.lastMessage = LastMessageStub(seq: seq, preview: preview)
                }
                conversation.selfState?.unreadCount += 1
            }

            // This device has the message — tell the sender's ticks so. The
            // open chat's read ack implies it; this covers every conversation
            // that is *not* open, which is where a delivery tick means
            // anything at all.
            if data["senderId"]?.stringValue != container.session.userId {
                container.gateway.deliveryAck(conversationId, seq: seq)
            }

        case "conversation.create":
            load()

        // Title/description/flair edits, applied in place so a group changing
        // its look repaints every member's list without a refetch.
        case "conversation.update":
            guard let id = data["id"]?.stringValue else { return }
            patch(id) { conversation in
                // A group that just became a space needs its type corrected in
                // place — otherwise tapping it opens an empty chat instead of
                // the channel list, until some later reload happens to fix it.
                if let type = data["type"]?.stringValue { conversation.type = type }
                if let title = data["title"]?.stringValue { conversation.title = title }
                if let description = data["description"]?.stringValue { conversation.description = description }
                if let isPublic = data["isPublic"]?.boolValue { conversation.isPublic = isPublic }
                // Only overwrite when the key is present: a null `avatarUrl` in
                // the payload means "cleared", but an absent key means
                // "unchanged".
                if data.has("avatarUrl") { conversation.avatarUrl = data["avatarUrl"]?.stringValue }
                if data.has("appearance") {
                    conversation.appearance = data["appearance"].flatMap(Self.decodeAppearance)
                }
            }

        case "conversation.delete":
            guard let id = data["id"]?.stringValue else { return }
            conversations.removeAll { $0.id == id }

        // "Alan is typing…" directly on the list row. The stop event may be
        // lost, so entries expire on their own.
        case "typing.start":
            guard let conversationId = data["conversationId"]?.stringValue else { return }
            typingUntil[conversationId] = Date().addingTimeInterval(8)

        case "typing.stop":
            guard let conversationId = data["conversationId"]?.stringValue else { return }
            typingUntil.removeValue(forKey: conversationId)

        // Someone came online or left: refresh the Active Now strip and the
        // per-group "here" counts. Coalesced, not per-event — a busy account's
        // contacts flap constantly, and refetching per flap made the home
        // screen issue a request a second at exactly the moment someone was
        // trying to scroll it. One fetch a moment later reads the same truth.
        case "presence.update":
            guard presenceRefresh == nil else { return }
            presenceRefresh = Task { [weak self] in
                try? await Task.sleep(for: .seconds(1.5))
                guard let self, !Task.isCancelled else { return }
                if let refreshed = try? await container.repo.onlineContacts().online {
                    online = refreshed
                }
                presenceRefresh = nil
            }

        /**
         * Someone changed their name or face. The DM rows carrying them are
         * patched in place, exactly like `conversation.update` for a group —
         * without this, a rename showed up only for people who restarted the
         * app, because nothing else ever refetches the list.
         */
        case "user.update":
            guard let payload = try? JSONEncoder().encode(data),
                  let user = try? JSONDecoder().decode(PublicUser.self, from: payload)
            else { return }
            // One assignment, not one per match: the sections are rebuilt on
            // write, and the subscript form would redo the sort for each DM
            // this person appears in.
            var updated = conversations
            for index in updated.indices where updated[index].otherUser?.id == user.id {
                updated[index].otherUser = user
            }
            conversations = updated

        case "conversation.state_update":
            guard let id = data["conversationId"]?.stringValue else { return }
            patch(id) { conversation in
                if let unread = data["unreadCount"]?.intValue { conversation.selfState?.unreadCount = unread }
                if let pinned = data["isPinned"]?.boolValue { conversation.selfState?.isPinned = pinned }
            }

        default:
            break
        }
    }

    private func patch(_ id: String, _ transform: (inout Conversation) -> Void) {
        guard let index = conversations.firstIndex(where: { $0.id == id }) else { return }
        transform(&conversations[index])
    }

    private static func decodeAppearance(_ value: JSONValue) -> ConversationAppearance? {
        guard !value.isNull,
              let data = try? JSONEncoder().encode(value)
        else { return nil }
        return try? JSONDecoder().decode(ConversationAppearance.self, from: data)
    }
}
