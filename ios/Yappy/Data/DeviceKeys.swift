import CryptoKit
import Foundation

/// This device's cryptographic identity, published so other devices can find it.
///
/// Nothing here encrypts a message. It is the part of end-to-end encryption that
/// cannot be added afterwards: key distribution. A device that has never
/// published an identity key cannot be handed one retroactively, so the day
/// encryption is switched on, every account older than that day would find its
/// other devices unreachable and its history unreadable. Publishing from now on
/// makes that switch a feature flag rather than a migration people experience as
/// loss.
///
/// What a device holds:
///
///   * an **Ed25519 identity key**, generated once and never rotated silently —
///     rotating it is the alarming, visible event ("safety number changed") that
///     the verification mechanism exists to surface;
///   * an **X25519 signed prekey**, carrying a signature from that identity, so
///     a sender can check the prekey really came from this device;
///   * a pool of **one-time prekeys**, each handed out exactly once. The server
///     consumes one as it claims it; reusing one would defeat the forward
///     secrecy they exist to provide.
///
/// CryptoKit does all of it, and has since iOS 13 — no dependency, and the
/// private keys can live in the keychain beside the refresh token rather than in
/// `UserDefaults`, which is the whole reason to prefer it.
actor DeviceKeys {
    /// Below this many unclaimed prekeys, top the pool back up.
    private static let lowWater = 20
    private static let pool = 60

    private let repo: YappyRepository
    private let service = "gg.yappy.app.keys"

    init(repo: YappyRepository) {
        self.repo = repo
    }

    /// Make sure this device has an identity on the server, and enough prekeys.
    ///
    /// Safe to call on every launch: it publishes once per device and afterwards
    /// only tops the pool up when the server says it is running low. Failures
    /// are swallowed — this is groundwork for a feature that does not exist yet,
    /// and it must never be the reason somebody cannot open a chat.
    func ensurePublished(deviceId: String, userId: String) async {
        guard !deviceId.isEmpty, !userId.isEmpty else { return }

        do {
            // A different device id means a different device: the stored private
            // keys belong to a session that is gone.
            guard read(Key.deviceId) == deviceId, let identityRaw = read(Key.identityPrivate) else {
                try await mintAndPublish(deviceId: deviceId, userId: userId)
                return
            }

            // An identity minted before this record carried an account id.
            // Filled in, never re-minted: /keys/publish deliberately refuses to
            // overwrite an identity key that is already out there, so a device
            // that threw its private half away would be left signing with a key
            // nobody can check.
            if read(Key.userId) != userId { write(Key.userId, userId) }

            /// A build that has learned a new message format has to say so, and
            /// it cannot wait for the prekey pool to run down to do it: until
            /// the directory knows, every sender assumes the oldest format in
            /// circulation and this device is talked to as though it were a year
            /// old.
            let stale = read(Key.advertised) != MessageFormats.supported.map(String.init).joined(separator: ",")

            let available = try await repo.preKeyCount().availablePreKeys
            guard available < Self.lowWater || stale else { return }
            try await topUp(
                deviceId: deviceId,
                identityRaw: identityRaw,
                count: available < Self.lowWater ? Self.pool - available : 0
            )
        } catch {
            // Next launch tries again.
        }
    }

    /// The safety number for this device, or nil before one exists.
    func fingerprint() -> String? {
        guard let identity = read(Key.identityPublic) else { return nil }
        let digest = SHA256.hash(data: Data(identity.utf8))
        let hex = digest.map { String(format: "%02x", $0) }.joined()
        // Grouped the way the server groups it, so the two can be compared.
        return stride(from: 0, to: min(hex.count, 60), by: 5)
            .map { start -> String in
                let from = hex.index(hex.startIndex, offsetBy: start)
                let to = hex.index(from, offsetBy: 5, limitedBy: hex.endIndex) ?? hex.endIndex
                return String(hex[from ..< to])
            }
            .joined(separator: " ")
    }

    /// The private halves, for the cipher.
    ///
    /// Nothing else should call this. It hands out key material, and the only
    /// place key material belongs is `Cipher`, which is where every use of it
    /// is auditable in one file. Nil before this device has an identity, or
    /// when the stored one belongs to a session that has since been replaced.
    func privates(deviceId: String) -> Ratchet.Privates? {
        guard read(Key.deviceId) == deviceId,
              let identity = read(Key.identityPrivate),
              let userId = read(Key.userId),
              let spk = read(Key.signedPreKeyPrivate)
        else { return nil }

        var preKeys: [Int: String] = [:]
        for (id, key) in readPreKeys() {
            if let n = Int(id) { preKeys[n] = key }
        }

        return Ratchet.Privates(
            deviceId: deviceId,
            userId: userId,
            identityPrivate: identity,
            signedPreKeyId: Int(read(Key.signedPreKeyId) ?? "1") ?? 1,
            signedPreKeyPrivate: spk,
            preKeys: preKeys
        )
    }

    /// Forget a one-time prekey, now that it has started the session it
    /// existed for.
    ///
    /// This is what makes it one-time. While the private half is still here,
    /// the first message of a session can be replayed into a brand new session
    /// — which re-opens a message whose key was supposed to be spent, and
    /// discards the real session as it goes.
    func consumePreKey(_ id: Int) {
        var stored = readPreKeys()
        guard stored.removeValue(forKey: String(id)) != nil else { return }
        writePreKeys(stored)
        write(Key.advertised, MessageFormats.supported.map(String.init).joined(separator: ","))
    }

    // ── Minting ──────────────────────────────────────────────────────────────

    private func mintAndPublish(deviceId: String, userId: String) async throws {
        let identity = Curve25519.Signing.PrivateKey()
        let signedPre = Curve25519.KeyAgreement.PrivateKey()
        let identityPublic = identity.publicKey.rawRepresentation.base64EncodedString()
        let signedPrePublic = signedPre.publicKey.rawRepresentation

        var stored: [String: String] = [:]
        var published: [(Int, String)] = []
        for id in 1 ... Self.pool {
            let key = Curve25519.KeyAgreement.PrivateKey()
            stored[String(id)] = key.rawRepresentation.base64EncodedString()
            published.append((id, key.publicKey.rawRepresentation.base64EncodedString()))
        }

        write(Key.deviceId, deviceId)
        write(Key.userId, userId)
        write(Key.identityPrivate, identity.rawRepresentation.base64EncodedString())
        write(Key.identityPublic, identityPublic)
        write(Key.signedPreKeyPrivate, signedPre.rawRepresentation.base64EncodedString())
        write(Key.signedPreKeyPublic, signedPrePublic.base64EncodedString())
        write(Key.signedPreKeyId, "1")
        write(Key.lastPreKeyId, String(Self.pool))
        writePreKeys(stored)
        write(Key.advertised, MessageFormats.supported.map(String.init).joined(separator: ","))

        let signature = try identity.signature(for: signedPrePublic)
        try await repo.publishKeys(
            deviceId: deviceId,
            identityKey: identityPublic,
            signedPreKeyId: 1,
            signedPreKey: signedPrePublic.base64EncodedString(),
            signature: signature.base64EncodedString(),
            oneTimePreKeys: published,
            formats: MessageFormats.supported,
            formatsSignature: advertisement(identity)
        )
    }

    private func topUp(deviceId: String, identityRaw: String, count: Int) async throws {
        guard count > 0,
              let identityData = Data(base64Encoded: identityRaw),
              let identityPublic = read(Key.identityPublic),
              let signedPrePublicRaw = read(Key.signedPreKeyPublic),
              let signedPrePublic = Data(base64Encoded: signedPrePublicRaw)
        else { return }

        let identity = try Curve25519.Signing.PrivateKey(rawRepresentation: identityData)
        let from = Int(read(Key.lastPreKeyId) ?? "0") ?? 0

        var stored = readPreKeys()
        var published: [(Int, String)] = []
        for i in stride(from: 1, through: count, by: 1) {
            let id = from + i
            let key = Curve25519.KeyAgreement.PrivateKey()
            stored[String(id)] = key.rawRepresentation.base64EncodedString()
            published.append((id, key.publicKey.rawRepresentation.base64EncodedString()))
        }

        write(Key.lastPreKeyId, String(from + count))
        writePreKeys(stored)
        write(Key.advertised, MessageFormats.supported.map(String.init).joined(separator: ","))

        let signature = try identity.signature(for: signedPrePublic)
        try await repo.publishKeys(
            deviceId: deviceId,
            identityKey: identityPublic,
            signedPreKeyId: Int(read(Key.signedPreKeyId) ?? "1") ?? 1,
            signedPreKey: signedPrePublicRaw,
            signature: signature.base64EncodedString(),
            oneTimePreKeys: published,
            formats: MessageFormats.supported,
            formatsSignature: advertisement(identity)
        )
    }

    /// What this device can read, signed so the server cannot shrink the list.
    ///
    /// A server that wanted every sender to use the weakest format available
    /// would only have to say that is all anybody speaks. This signature makes
    /// that a forgery rather than a policy — see `MessageFormats`.
    private func advertisement(_ identity: Curve25519.Signing.PrivateKey) -> String {
        let claim = Data(MessageFormats.advertisement(MessageFormats.supported).utf8)
        return ((try? identity.signature(for: claim)) ?? Data()).base64EncodedString()
    }

    // ── Keychain ─────────────────────────────────────────────────────────────
    //
    // Same shape as SessionStore's, and for the same reason: a private key is
    // exactly the class of thing that does not belong in UserDefaults. Bound to
    // this device — a key restored onto another one would be a second device
    // claiming to be this one.

    private enum Key {
        static let deviceId = "device_id"
        static let userId = "user_id"
        static let identityPrivate = "identity_private"
        static let identityPublic = "identity_public"
        static let signedPreKeyPrivate = "spk_private"
        static let signedPreKeyPublic = "spk_public"
        static let signedPreKeyId = "spk_id"
        static let lastPreKeyId = "last_prekey_id"
        static let preKeys = "prekeys"
        /// The message formats last published for this device, so a build that
        /// has learned a new one says so rather than waiting for the prekey
        /// pool to run down.
        static let advertised = "advertised_formats"
    }

    private func query(_ account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    private func read(_ account: String) -> String? {
        var request = query(account)
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        guard SecItemCopyMatching(request as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data
        else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private func write(_ account: String, _ value: String) {
        let data = Data(value.utf8)
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        if SecItemUpdate(query(account) as CFDictionary, attributes as CFDictionary) == errSecItemNotFound {
            var insert = query(account)
            insert.merge(attributes) { current, _ in current }
            SecItemAdd(insert as CFDictionary, nil)
        }
    }

    private func readPreKeys() -> [String: String] {
        guard let raw = read(Key.preKeys), let data = raw.data(using: .utf8),
              let map = try? JSONDecoder().decode([String: String].self, from: data)
        else { return [:] }
        return map
    }

    private func writePreKeys(_ map: [String: String]) {
        guard let data = try? JSONEncoder().encode(map),
              let text = String(data: data, encoding: .utf8)
        else { return }
        write(Key.preKeys, text)
    }
}
