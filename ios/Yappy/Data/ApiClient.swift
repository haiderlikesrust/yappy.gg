import Foundation

/// Typed failure the UI can branch on, mirroring the backend's error codes.
struct ApiError: Error, LocalizedError {
    let status: Int
    let code: String
    let message: String
    var retryAfter: Int?

    var isAuthFailure: Bool { status == 401 }
    var isRateLimited: Bool { status == 429 }
    var errorDescription: String? { message }

    static func network(_ message: String) -> ApiError {
        ApiError(status: 0, code: "network_error", message: message)
    }
}

/// HTTP client.
///
/// Three things it does that are worth calling out:
///
///  1. **Single-flight refresh.** A 401 triggers a token refresh behind an
///     actor. Without it, an app resuming from background fires six requests at
///     once, all 401, all refresh — and rotation means five of them present a
///     token that has already been superseded. The backend tolerates one retry
///     inside its grace window; it should not have to.
///
///  2. **Domain failover.** A *connection* failure (DNS, refused, timed out)
///     advances to the backup domain and retries. An HTTP 500 does not: the
///     domain is reachable, the server is just unhappy, and switching domains
///     would not help.
///
///  3. **No token in the URL, ever.** The gateway ticket is the only short-lived
///     credential and it goes in the WebSocket handshake payload, not the query
///     string.
final class ApiClient: @unchecked Sendable {
    let session: SessionStore
    let endpoints: Endpoints
    /// Called when a refresh has failed for good, so the app can tear down local
    /// state rather than keep issuing requests that will all 401.
    var onSignedOut: (@Sendable () async -> Void)?

    let http: URLSession
    private let refresher = TokenRefresher()

    private static let decoder = JSONDecoder()
    private static let encoder = JSONEncoder()

    init(session: SessionStore, endpoints: Endpoints) {
        self.session = session
        self.endpoints = endpoints

        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 120
        configuration.waitsForConnectivity = false
        configuration.httpAdditionalHeaders = ["Accept": "application/json"]
        http = URLSession(configuration: configuration)
    }

    // ── Verbs ────────────────────────────────────────────────────────────────

    /// - Parameter cacheTo: name of a `DiskCache` slot to keep this response's
    ///   raw bytes in for next launch's first paint. Only the screens' primary
    ///   list fetches pass it; everything else stays uncached.
    func get<T: Decodable>(
        _ path: String,
        query: [String: String?] = [:],
        cacheTo: String? = nil
    ) async throws -> T {
        try await request("GET", path, body: nil, query: query, cacheTo: cacheTo)
    }

    func post<T: Decodable>(_ path: String, _ body: JSONValue? = nil) async throws -> T {
        try await request("POST", path, body: body)
    }

    func patch<T: Decodable>(_ path: String, _ body: JSONValue? = nil) async throws -> T {
        try await request("PATCH", path, body: body)
    }

    func put<T: Decodable>(_ path: String, _ body: JSONValue? = nil) async throws -> T {
        try await request("PUT", path, body: body)
    }

    func delete<T: Decodable>(_ path: String, query: [String: String?] = [:]) async throws -> T {
        try await request("DELETE", path, body: nil, query: query)
    }

    /// Discards the response body. Several endpoints answer with a shape the
    /// caller has no use for, and forcing every one of them to name a throwaway
    /// type adds noise without adding safety.
    @discardableResult
    func send(_ method: String, _ path: String, body: JSONValue? = nil, query: [String: String?] = [:]) async throws -> JSONValue {
        try await request(method, path, body: body, query: query)
    }

    func request<T: Decodable>(
        _ method: String,
        _ path: String,
        body: JSONValue? = nil,
        query: [String: String?] = [:],
        cacheTo: String? = nil
    ) async throws -> T {
        let payload = try body.map { try Self.encoder.encode($0) }
        let data = try await execute(method, path, jsonBody: payload, query: query)

        // A 204 or an empty 200 is a success with nothing to say; decoding "{}"
        // lets envelopes with all-defaulted fields succeed instead of throwing.
        let material = data.isEmpty ? Data("{}".utf8) : data
        do {
            let decoded = try Self.decoder.decode(T.self, from: material)
            // Written only after the decode succeeds: a slot must never hold
            // bytes this build has already proven it cannot read.
            if let cacheTo, !data.isEmpty { DiskCache.write(data, key: cacheTo) }
            return decoded
        } catch {
            throw ApiError(
                status: 0,
                code: "decode_failed",
                message: "The server sent something this build did not understand."
            )
        }
    }

    // ── Core ─────────────────────────────────────────────────────────────────

    /// The errors that actually mean "this host is not answering". Anything
    /// else — and cancellation above all — must not move the domain.
    private static let connectionFailures: Set<URLError.Code> = [
        .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed,
        .timedOut, .networkConnectionLost, .notConnectedToInternet,
        .secureConnectionFailed, .cannotLoadFromNetwork, .resourceUnavailable,
    ]

