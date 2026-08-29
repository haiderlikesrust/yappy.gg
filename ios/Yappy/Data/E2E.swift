import Foundation

/// The session layer: who a message gets sealed to, and what this device can
/// open. The cipher itself is in `Cipher`, and it is real — there is no
/// placeholder left anywhere in this path.
///
/// What is still deliberately narrow: one message key per message, with no
/// ratchet chaining them, and a per-conversation switch that only exists in a
/// debug build. Everything around it was built against a fake cipher precisely
/// so that swapping in a real one would touch two functions.
actor E2E {
    private static let flagKey = "yappy.e2e.conversations"
    /// Long enough that reading a screenful is one request per person.
    private static let directoryTTL: TimeInterval = 5 * 60

    private let repo: YappyRepository
    private let session: SessionStore
    private let keys: DeviceKeys

    private struct DirectoryEntry {
        let fetchedAt: Date
        /// device id → Ed25519 identity key.
        let byDevice: [String: String]
    }

    private var directory: [String: DirectoryEntry] = [:]

    init(repo: YappyRepository, session: SessionStore, keys: DeviceKeys) {
        self.repo = repo
        self.session = session
        self.keys = keys
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

    // ── the identity keys of everybody else ──────────────────────────────────

    /// The identity key a device publishes, which is what its signatures are
    /// checked against.
    ///
    /// Cached per person, and refetched when a message names a device the cache
    /// has never seen — which is exactly what somebody adding a phone looks like
    /// from here, and the alternative is that their first message from it is
    /// permanently unreadable.
    private func identityKey(of userId: String, device deviceId: String) async -> String? {
        if let hit = directory[userId],
           hit.byDevice[deviceId] != nil || Date().timeIntervalSince(hit.fetchedAt) < Self.directoryTTL
        {
            return hit.byDevice[deviceId]
        }
        do {
            let fresh = try await repo.userKeys(userId).devices
            let byDevice = Dictionary(
                fresh.map { ($0.deviceId, $0.identityKey) },
                uniquingKeysWith: { first, _ in first }
            )
            directory[userId] = DirectoryEntry(fetchedAt: Date(), byDevice: byDevice)
            return byDevice[deviceId]
        } catch {
            return nil
        }
    }

    // ── sealing ──────────────────────────────────────────────────────────────

    /// What a private send puts on the wire: one ciphertext per recipient device.
    ///
    /// Own devices included, and that now includes the device doing the sending.
    /// It has the plaintext in front of it today and none of it tomorrow: there
    /// is no local message store, so on the next launch the only copy of what
    /// you said is the one on the server, and if nothing there is addressed to
    /// you, your own messages come back unreadable.
    ///
    /// Nil means there was nobody to encrypt to, which is not an error: the
    /// caller sends in the clear rather than posting something nobody can read.
    /// A device whose signed prekey does not verify is dropped on its own —
    /// that is one bad device, and everybody else is still owed their copy.
    func sealFor(memberIds: [String], plaintext: String) async -> [(String, String)]? {
        guard available, !memberIds.isEmpty else { return nil }
        do {
            guard let deviceId = session.deviceId,
                  let me = await keys.privates(deviceId: deviceId)
            else { return nil }

            let bundles = try await repo.claimKeys(userIds: memberIds).bundles
            let sealed = bundles.compactMap { bundle -> (String, String)? in
                guard let ciphertext = try? Cipher.sealTo(plaintext, bundle: bundle, sender: me)
                else { return nil }
                return (bundle.deviceId, ciphertext)
            }
            return sealed.isEmpty ? nil : sealed
        } catch {
            return nil
        }
    }

    // ── opening ──────────────────────────────────────────────────────────────

    /// What this device can read of an encrypted message.
    ///
    /// `authorId` is the server's word for who wrote it, and the signature has
    /// to agree — a sealed body lifted from one message and hung under another
    /// name fails here rather than being shown under the wrong face.
    ///
    /// Nil covers every refusal: no keys on this device, a copy for a different
    /// device, an unknown sender, a tag that does not check.
    func open(_ ciphertext: String?, authorId: String?) async -> String? {
        guard let ciphertext, let authorId,
              let claim = Cipher.sealedSender(ciphertext),
              let deviceId = session.deviceId,
              let me = await keys.privates(deviceId: deviceId)
        else { return nil }

        let senderKey = await identityKey(of: claim.userId, device: claim.deviceId)
        return Cipher.openSealed(
            ciphertext,
            me: me,
            senderIdentityKey: senderKey,
            expectedAuthorId: authorId
        )
    }
}
