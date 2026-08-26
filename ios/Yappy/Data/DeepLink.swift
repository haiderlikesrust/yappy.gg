import Foundation

/// Somewhere in the app a link can point.
///
/// Both forms the backend hands out are understood, plus the custom scheme:
///
///   https://yappy.gg/join/<code>      the URL `POST /conversations/:id/invites` returns
///   https://tenku.xyz/join/<code>     the same link on the backup domain
///   yappy://join/<code>               works with no domain set up at all
///   yappy://conversation/<id>         used by a tapped notification
///   yappy://user/<id>                 a person — what the share-profile QR encodes
///
/// Kept in step with android/.../data/DeepLink.kt, which parses the same set.
enum DeepLink: Equatable {
    case conversation(String)
    case invite(String)

    /// A person. What the share-profile QR encodes.
    case user(String)

    /// Hosts we will follow a `/join/` link from.
    ///
    /// An allowlist rather than "any https URL": the app is registered for
    /// these domains, and treating an arbitrary host's path as an invite code
    /// would let any link that reaches the handler drive a join request.
    private static let knownHosts: Set<String> = [
        "yappy.gg", "www.yappy.gg", "tenku.xyz", "www.tenku.xyz",
    ]

    init?(url: URL) {
        let parts = url.path.split(separator: "/").map(String.init)

        switch url.scheme?.lowercased() {
        case "yappy":
            // yappy://join/<code> — the host carries the first segment.
            let segments = [url.host].compactMap { $0 } + parts
            guard segments.count >= 2 else { return nil }
            switch segments[0] {
            case "join": self = .invite(segments[1])
            case "conversation", "chat": self = .conversation(segments[1])
            case "user": self = .user(segments[1])
            default: return nil
            }

        case "https", "http":
            guard let host = url.host?.lowercased(), Self.knownHosts.contains(host) else { return nil }
            guard parts.count >= 2, parts[0] == "join" else { return nil }
            self = .invite(parts[1])

        default:
            return nil
        }
    }
}
