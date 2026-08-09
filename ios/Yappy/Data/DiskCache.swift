import Foundation

/// Last-known-good responses, on disk, for first paint.
///
/// This is not a general HTTP cache and is deliberately much dumber than one:
/// a handful of named slots, each holding the raw bytes of the most recent
/// successful response for one screen's primary fetch. On launch a screen
/// decodes its slot and has something to draw in the first frame; the network
/// fetch it was already going to do then replaces both the screen and the slot.
///
/// Raw bytes rather than re-encoded models, because the app's models are
/// decode-only — they were never asked to round-trip, and giving them an
/// `Encodable` conformance for caching's sake would mean hand-maintaining
/// encoders nobody else uses. The server's own JSON is already the wire format
/// every model knows how to read; keeping it verbatim also means a cached blob
/// survives model fields being added, exactly as a live response would.
///
/// Everything is best-effort. A failed write costs the next launch a spinner;
/// a failed read costs nothing at all. Nothing here may ever make a feature
/// worse than having no cache.
enum DiskCache {
    private static var directory: URL {
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("yappy-snapshots", isDirectory: true)
    }

    /// Slot names arrive as "history_<uuid>" and the like — safe already, but
    /// sanitised anyway so no caller can ever aim a path at a parent directory.
    private static func file(for key: String) -> URL {
        let safe = key.map { $0.isLetter || $0.isNumber || $0 == "_" || $0 == "-" ? $0 : "_" }
        return directory.appendingPathComponent(String(safe) + ".json")
    }

    static func write(_ data: Data, key: String) {
        let target = file(for: key)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try data.write(to: target, options: .atomic)
        } catch {
            // A cache that cannot write is just a cache that misses.
        }
    }

    static func read(key: String) -> Data? {
        try? Data(contentsOf: file(for: key))
    }

    /// Decode a slot as the envelope type its endpoint returns. A blob from an
    /// older build that no longer decodes reads as a miss, not an error.
    static func decode<T: Decodable>(_ type: T.Type, key: String) -> T? {
        guard let data = read(key: key) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }

    /// Sign-out. The next account on this device must not paint the previous
    /// account's chats, even for one frame.
    static func clear() {
        try? FileManager.default.removeItem(at: directory)
    }
}
