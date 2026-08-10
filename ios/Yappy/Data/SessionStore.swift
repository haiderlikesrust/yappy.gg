import Foundation
import Security

/// Token and preference storage.
///
/// Tokens live in the **keychain**, not `UserDefaults`. This is the one place
/// the iOS port deliberately improves on the Android original, whose own note
/// says DataStore relies on app-sandbox isolation and that Keystore encryption
/// "would be the next step". On iOS the equivalent is one API away, so it is
/// done here: `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` keeps the
/// refresh token readable by a background push handler after a reboot, while
/// `ThisDeviceOnly` keeps it out of encrypted backups and off any device the
/// user restores onto — a refresh token restored onto a second device is a
/// session the user never authorised.
///
/// Preferences that are not secrets — the theme, the per-conversation seq
/// cursors — stay in `UserDefaults`, where a synchronous read on the network
/// path is free.
final class SessionStore: @unchecked Sendable {
    private enum Key {
        static let access = "access_token"
        static let refresh = "refresh_token"
        static let userId = "user_id"
        static let deviceId = "device_id"
        static let theme = "theme"
        /// Per-conversation `seq` cursors, so a cold start can ask for a delta.
        static let cursors = "cursors"
        /// Newest release note already shown.
        ///
        /// Deliberately not "seen_release", which 1.1.0 used and got wrong: it
        /// stamped that key on every upgrader before showing them anything, so
        /// the note it was meant to announce was consumed unseen. A new key
        /// makes those installs indistinguishable from any other upgrade, which
        /// is what they always were.
        static let seenRelease = "seen_release_2"
        static let appLock = "app_lock"
        /// `always` | `wifi` | `never`.
        static let autoDownload = "auto_download"
    }

    private let service = "gg.yappy.app.session"
    private let defaults = UserDefaults.standard

    /**
     * Whether an account was already signed in when the process started.
     *
     * Captured here, at construction, because that happens during app launch —
     * before any sign-in this session could set it. Read later it would be true
     * for a brand-new account too, and the whole point is telling those apart.
     *
     * This is what distinguishes "never had yappy before" from "has been using
     * yappy, and is running a build that added a preference it has never
     * written". Without it every new device preference looks like a fresh
     * install forever.
     */
    let hadSessionAtLaunch: Bool

    init() {
        hadSessionAtLaunch = UserDefaults.standard.string(forKey: Key.userId) != nil
    }

    /// Tokens are read on every request, so they are cached in memory and the
    /// keychain is only touched on write and on the first read after launch.
    ///
    /// The cache is only coherent for the instance `saveTokens` is called on,
    /// which makes a second `SessionStore` actively dangerous rather than
    /// merely wasteful: it latches whatever was in the keychain at its first
    /// read and never sees another refresh. One did exist, feeding the image
    /// pipeline, and it silently broke every private attachment a few minutes
    /// after launch. **There must be exactly one of these** — `AppContainer`
    /// owns it, and everything else takes that one.
    private let lock = NSLock()
    private var cachedAccess: String?
    private var cachedRefresh: String?
    private var loaded = false

    // ── Tokens ───────────────────────────────────────────────────────────────

    private func loadIfNeeded() {
        guard !loaded else { return }
        cachedAccess = keychainRead(Key.access)
        cachedRefresh = keychainRead(Key.refresh)
        loaded = true
    }

    var accessToken: String? {
        lock.lock(); defer { lock.unlock() }
        loadIfNeeded()
        return cachedAccess
    }

    var refreshToken: String? {
        lock.lock(); defer { lock.unlock() }
        loadIfNeeded()
        return cachedRefresh
    }

    func saveTokens(access: String, refresh: String) {
        lock.lock()
        loadIfNeeded()
        cachedAccess = access
        cachedRefresh = refresh
        lock.unlock()

        keychainWrite(Key.access, access)
        keychainWrite(Key.refresh, refresh)
    }

    // ── Identity ─────────────────────────────────────────────────────────────

    var userId: String? { defaults.string(forKey: Key.userId) }
    var deviceId: String? { defaults.string(forKey: Key.deviceId) }

