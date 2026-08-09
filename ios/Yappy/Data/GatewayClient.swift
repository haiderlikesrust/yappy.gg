import Combine
import Foundation
import Network

/// Realtime gateway client.
///
/// Implements the protocol in docs/REALTIME_PROTOCOL.md: HELLO → IDENTIFY →
/// READY, heartbeats, RESUME on reconnect, and a command channel with acks.
///
/// The three things that make this survive real mobile networks:
///
///  1. **RESUME before IDENTIFY.** A dropped socket that comes back inside the
///     server's 120s window replays only the missed events.
///  2. **Backoff with jitter.** Without jitter, every client knocked off by a
///     deploy reconnects on the same schedule and does it again on the next tick.
///  3. **The socket is never the source of truth.** `connected` triggers a
///     reconcile through the REST sync path; events are a latency optimisation.
enum GatewayOp {
    static let hello = 0
    static let identify = 1
    static let ready = 2
    static let heartbeat = 3
    static let heartbeatAck = 4
    static let dispatch = 5
    static let resume = 6
    static let resumed = 7
    static let invalidSession = 8
    static let reconnect = 9
    static let command = 10
    static let commandAck = 11
    static let error = 12
}

enum GatewayState: Equatable {
    case disconnected
    case connecting
    case connected(resumed: Bool)
    /// Fatal: bad token, revoked session, forced upgrade. Do not auto-retry.
    case fatal(reason: String)

    var isConnected: Bool {
        if case .connected = self { return true }
        return false
    }
}

struct GatewayEvent {
    let type: String
    let data: JSONValue
}

@MainActor
final class GatewayClient: NSObject, ObservableObject {
    @Published private(set) var state: GatewayState = .disconnected

    /// A subject rather than an `AsyncStream`: the conversation list, the open
    /// chat and any open thread all listen at once, and an AsyncStream has a
    /// single consumer.
    let events = PassthroughSubject<GatewayEvent, Never>()

    private let session: SessionStore
    private let endpoints: Endpoints
    private let ticketProvider: () async throws -> GatewayTicket

    private var socket: URLSessionWebSocketTask?
    private var urlSession: URLSession?
    private var heartbeatTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    private var receiveTask: Task<Void, Never>?
    private var stallTask: Task<Void, Never>?
    private var connectTask: Task<Void, Never>?
    private var flushTask: Task<Void, Never>?
    /// Bumped on every connect attempt so a losing attempt cannot install a
    /// socket, and a dead socket's delegate callback cannot tear down the live
    /// one.
    private var generation = 0
    /// When the server last answered a heartbeat.
    private var lastAckAt = Date()
    private var monitor: NWPathMonitor?
    private var hadNetwork = true

    private var sessionId: String?
    private var lastSeq = 0
    private var attempt = 0
    private var intentionalClose = false
    private var ticket: String?

    /// Commands written before the handshake finished.
    ///
    /// The server closes the socket with 4012 `NotAuthenticated` on *any*
    /// COMMAND that arrives before IDENTIFY — it does not ignore it. 4012 is
    /// above the protocol's 4010 fatal threshold, so `handleClose` marks the
    /// client `.fatal` and stops reconnecting for the rest of the foreground
    /// session. One early `subscribe` therefore killed realtime outright: no
    /// new messages, no typing, no read receipts, until the app was relaunched.
    ///
    /// Opening a chat does exactly that. `ChatModel.load()` subscribes as soon
    /// as history returns, which on a cold start is comfortably inside the
    /// handshake — `URLSessionWebSocketTask` accepts sends before the socket is
    /// open and flushes them the moment it is, so the COMMAND overtook the
    /// IDENTIFY the client had not written yet.
    private var outbox: [JSONValue] = []
    /// Conversations the app wants events for.
    ///
    /// Kept here rather than in each `ChatModel` because a fresh IDENTIFY gets
    /// a brand-new server session with an empty subscription set, and the
    /// models that asked are long gone by then. Re-sent on every handshake.
    private var subscriptions = Set<String>()
    /// IDENTIFY or RESUME has been acknowledged; commands may go out.
    private var handshook = false

    /// Close codes that are nominally fatal but describe a client protocol
    /// slip rather than anything wrong with the account: AlreadyAuthenticated,
    /// NotAuthenticated, InvalidPayload.
    private static let recoverable: Set<Int> = [4011, 4012, 4013]

