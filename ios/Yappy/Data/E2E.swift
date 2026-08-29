import Foundation

/// The session layer, with a placeholder where the cipher goes.
///
/// **Nothing here encrypts anything.** `seal` is reversible by anybody who
/// reads this file, and it is gated on a debug build so it cannot reach the App
/// Store. It exists because the ratchet is the small part of shipping encrypted
/// messages: the rest is one ciphertext per recipient device, what a device
/// that was not a recipient shows, what happens when somebody adds a phone
/// mid-conversation. All of that is product behaviour that has to be settled
/// anyway, and settling it against a fake cipher is far cheaper than settling
/// it against a real one.
///
/// The format matches the web and Android clients exactly — prefix, then base64
/// of `deviceId|text` — because the whole point is that a message sealed on one
/// platform opens on another.
actor E2E {
    private static let prefix = "stub.v0."
    private static let flagKey = "yappy.e2e.conversations"

    private let repo: YappyRepository
    private let session: SessionStore

    init(repo: YappyRepository, session: SessionStore) {
        self.repo = repo
        self.session = session
    }

    /// Two locks: the build, and the per-conversation flag.
    nonisolated var available: Bool {
        #if DEBUG
            return true
        #else
            return false
        #endif
    }

    nonisolated func isPrivate(_ conversationId: String) -> Bool {
        guard available else { return false }
        let flagged = UserDefaults.standard.stringArray(forKey: Self.flagKey) ?? []
        return flagged.contains(conversationId)
    }

    nonisolated func setPrivate(_ conversationId: String, _ on: Bool) {
        var flagged = Set(UserDefaults.standard.stringArray(forKey: Self.flagKey) ?? [])
        if on { flagged.insert(conversationId) } else { flagged.remove(conversationId) }
        UserDefaults.standard.set(Array(flagged), forKey: Self.flagKey)
    }

    /// What a private send puts on the wire: one ciphertext per recipient device.
    ///
    /// Own devices included, the sending device excluded — a message sent from a
    /// phone has to be readable on the iPad, and an envelope addressed to the
    /// device that already holds the plaintext proves nothing.
    ///
    /// Nil means there was nobody to encrypt to, which is not an error: the
    /// caller sends in the clear rather than posting something nobody can read.
    func sealFor(memberIds: [String], plaintext: String) async -> [(String, String)]? {
        guard available, !memberIds.isEmpty else { return nil }
        do {
            let claimed = try await repo.claimKeys(userIds: memberIds)
            let mine = session.deviceId
            let bundles = claimed.bundles.filter { $0.deviceId != mine }
            guard !bundles.isEmpty else { return nil }
            return bundles.map { ($0.deviceId, Self.seal(plaintext, to: $0.deviceId)) }
        } catch {
            return nil
        }
    }

    /// NOT ENCRYPTION. Tagged with its recipient so a mis-routed copy is obvious.
    private static func seal(_ plaintext: String, to deviceId: String) -> String {
        prefix + Data("\(deviceId)|\(plaintext)".utf8).base64EncodedString()
    }

    /// The other half. Nil when this is not ours to read — addressed to another
    /// device, or a real ciphertext this build cannot open.
    nonisolated func open(_ ciphertext: String?) -> String? {
        guard let ciphertext, ciphertext.hasPrefix(Self.prefix) else { return nil }
        let body = String(ciphertext.dropFirst(Self.prefix.count))
        guard let data = Data(base64Encoded: body),
              let decoded = String(data: data, encoding: .utf8),
              let bar = decoded.firstIndex(of: "|")
        else { return nil }
        guard String(decoded[decoded.startIndex ..< bar]) == session.deviceId else { return nil }
        return String(decoded[decoded.index(after: bar)...])
    }
}