    func execute(
        _ method: String,
        _ path: String,
        jsonBody: Data?,
        query: [String: String?] = [:],
        retryOn401: Bool = true
    ) async throws -> Data {
        // Fetched once: the token is constant across a failover retry. A 401
        // refresh happens later, on its own retry path.
        let accessToken = session.accessToken

        func buildRequest(_ base: String) throws -> URLRequest {
            guard var components = URLComponents(string: base + path) else {
                throw ApiError(status: 0, code: "bad_url", message: "Malformed request URL")
            }
            let items = query.compactMap { key, value in
                value.map { URLQueryItem(name: key, value: $0) }
            }
            if !items.isEmpty { components.queryItems = items }
            guard let url = components.url else {
                throw ApiError(status: 0, code: "bad_url", message: "Malformed request URL")
            }

            var request = URLRequest(url: url)
            request.httpMethod = method
            if let jsonBody {
                request.httpBody = jsonBody
                request.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
            } else if method != "GET", method != "DELETE" {
                // The backend's schema validation runs on a parsed body, and an
                // absent one on a POST reads as malformed rather than empty.
                request.httpBody = Data("{}".utf8)
                request.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
            }
            if let accessToken {
                request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
            }
            return request
        }

        // Try the current domain; on a connection failure, fail over to the
        // backup and try again. The chosen domain sticks for later requests.
        var currentBase = endpoints.apiBase
        var response: (Data, HTTPURLResponse)

        while true {
            do {
                let (data, raw) = try await http.data(for: try buildRequest(currentBase))
                guard let http = raw as? HTTPURLResponse else {
                    throw ApiError.network("Unexpected response")
                }
                response = (data, http)
                break
            } catch let error as ApiError {
                throw error
            } catch is CancellationError {
                throw CancellationError()
            } catch let error as URLError where error.code == .cancelled {
                // Not an outage. `URLSession` reports a cancelled task as
                // `URLError(.cancelled)`, and this app cancels constantly — a
                // keystroke in any search box, tapping Back while a screen is
                // still loading. Treating that as "the primary domain is down"
                // moved every later request in the process onto the backup, and
                // `failOver` only ever moves forward, so there was no way back.
                // Worse, the socket reads its host only at connect time, so the
                // API and the gateway ended up on different domains — the exact
                // split the shared `Endpoints` exists to prevent.
                throw CancellationError()
            } catch let error as URLError where Self.connectionFailures.contains(error.code) {
                guard let next = endpoints.failOver(from: currentBase), next != currentBase else {
                    throw ApiError.network(
                        error.localizedDescription.isEmpty
                            ? "Network unavailable"
                            : error.localizedDescription
                    )
                }
                currentBase = next
            } catch {
                throw ApiError.network(
                    (error as NSError).localizedDescription.isEmpty
                        ? "Network unavailable"
                        : (error as NSError).localizedDescription
                )
            }
        }

        let (data, http) = response

        if (200 ..< 300).contains(http.statusCode) { return data }

        if http.statusCode == 401, retryOn401 {
            switch await refreshTokens() {
            case .rotated:
                return try await execute(method, path, jsonBody: jsonBody, query: query, retryOn401: false)
            case .rejected:
                await onSignedOut?()
            case .transient:
                // A 502 from a restarting API, a 429, a stalled connection on a
                // train. None of those mean the session was revoked, and
                // signing out *deletes the refresh token from the keychain* —
                // an unrecoverable response to a temporary condition. Surface
                // the 401 and let the next request try again.
                break
            }
        }

        let detail = try? Self.decoder.decode(ApiErrorBody.self, from: data).error
        throw ApiError(
            status: http.statusCode,
            code: detail?.code ?? "http_\(http.statusCode)",
            message: detail?.message ?? "Request failed (\(http.statusCode))",
            retryAfter: detail?.retryAfter
        )
    }

    /// Refresh, single-flight.
    ///
    /// Three-valued on purpose. Collapsing "the server revoked your session"
    /// and "the request did not get through" into one `false` meant a timeout
    /// or a 502 during a deploy tore down the session and erased the refresh
    /// token — the user was dumped on the sign-in screen with nothing on the
    /// device left to recover from.
    private func refreshTokens() async -> RefreshOutcome {
        await refresher.run { [self] in
            guard let refresh = session.refreshToken else { return .rejected }

            guard let url = URL(string: endpoints.apiBase + "/auth/refresh") else { return .rejected }
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? Self.encoder.encode(jsonBody(["refreshToken": .string(refresh)]))

            do {
                let (data, raw) = try await http.data(for: request)
                guard let response = raw as? HTTPURLResponse else { return .transient }
                // Only the server saying no counts as no.
                if response.statusCode == 401 || response.statusCode == 403 { return .rejected }
                guard (200 ..< 300).contains(response.statusCode) else { return .transient }
                let parsed = try Self.decoder.decode(RefreshResponse.self, from: data)
                session.saveTokens(access: parsed.accessToken, refresh: parsed.refreshToken)
                return .rotated
            } catch {
                return .transient
            }
        }
    }
}

/// What a refresh attempt actually established.
enum RefreshOutcome: Sendable {
    /// New tokens are saved.
    case rotated
    /// The server refused the refresh token. The session is over.
    case rejected
    /// Nothing was learned — the network or the server was unavailable. Keep
    /// the tokens and try again on the next request.
    case transient
}

/// Serialises refreshes so six concurrent 401s produce one rotation.
///
/// An actor rather than a lock because the work inside is `async`: holding a
/// mutex across an await is how a deadlock gets written.
private actor TokenRefresher {
    private var inFlight: Task<RefreshOutcome, Never>?

    func run(_ work: @escaping @Sendable () async -> RefreshOutcome) async -> RefreshOutcome {
        if let inFlight { return await inFlight.value }

        let task = Task { await work() }
        inFlight = task
        let result = await task.value
        inFlight = nil
        return result
    }
}
