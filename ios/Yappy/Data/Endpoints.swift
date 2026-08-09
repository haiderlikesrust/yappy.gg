import Foundation

/// The API and gateway addresses, with automatic failover to a backup domain.
///
/// yappy runs on two domains that point at the same server (see the backup
/// section of infra/Caddyfile). If the primary domain stops resolving, for
/// example while a registry propagates a change, the app should keep working on
/// the backup rather than sitting at "network error".
///
/// This holds both sets and a shared active index. When the API client cannot
/// reach the current domain it advances the index; the gateway reads the same
/// index on its next reconnect, so the two fail over together, which is right
/// because they share a domain's fate. The move is sticky for the session and
/// resets to the primary on the next cold start, so a blip does not pin every
/// future launch to the backup.
///
/// Blank or duplicate entries collapse away, so a build with no configured
/// backup is simply a one-entry list that never fails over.
final class Endpoints: @unchecked Sendable {
    private let apis: [String]
    private let gateways: [String]

    /// Guarded rather than atomic: `failOver` has to compare and advance as one
    /// step, and two requests failing at the same instant must not skip a
    /// working domain between them.
    private let lock = NSLock()
    private var index = 0

    init(apiUrls: [String], gatewayUrls: [String]) {
        func clean(_ list: [String]) -> [String] {
            var seen = Set<String>()
            return list
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty && seen.insert($0).inserted }
        }
        apis = clean(apiUrls)
        gateways = clean(gatewayUrls)
    }

    var apiBase: String {
        lock.lock(); defer { lock.unlock() }
        return apis.indices.contains(index) ? apis[index] : (apis.first ?? "")
    }

    var gatewayUrl: String {
        lock.lock(); defer { lock.unlock() }
        let capped = min(index, gateways.count - 1)
        return gateways.indices.contains(capped) ? gateways[capped] : (gateways.first ?? "")
    }

    var hasBackup: Bool { apis.count > 1 }

    /// Advance to the next domain after a connection failure, and return its API
    /// base, or nil if there is nowhere left to go.
    ///
    /// Takes the base the caller just failed on. If it no longer matches the
    /// active one, another request already failed over; we hand back the current
    /// base rather than skipping a domain, so concurrent failures do not race
    /// past a working endpoint.
    func failOver(from failedBase: String) -> String? {
        lock.lock(); defer { lock.unlock() }
        let current = apis.indices.contains(index) ? apis[index] : (apis.first ?? "")
        if current != failedBase { return current }
        guard index + 1 < apis.count else { return nil }
        index += 1
        return apis[index]
    }
}

/// Build-time addresses.
///
/// These must match the deployed Caddy vhosts exactly. The gateway is
/// `ws.yappy.gg` — not `gateway.yappy.gg`, a name that never existed and which
/// on Android would have shipped an app that signs in fine and then never
/// receives a single realtime event.
enum AppConfig {
    #if DEBUG && targetEnvironment(simulator)
    /// The simulator shares the host's loopback, so a backend running locally is
    /// reachable at plain localhost — no `10.0.2.2` indirection like the Android
    /// emulator needs.
    ///
    /// The production hosts stay in the list as the fallback, so a debug build
    /// with nothing running locally still reaches the live backend instead of
    /// failing at the first request.
    ///
    /// Simulator only. On a real phone `localhost` is the *phone*, so leaving it
    /// in the list would make every cold start pay a guaranteed connection
    /// failure before failing over to something that exists.
    static let apiUrls = ["http://localhost:3000/v1", "https://api.yappy.gg/v1", "https://api.tenku.xyz/v1"]
    static let gatewayUrls = ["ws://localhost:3001", "wss://ws.yappy.gg", "wss://ws.tenku.xyz"]
    static let webUrl = "https://yappy.gg"
    #else
    /// Backup domain. The app fails over to it if the primary stops resolving,
    /// and returns to the primary on the next cold start.
    static let apiUrls = ["https://api.yappy.gg/v1", "https://api.tenku.xyz/v1"]
    static let gatewayUrls = ["wss://ws.yappy.gg", "wss://ws.tenku.xyz"]
    static let webUrl = "https://yappy.gg"
    #endif

    static var version: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0.0"
    }

    /// Hosts whose images carry the access token. Message attachments are
    /// private — the API serves them only to members of the conversation they
    /// were posted in. Anything not on this list (a Tenor GIF, a bot's icon)
    /// must not see the header, or the session leaks to a third party.
    static let apiHosts: Set<String> = {
        Set(apiUrls.compactMap { URL(string: $0)?.host })
    }()
}
