import Foundation

/// Where ratchet sessions and opened messages live on this device.
///
/// Two things, one file each, in Application Support rather than Caches — the
/// system empties Caches whenever it likes, and either of these disappearing
/// means a conversation that can no longer be read. Excluded from iCloud
/// backup: a session restored onto a second device would be two devices sharing
/// one ratchet, which breaks both of them.
///
/// **Sessions** are a position in two chains. Two sends that both read one and
/// both write it back leave one of them stepped over: the same message number
/// used twice, and every message after it unreadable at the other end. Nothing
/// about that failure is loud — it looks like the network, until the whole
/// conversation is broken. An actor is the lock.
///
/// **Opened messages** are not a cache. A ratchet destroys a message key as it
/// uses it, so a ciphertext opens exactly once on this device, ever. What is
/// written here is the only copy that survives a relaunch — kept in the clear
/// on purpose, because encrypting it would need a key stored beside it, in the
/// same sandbox, readable by the same process.
actor E2EStore {
    private let sessionDir: URL
    private let plaintextDir: URL

    init() {
        let base = (try? FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )) ?? URL(fileURLWithPath: NSTemporaryDirectory())

        let root = base.appendingPathComponent("yappy-e2e", isDirectory: true)
        sessionDir = root.appendingPathComponent("sessions", isDirectory: true)
        plaintextDir = root.appendingPathComponent("plaintext", isDirectory: true)

        for directory in [sessionDir, plaintextDir] {
            try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        }
        var excluded = root
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? excluded.setResourceValues(values)
    }

    /// Ids arrive as uuids, but nothing may ever aim a path at a parent directory.
    private func safe(_ name: String) -> String {
        String(name.map { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" ? $0 : "_" })
    }

    // ── sessions ─────────────────────────────────────────────────────────────

    func loadSession(_ deviceId: String) -> Ratchet.Session? {
        let url = sessionDir.appendingPathComponent("\(safe(deviceId)).json")
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(Ratchet.Session.self, from: data)
    }

    private func saveSession(_ session: Ratchet.Session) {
        guard let data = try? JSONEncoder().encode(session) else { return }
        try? data.write(
            to: sessionDir.appendingPathComponent("\(safe(session.deviceId)).json"),
            options: .atomic
        )
    }

    /// Hold one device's session for the length of an operation.
    ///
    /// The block is handed whatever is stored — nil when this device has never
    /// been spoken to — and returns the session to store along with whatever the
    /// caller wanted. Returning a nil session leaves what was there alone, which
    /// is what a failed decrypt must do: a ratchet that advances on a message
    /// nobody could read has lost its place.
    ///
    /// The actor is the lock, and it is one lock for every device rather than
    /// one each. Sealing to six devices is six short turns rather than six in
    /// parallel, which is the correct trade for how rarely it happens and how
    /// bad the alternative is.
    func withSession<T>(
        _ deviceId: String,
        _ block: (Ratchet.Session?) -> (Ratchet.Session?, T)
    ) -> T {
        let (session, result) = block(loadSession(deviceId))
        if let session { saveSession(session) }
        return result
    }

    // ── what messages said ───────────────────────────────────────────────────

    func remember(_ messageId: String, _ plaintext: String) {
        try? Data(plaintext.utf8).write(
            to: plaintextDir.appendingPathComponent("\(safe(messageId)).txt"),
            options: .atomic
        )
    }

    func recall(_ messageId: String) -> String? {
        let url = plaintextDir.appendingPathComponent("\(safe(messageId)).txt")
        guard let data = try? Data(contentsOf: url) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// A deleted message leaves nothing behind here either.
    func forget(_ messageId: String) {
        try? FileManager.default.removeItem(
            at: plaintextDir.appendingPathComponent("\(safe(messageId)).txt")
        )
    }
}
