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
    private var monitor: NWPathMonitor?
    private var hadNetwork = true

    private var sessionId: String?
    private var lastSeq = 0
    private var attempt = 0
    private var intentionalClose = false
    private var ticket: String?

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

        Task { [weak self] in
            guard let self else { return }

            guard let issued = try? await ticketProvider() else {
                scheduleReconnect()
                return
            }
            // A cancel between the request and its answer means the app went to
            // the background; opening a socket now would immediately be torn
            // down and would count as a failed attempt.
            guard !intentionalClose else { return }

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

    func disconnect() {
        intentionalClose = true
        tearDown()
        sessionId = nil
        lastSeq = 0
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
        reconnectTask?.cancel(); reconnectTask = nil
        heartbeatTask?.cancel(); heartbeatTask = nil
        receiveTask?.cancel(); receiveTask = nil
        stallTask?.cancel(); stallTask = nil
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

    private func command(_ payload: [String: JSONValue?]) {
        send(.object(["op": .int(GatewayOp.command), "d": jsonBody(payload)]))
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

    func setPresence(_ status: String) {
        command(["c": .string("presence.update"), "status": .string(status)])
    }

    func subscribe(_ conversationId: String) {
        command([
            "c": .string("conversation.subscribe"),
            "conversationId": .string(conversationId),
        ])
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
                    self.handleClose(code: 0, reason: error.localizedDescription)
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
            events.send(GatewayEvent(type: "ready", data: payload ?? .object([:])))

        case GatewayOp.resumed:
            attempt = 0
            stallTask?.cancel(); stallTask = nil
            state = .connected(resumed: true)

        case GatewayOp.dispatch:
            if let seq = frame["s"]?.intValue { lastSeq = seq }
            guard let type = frame["t"]?.stringValue else { return }
            events.send(GatewayEvent(type: type, data: frame["d"] ?? .object([:])))

        case GatewayOp.heartbeatAck:
            break

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

    private func startHeartbeat(intervalMs: Int) {
        heartbeatTask?.cancel()
        heartbeatTask = Task { [weak self] in
            // Jitter the first beat so a fleet reconnecting after a deploy does
            // not then heartbeat in lockstep forever.
            try? await Task.sleep(nanoseconds: UInt64.random(in: 0 ..< 5_000_000_000))
            while !Task.isCancelled {
                guard let self else { return }
                self.send(.object(["op": .int(GatewayOp.heartbeat)]))
                try? await Task.sleep(nanoseconds: UInt64(intervalMs) * 1_000_000)
            }
        }
    }

    private func handleClose(code: Int, reason: String) {
        heartbeatTask?.cancel(); heartbeatTask = nil
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
        if code >= 4010 {
            state = .fatal(reason: reason)
            return
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
            self?.handleClose(code: closeCode.rawValue, reason: text)
        }
    }
}