    func saveIdentity(userId: String, deviceId: String?) {
        defaults.set(userId, forKey: Key.userId)
        if let deviceId { defaults.set(deviceId, forKey: Key.deviceId) }
    }

    // ── Theme ────────────────────────────────────────────────────────────────

    /// Light unless the person says otherwise.
    ///
    /// Not "system": yappy's light theme is the designed one — the violet-grey
    /// sheet the whole neumorphic language is built on — and following the
    /// handset means most people meet the app in the variant that is a
    /// translation of it. "System" is still offered in Settings for anyone who
    /// wants it.
    var theme: ThemePreference {
        ThemePreference(rawValue: defaults.string(forKey: Key.theme) ?? "light") ?? .light
    }

    func setTheme(_ value: ThemePreference) {
        defaults.set(value.rawValue, forKey: Key.theme)
    }

    // ── Device preferences ───────────────────────────────────────────────────

    /// The newest release note this install has already shown.
    ///
    /// Nil on a fresh install *and* on the first run of a build that added the
    /// key, so it is never enough on its own — pair it with
    /// `hadSessionAtLaunch`. See `WhatsNewGate.check()`.
    var seenRelease: String? { defaults.string(forKey: Key.seenRelease) }

    func setSeenRelease(_ id: String) { defaults.set(id, forKey: Key.seenRelease) }

    /// Face ID / passcode on the app itself. Device-local by definition: it
    /// protects this handset, and syncing it would lock someone out of a phone
    /// they never enabled it on.
    var appLock: Bool { defaults.bool(forKey: Key.appLock) }

    func setAppLock(_ on: Bool) { defaults.set(on, forKey: Key.appLock) }

    /// `always` | `wifi` | `never`. Defaults to Wi-Fi only: the app sends video
    /// notes now, and the polite default for someone else's data plan is not
    /// to spend it without asking.
    var autoDownload: String { defaults.string(forKey: Key.autoDownload) ?? "wifi" }

    func setAutoDownload(_ value: String) { defaults.set(value, forKey: Key.autoDownload) }

    // ── Cursors ──────────────────────────────────────────────────────────────

    /// Serialised as `id:seq,id:seq` — small, and avoids a second encoder.
    func saveCursors(_ cursors: [String: Int64]) {
        let encoded = cursors.map { "\($0.key):\($0.value)" }.joined(separator: ",")
        defaults.set(encoded, forKey: Key.cursors)
    }

    func loadCursors() -> [String: Int64] {
        let raw = defaults.string(forKey: Key.cursors) ?? ""
        guard !raw.isEmpty else { return [:] }

        var result: [String: Int64] = [:]
        for entry in raw.split(separator: ",") {
            let parts = entry.split(separator: ":")
            guard parts.count == 2, let seq = Int64(parts[1]) else { continue }
            result[String(parts[0])] = seq
        }
        return result
    }

    // ── Teardown ─────────────────────────────────────────────────────────────

    func clear() {
        lock.lock()
        cachedAccess = nil
        cachedRefresh = nil
        loaded = true
        lock.unlock()

        keychainDelete(Key.access)
        keychainDelete(Key.refresh)
        // The theme survives sign-out: it is a device preference, not account
        // state, and re-theming the sign-in screen would be a strange goodbye.
        defaults.removeObject(forKey: Key.userId)
        defaults.removeObject(forKey: Key.deviceId)
        defaults.removeObject(forKey: Key.cursors)
    }

    // ── Keychain ─────────────────────────────────────────────────────────────

    private func query(_ account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    private func keychainRead(_ account: String) -> String? {
        var request = query(account)
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        guard SecItemCopyMatching(request as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data
        else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private func keychainWrite(_ account: String, _ value: String) {
        let data = Data(value.utf8)
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]

        // Update first: SecItemAdd on an existing account fails with
        // errSecDuplicateItem, and a token rotation happens on every refresh.
        let status = SecItemUpdate(query(account) as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            SecItemAdd(query(account).merging(attributes) { _, new in new } as CFDictionary, nil)
        }
    }

    private func keychainDelete(_ account: String) {
        SecItemDelete(query(account) as CFDictionary)
    }
}