    init(
        session: SessionStore,
        endpoints: Endpoints,
        ticketProvider: @escaping () async throws -> GatewayTicket
    ) {
        self.session = session
        self.endpoints = endpoints
        self.ticketProvider = ticketProvider
        super.init()
        watchNetwork()
    }

    // ── Lifecycle ────────────────────────────────────────────────────────────

    func connect() {
        if case .connecting = state { return }
        if socket != nil { return }

        intentionalClose = false
        state = .connecting
        startStallWatchdog()

        // Every attempt is stamped, and only the current stamp may install a
        // socket or act on a close. Two `connect()` calls really can overlap —
        // a cold start runs `bootstrap()` and the `.active` scene change back
        // to back — and the loser used to leave an orphan socket open behind
        // the winner. The server closes an un-IDENTIFYed socket after 20s, the
        // orphan's delegate is still us, and `handleClose` would then tear down
        // the *healthy* connection. Realtime died twenty seconds after launch
        // with nothing on screen to suggest it.
        generation &+= 1
        let epoch = generation
        connectTask?.cancel()
        connectTask = Task { [weak self] in
            guard let self else { return }

            guard let issued = try? await ticketProvider() else {
                // Release the `.connecting` latch first. The backoff calls
                // `connect()`, whose first line returns early while the state
                // still says connecting — so without this one line the retry
                // chain is dead and only the 15s stall watchdog revives it.
                guard epoch == generation else { return }
                state = .disconnected
                scheduleReconnect()
                return
            }
            // A cancel between the request and its answer means the app went to
            // the background; opening a socket now would immediately be torn
            // down and would count as a failed attempt.
            guard !intentionalClose, !Task.isCancelled, epoch == generation else { return }

            ticket = issued.ticket

            // Read fresh on every connect, so a reconnect after an API failover
            // lands on the domain the API is already using.
            guard let url = URL(string: endpoints.gatewayUrl) else {
                state = .fatal(reason: "No gateway address configured")
                return
            }

            let configuration = URLSessionConfiguration.default
            configuration.timeoutIntervalForRequest = 30
            let urlSession = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
            self.urlSession = urlSession

            let task = urlSession.webSocketTask(with: url)
            socket = task
            task.resume()
            listen()
        }
    }

    /// - Parameter forgetting: only on sign-out.
    ///
    ///   A lifecycle pause must keep the session id. The server parks the
    ///   session for 120 seconds with its 256-event replay buffer intact, so a
    ///   foreground inside that window RESUMEs and is handed everything that
    ///   arrived while the app was away. Clearing the id here — which is what
    ///   this used to do unconditionally — meant the next connect always did a
    ///   full IDENTIFY instead, and READY carries no message bodies. Switch
    ///   apps for twenty seconds while a bot composes a reply and that reply
    ///   was simply gone until the chat was reopened.
    func disconnect(forgetting: Bool = false) {
        intentionalClose = true
        tearDown()
        // Queued typing notices and read acks are stale by the time this comes
        // back; `ChatModel` records reads over REST when the socket is down.
        outbox.removeAll()
        if forgetting {
            sessionId = nil
            lastSeq = 0
            subscriptions.removeAll()
        }
        state = .disconnected
    }

    /// Throw away whatever we are holding and start over.
    ///
    /// Called when the app comes back to the foreground and when the network
    /// path changes. Both are cases where the socket we hold is very likely
    /// already dead without having told us: iOS freezes the process, so
    /// heartbeats stop and the server drops the session, but `receive()` is
    /// suspended too and never surfaces an error. `connect()` on its own would
    /// look at that corpse, see `socket != nil`, and return — which is exactly
    /// the "I have to restart the app" symptom.
    ///
    /// `sessionId` is deliberately kept: if we are back inside the server's 120s
    /// window this RESUMEs and replays only what was missed, instead of
    /// re-downloading the world.
    func reconnectNow() {
        tearDown()
        intentionalClose = false
        attempt = 0
        state = .disconnected
        connect()
    }

    private func tearDown() {
        handshook = false
        reconnectTask?.cancel(); reconnectTask = nil
        heartbeatTask?.cancel(); heartbeatTask = nil
        receiveTask?.cancel(); receiveTask = nil
        stallTask?.cancel(); stallTask = nil
        connectTask?.cancel(); connectTask = nil
        flushTask?.cancel(); flushTask = nil
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        urlSession?.invalidateAndCancel()
        urlSession = nil
    }

