import Combine
import Foundation

@MainActor
final class ConversationsModel: ObservableObject {
    @Published private(set) var conversations: [Conversation] = []
    @Published private(set) var loading = true
    @Published private(set) var online: [OnlineEntry] = []
    @Published private(set) var searchHits: [SearchHit] = []
    @Published private(set) var unreadTotal = 0
    @Published private(set) var connected = false
    @Published var showArchived = false
    @Published var query = "" { didSet { queryChanged() } }

    /// conversationId → when the newest typing signal expires.
    @Published private(set) var typingUntil: [String: Date] = [:]

    private var container: AppContainer?
    private var cancellables = Set<AnyCancellable>()
    private var searchTask: Task<Void, Never>?
    private var sweeper: Task<Void, Never>?
    private var started = false

    func isTyping(_ conversationId: String) -> Bool {
        guard let until = typingUntil[conversationId] else { return false }
        return until > Date()
    }

    /// Pinned first, then by recency. Sorted here rather than trusting the
    /// server's order, because live events mutate the list in place and the
    /// ordering has to survive that without a refetch.
    var visible: [Conversation] {
        conversations
            .filter { conversation in
                query.isEmpty
                    || conversation.displayName.localizedCaseInsensitiveContains(query)
                    || (conversation.lastMessage?.preview?.localizedCaseInsensitiveContains(query) ?? false)
            }
            .sorted { lhs, rhs in
                let lhsPinned = lhs.selfState?.isPinned ?? false
                let rhsPinned = rhs.selfState?.isPinned ?? false
                if lhsPinned != rhsPinned { return lhsPinned }
                return (lhs.lastMessageAt ?? "") > (rhs.lastMessageAt ?? "")
            }
    }

    var places: [Conversation] { visible.filter { $0.type != "dm" } }
    var people: [Conversation] { visible.filter { $0.type == "dm" } }

    func start(_ container: AppContainer) {
        guard !started else { return }
        started = true
        self.container = container
        load()
        observeGateway(container)
    }

    // ── Loading ──────────────────────────────────────────────────────────────

    func load(refresh: Bool = false) {
        guard let container else { return }
        Task {
            do {
                let result = try await container.repo.conversations(archived: showArchived)
                let badge = try? await container.repo.badge()
                let onlineNow = try? await container.repo.onlineContacts().online

                conversations = result.conversations
                container.headerSeeds.remember(result.conversations)
                loading = false
                unreadTotal = badge?.unreadConversations ?? unreadTotal
                if let onlineNow { online = onlineNow }
                // The profile lives on the container so every screen that draws
                // your face sees the same one.
                if container.me == nil { await container.loadMe() }

                // Persist cursors so the next gateway IDENTIFY can ask for a
                // delta instead of a full snapshot.
                container.session.saveCursors(
                    Dictionary(
                        result.conversations.map { ($0.id, $0.latestSeq) },
                        uniquingKeysWith: { first, _ in first }
                    )
                )
            } catch {
                loading = false
            }
        }
    }

    func toggleArchived() {
        showArchived.toggle()
        loading = true
        load()
    }

    private func queryChanged() {
        // One search box, two result sets: conversations filter locally and
        // instantly; message search hits the server, debounced.
        searchTask?.cancel()
        let trimmed = query.trimmingCharacters(in: .whitespaces)
        guard trimmed.count >= 2, let container else {
            searchHits = []
            return
        }
        searchTask = Task {
            try? await Task.sleep(for: .milliseconds(350))
            guard !Task.isCancelled else { return }
            let hits = (try? await container.repo.searchMessages(trimmed).results) ?? []
            guard !Task.isCancelled, query.trimmingCharacters(in: .whitespaces) == trimmed else { return }
            searchHits = hits
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
                // Reconnecting is the moment to reconcile: events that arrived
                // while the socket was down were never delivered.
                if state.isConnected { load(refresh: true) }
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
                    if let fresh = try? await container.repo.conversation(conversationId).conversation {
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
        // per-group "here" counts. Cheap queries, and the liveness is the whole
        // point of the home screen.
        case "presence.update":
            Task {
                if let refreshed = try? await container.repo.onlineContacts().online {
                    online = refreshed
                }
            }

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
