import Foundation

/// The session layer: who a message gets sealed to, what this device can open,
/// and where the answer is kept.
///
/// The envelope is in `Cipher` and the ratchet under it in `Ratchet`. What lives
/// here is everything that has to touch the network or the disk: claiming the
/// prekeys that start a session, fetching the identity key a signature is
/// checked against, and writing down what a message said — because with a
/// ratchet, that is the only copy that survives.
actor E2E {
    private static let flagKey = "yappy.e2e.conversations"
    /// Long enough that reading a screenful is one request per person.
    private static let directoryTTL: TimeInterval = 5 * 60

    private let repo: YappyRepository
    private let session: SessionStore
    private let keys: DeviceKeys
    private let store: E2EStore

    private struct DirectoryEntry {
        let fetchedAt: Date
        /// device id → Ed25519 identity key.
        let byDevice: [String: String]
    }

    private var directory: [String: DirectoryEntry] = [:]

    init(repo: YappyRepository, session: SessionStore, keys: DeviceKeys, store: E2EStore) {
        self.repo = repo
        self.session = session
        self.keys = keys
        self.store = store
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

    // ── the devices of everybody else ────────────────────────────────────────

    /// Everything the directory says about one person's devices.
    ///
    /// Refetched when a message names a device the cache has never seen — that
    /// is exactly what somebody adding a phone looks like from here, and the
    /// alternative is that their first message from it is permanently
    /// unreadable.
    private func devicesOf(_ userId: String, wanted: String? = nil) async -> [String: String] {
        if let hit = directory[userId],
           Date().timeIntervalSince(hit.fetchedAt) < Self.directoryTTL,
           wanted == nil || hit.byDevice[wanted!] != nil
        {
            return hit.byDevice
        }
        do {
            let devices = try await repo.userKeys(userId).devices
            let byDevice = Dictionary(
                devices.map { ($0.deviceId, $0.identityKey) },
                uniquingKeysWith: { first, _ in first }
            )
            directory[userId] = DirectoryEntry(fetchedAt: Date(), byDevice: byDevice)
            return byDevice
        } catch {
            return directory[userId]?.byDevice ?? [:]
        }
    }

    /// The identity key a device publishes, which is what its signatures are checked against.
    private func identityKey(of userId: String, device deviceId: String) async -> String? {
        await devicesOf(userId, wanted: deviceId)[deviceId]
    }

    // ── sealing ──────────────────────────────────────────────────────────────

    /// What a private send puts on the wire: one ciphertext per recipient
    /// device, each under its own ratchet.
    ///
    /// Own devices included — a message sent from a phone has to be readable on
    /// the iPad — but not the device doing the sending, which cannot hold a
    /// ratchet session with itself and writes down what it said instead.
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

            // Nobody but us in the recipient list means the caller could not work out who
            // the message is for — a group, where the client holds no full membership. A
            // send like that would seal to this account's own devices and post something
            // the rest of the room could never read, so it goes out in the clear instead,
            // which is what a group message already is.
            guard memberIds.contains(where: { $0 != me.userId }) else { return nil }

            var targets: [String] = []
            for userId in memberIds {
                targets.append(contentsOf: await devicesOf(userId).keys)
            }
            targets = targets.filter { $0 != deviceId }
            guard !targets.isEmpty else { return nil }

            // A claim spends a one-time prekey from every device it returns, so
            // it asks only about the ones with no session yet. A conversation
            // that has been running a while claims nothing at all.
            var strangers: [String] = []
            for target in targets {
                if await store.loadSession(target) == nil { strangers.append(target) }
            }
            var bundles: [String: KeyBundle] = [:]
            if !strangers.isEmpty {
                let claimed = try await repo.claimKeys(userIds: memberIds, deviceIds: strangers)
                bundles = Dictionary(
                    claimed.bundles.map { ($0.deviceId, $0) },
                    uniquingKeysWith: { first, _ in first }
                )
            }

            var envelopes: [(String, String)] = []
            for target in targets {
                let bundle = bundles[target]
                let envelope: String? = await store.withSession(target) { existing in
                    let start = existing ?? bundle.flatMap { try? Cipher.beginSession(bundle: $0) }
                    guard let start else { return (nil, nil) }
                    let sealed = Cipher.sealWith(start, plaintext, sender: me)
                    return (sealed?.session, sealed?.envelope)
                }
                if let envelope { envelopes.append((target, envelope)) }
            }

            return envelopes.isEmpty ? nil : envelopes
        } catch {
            return nil
        }
    }

    // ── opening ──────────────────────────────────────────────────────────────

    /// What this device can read of an encrypted message.
    ///
    /// Asked of the local store first, and that is not an optimisation: a
    /// ratchet destroys a message key as it uses it, so a ciphertext opens
    /// exactly once on this device, ever. What was written down the first time
    /// is the only copy that survives a relaunch.
    ///
    /// `authorId` is the server's word for who wrote it, and the signature has
    /// to agree — a sealed body lifted from one message and hung under another
    /// name fails here rather than being shown under the wrong face.
    func open(_ messageId: String, _ ciphertext: String?, authorId: String?) async -> String? {
        if let known = await store.recall(messageId) { return known }
        guard let ciphertext, let authorId,
              let claim = Cipher.sealedSender(ciphertext),
              claim.userId == authorId,
              let deviceId = session.deviceId,
              let me = await keys.privates(deviceId: deviceId),
              let senderKey = await identityKey(of: claim.userId, device: claim.deviceId)
        else { return nil }

        let read: Cipher.Read? = await store.withSession(claim.deviceId) { existing in
            let result = Cipher.openSealed(
                ciphertext,
                session: existing,
                me: me,
                senderIdentityKey: senderKey,
                expectedAuthorId: authorId
            )
            return (result?.session, result)
        }
        guard let read else { return nil }

        // Written down before anything else. A message that displays once and is
        // blank after a relaunch is worse than one that never showed.
        await store.remember(messageId, read.plaintext)

        // And only then is the prekey that started this session spent. In the
        // other order, a crash between the two would leave a message nobody can
        // ever read.
        if let consumed = read.consumedPreKeyId { await keys.consumePreKey(consumed) }
        return read.plaintext
    }

    /// A sender knows what it said; it should not have to open its own copy to prove it.
    func rememberOwn(_ messageId: String, _ plaintext: String) async {
        await store.remember(messageId, plaintext)
    }

    /// A deleted message leaves nothing readable behind on this device either.
    func forget(_ messageId: String) async {
        await store.forget(messageId)
    }
}