    /// A handshake that never finishes produces no event to react to — no close,
    /// no error, just a socket sitting open with `.connecting` on screen for
    /// ever. This is the only thing that notices.
    private func startStallWatchdog() {
        stallTask?.cancel()
        stallTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(15))
            guard let self, !Task.isCancelled, case .connecting = state else { return }
            tearDown()
            state = .disconnected
            scheduleReconnect()
        }
    }

    /// Wi-Fi to cellular and back is the other way a socket dies quietly: the
    /// old path's connection is gone but nothing tells the app, so it waits on a
    /// route that no longer exists.
    private func watchNetwork() {
        let monitor = NWPathMonitor()
        self.monitor = monitor
        monitor.pathUpdateHandler = { [weak self] path in
            Task { @MainActor [weak self] in
                guard let self else { return }
                let hasNetwork = path.status == .satisfied
                defer { hadNetwork = hasNetwork }
                // Only on the edge back up, and only if we are not already fine.
                guard hasNetwork, !hadNetwork, !intentionalClose else { return }
                guard !state.isConnected else { return }
                reconnectNow()
            }
        }
        monitor.start(queue: DispatchQueue(label: "gg.yappy.app.network"))
    }

    // ── Commands ─────────────────────────────────────────────────────────────

    /// Queued until the handshake completes, then written in order.
    ///
    /// Bounded: if the socket is down for a long stretch the useful commands
    /// are the recent ones, and typing notices in particular go stale in
    /// seconds. Dropping from the front keeps the newest.
    private func command(_ payload: [String: JSONValue?]) {
        let frame = JSONValue.object(["op": .int(GatewayOp.command), "d": jsonBody(payload)])
        guard handshook else {
            outbox.append(frame)
            if outbox.count > 64 { outbox.removeFirst(outbox.count - 64) }
            return
        }
        send(frame)
    }

    func typing(_ conversationId: String, started: Bool) {
        command([
            "c": .string(started ? "typing.start" : "typing.stop"),
            "conversationId": .string(conversationId),
        ])
    }

    /// Read acks go over the socket rather than REST: they fire on every scroll,
    /// and a round-tripped HTTP request each time is wasteful for something the
    /// user never waits on.
    func markRead(_ conversationId: String, seq: Int64) {
        command([
            "c": .string("read.ack"),
            "conversationId": .string(conversationId),
            "seq": .int64(seq),
        ])
    }

    /// "This device has the message" — the sender's second tick. Sent as
    /// message events arrive, whether or not that chat is open; reading still
    /// implies delivery server-side, so this only matters for chats being
    /// received in the background of some other screen.
    func deliveryAck(_ conversationId: String, seq: Int64) {
        command([
            "c": .string("delivery.ack"),
            "conversationId": .string(conversationId),
            "seq": .int64(seq),
        ])
    }

    func setPresence(_ status: String) {
        command(["c": .string("presence.update"), "status": .string(status)])
    }

    /// Ask for this conversation's events, now and after every reconnect.
    ///
    /// IDENTIFY already subscribes the session to every conversation the user
    /// was a member of *at that moment*, so for an established account this is
    /// usually a no-op. It is not redundant: a group joined, or a channel
    /// created, after the handshake is not in that snapshot, and re-sending on
    /// reconnect is what keeps it subscribed across a new session.
    func subscribe(_ conversationId: String) {
        // Recorded either way; `handshake` replays the whole set, so queuing a
        // duplicate frame here would only send it twice.
        let isNew = subscriptions.insert(conversationId).inserted
        guard handshook, isNew else { return }
        sendSubscribe(conversationId)
    }

    private func subscribeFrame(_ conversationId: String) -> JSONValue {
        .object([
            "op": .int(GatewayOp.command),
            "d": jsonBody([
                "c": .string("conversation.subscribe"),
                "conversationId": .string(conversationId),
            ]),
        ])
    }

    private func sendSubscribe(_ conversationId: String) {
        send(subscribeFrame(conversationId))
    }

    /// The handshake finished: re-ask for everything, then write what was
    /// queued while it was in progress.
    ///
    /// Paced, because the server closes a socket that writes more than thirty
    /// frames in a second (4008). The set grows with every conversation opened
    /// this run, so an unpaced burst would trip the cap on subscribes alone
    /// once someone had browsed thirty-odd chats — and reconnect straight back
    /// into the identical burst.
    ///
    /// - Parameter resumed: a resumed session keeps its server-side
    ///   subscriptions, so only the queued frames need writing.
    private func handshakeComplete(resumed: Bool) {
        handshook = true
        lastAckAt = Date()

        var pending = resumed ? [] : subscriptions.map(subscribeFrame)
        pending.append(contentsOf: outbox)
        outbox.removeAll()

        flushTask?.cancel()
        guard !pending.isEmpty else { return }
        flushTask = Task { [weak self] in
            var index = 0
            while index < pending.count {
                guard let self, !Task.isCancelled, handshook else { return }
                // Twenty leaves headroom for heartbeats and for whatever the
                // person is doing while this drains.
                for frame in pending[index ..< min(index + 20, pending.count)] { send(frame) }
                index += 20
                if index < pending.count { try? await Task.sleep(for: .seconds(1)) }
            }
        }
    }

    private func send(_ frame: JSONValue) {
        guard let socket,
              let data = try? JSONEncoder().encode(frame),
              let text = String(data: data, encoding: .utf8)
        else { return }
        socket.send(.string(text)) { _ in }
    }

    // ── Receive loop ─────────────────────────────────────────────────────────

    private func listen() {
        receiveTask?.cancel()
        receiveTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, let socket = self.socket else { return }
                do {
                    let message = try await socket.receive()
                    guard !Task.isCancelled else { return }
                    switch message {
                    case .string(let text):
                        self.handle(text)
                    case .data(let data):
                        if let text = String(data: data, encoding: .utf8) { self.handle(text) }
                    @unknown default:
                        break
                    }
                } catch {
                    guard !Task.isCancelled else { return }
                    // A receive error is the socket going away — the delegate's
                    // close callback may or may not also fire, and `handleClose`
                    // is written to be safe either way.
                    self.handleClose(code: 0, reason: error.localizedDescription, socket: socket)
                    return
                }
            }
        }
    }

    private func handle(_ text: String) {
        guard let data = text.data(using: .utf8),
              let frame = try? JSONDecoder().decode(JSONValue.self, from: data),
              let op = frame["op"]?.intValue
        else { return }

        switch op {
        case GatewayOp.hello:
            let interval = frame["d"]?["heartbeatIntervalMs"]?.intValue ?? 41_250
            if let sessionId {
                send(.object([
                    "op": .int(GatewayOp.resume),
                    "d": .object([
                        "token": .string(ticket ?? ""),
                        "sessionId": .string(sessionId),
                        "seq": .int(lastSeq),
                    ]),
                ]))
            } else {
                sendIdentify()
            }
            startHeartbeat(intervalMs: interval)

        case GatewayOp.ready:
            let payload = frame["d"]
            sessionId = payload?["sessionId"]?.stringValue
            lastSeq = 0
            attempt = 0
            stallTask?.cancel(); stallTask = nil
            state = .connected(resumed: false)
            handshakeComplete(resumed: false)
            events.send(GatewayEvent(type: "ready", data: payload ?? .object([:])))

        case GatewayOp.resumed:
            attempt = 0
            stallTask?.cancel(); stallTask = nil
            state = .connected(resumed: true)
            handshakeComplete(resumed: true)
            events.send(GatewayEvent(type: "resumed", data: frame["d"] ?? .object([:])))

        case GatewayOp.dispatch:
            if let seq = frame["s"]?.intValue { lastSeq = seq }
            guard let type = frame["t"]?.stringValue else { return }
            events.send(GatewayEvent(type: type, data: frame["d"] ?? .object([:])))

        case GatewayOp.heartbeatAck:
            lastAckAt = Date()

        case GatewayOp.invalidSession:
            // Cannot resume — drop the session id so the next HELLO performs a
            // full IDENTIFY, then let the sync path reconcile.
            sessionId = nil
            lastSeq = 0

        case GatewayOp.reconnect:
            // A rolling deploy, not a failure. Reconnect immediately.
            socket?.cancel(with: .normalClosure, reason: nil)

        default:
            break
        }
    }

    private func sendIdentify() {
        let cursors = session.loadCursors().prefix(500).map { entry in
            JSONValue.object([
                "conversationId": .string(entry.key),
                "seq": .int64(entry.value),
            ])
        }

        send(.object([
            "op": .int(GatewayOp.identify),
            "d": .object([
                "token": .string(ticket ?? ""),
                "protocolVersion": .int(1),
                "client": .object([
                    "platform": .string("ios"),
                    "version": .string(AppConfig.version),
                ]),
                "presence": .string("online"),
                // Sending cursors turns READY into a delta. On an account with
                // hundreds of chats this is the difference between megabytes and
                // kilobytes on every reconnect.
                "cursors": .array(Array(cursors)),
            ]),
        ]))
    }

    /// Beat, and watch for the beat coming back.
    ///
    /// The ack used to be ignored, which left the one failure mode nothing else
    /// can see: a half-open socket. A NAT rebind, a Wi-Fi-to-cellular handoff or
    /// a carrier idle timeout strands the connection without closing it —
    /// `receive()` stays suspended for ever and no error is raised. The client
    /// went on showing "connected", writing read acks into the void, and never
    /// receiving another message. That is exactly the reported shape: the bot's
    /// reply never arrives, but it is there the moment the chat is reopened,
    /// because reopening refetches over REST.
    private func startHeartbeat(intervalMs: Int) {
        heartbeatTask?.cancel()
        lastAckAt = Date()
        heartbeatTask = Task { [weak self] in
            // Jitter the first beat so a fleet reconnecting after a deploy does
            // not then heartbeat in lockstep forever.
            try? await Task.sleep(nanoseconds: UInt64.random(in: 0 ..< 5_000_000_000))
            while !Task.isCancelled {
                guard let self else { return }
                // A whole interval plus the protocol's grace with no answer:
                // the socket is dead whatever it claims.
                if Date().timeIntervalSince(lastAckAt) > Double(intervalMs) / 1000 + 15 {
                    reconnectNow()
                    return
                }
                self.send(.object(["op": .int(GatewayOp.heartbeat)]))
                try? await Task.sleep(nanoseconds: UInt64(intervalMs) * 1_000_000)
            }
        }
    }

    /// - Parameter socket: the socket that closed, when it is known. A close
    ///   from anything other than the one we currently hold is an orphan's and
    ///   must be ignored.
    private func handleClose(code: Int, reason: String, socket closed: URLSessionWebSocketTask? = nil) {
        if let closed, closed !== socket { return }
        heartbeatTask?.cancel(); heartbeatTask = nil
        flushTask?.cancel(); flushTask = nil
        handshook = false
        guard socket != nil else { return }
        socket = nil
        urlSession?.invalidateAndCancel()
        urlSession = nil

        if intentionalClose {
            state = .disconnected
            return
        }

        // 4010+ is fatal per the protocol: a bad token or a revoked session will
        // not fix itself, and retrying just burns battery.
        //
        // Three of those codes are the exception. 4011/4012/4013 mean the
        // *client* wrote the wrong thing at the wrong moment; nothing about the
        // account is wrong and a clean handshake always fixes it. Treating them
        // as fatal is how a single mis-ordered frame used to take realtime down
        // until the app was relaunched — the failure was permanent, silent, and
        // looked exactly like a dead network.
        if code >= 4010, !Self.recoverable.contains(code) {
            state = .fatal(reason: reason)
            return
        }
        if Self.recoverable.contains(code) {
            // Start over rather than resume: whatever the server thinks this
            // session is, we no longer agree with it.
            sessionId = nil
            lastSeq = 0
        }

        state = .disconnected
        scheduleReconnect()
    }

    private func scheduleReconnect() {
        reconnectTask?.cancel()
        reconnectTask = Task { [weak self] in
            guard let self else { return }
            attempt += 1
            let base = min(30_000, 1_000 * (1 << min(attempt - 1, 5)))
            let jitter = Int.random(in: 0 ... max(1, base / 2))
            try? await Task.sleep(nanoseconds: UInt64(base + jitter) * 1_000_000)
            guard !Task.isCancelled, !intentionalClose else { return }
            connect()
        }
    }
}

extension GatewayClient: URLSessionWebSocketDelegate {
    nonisolated func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
        reason: Data?
    ) {
        let text = reason.flatMap { String(data: $0, encoding: .utf8) } ?? ""
        Task { @MainActor [weak self] in
            // Which socket closed matters. An abandoned socket from a losing
            // connect attempt keeps us as its delegate, and the server closes
            // it twenty seconds later for never identifying — that close used
            // to tear down whatever healthy connection had replaced it.
            self?.handleClose(code: closeCode.rawValue, reason: text, socket: webSocketTask)
        }
    }
}
