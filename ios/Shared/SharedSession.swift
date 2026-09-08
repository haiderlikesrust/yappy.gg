import Foundation
import Security
import Darwin

/// Only the app and Share target have this keychain access group. Tokens never
/// enter the widget snapshots or UserDefaults. Each record is one atomic item.
enum SharedSession {
    struct Record: Codable {
        var id: UUID
        var accessToken: String?
        var refreshToken: String?
    }

    enum Failure: Error { case unavailable, rejected, changed, busy }
    private static let mutex = NSLock()

    static var appLockEnabled: Bool {
        get { UserDefaults(suiteName: AppGroup.identifier)?.bool(forKey: "shareAppLock") ?? true }
        set { UserDefaults(suiteName: AppGroup.identifier)?.set(newValue, forKey: "shareAppLock") }
    }

    private static var query: [String: Any] {
        get throws {
            guard let group = Bundle.main.object(forInfoDictionaryKey: "YappySharedKeychainGroup") as? String,
                  !group.isEmpty, !group.contains("$(") else { throw Failure.unavailable }
            return [kSecClass as String: kSecClassGenericPassword,
                    kSecAttrService as String: "gg.yappy.shared-session",
                    kSecAttrAccount as String: "session",
                    kSecAttrAccessGroup as String: group]
        }
    }

    static func read() throws -> Record? {
        mutex.lock(); defer { mutex.unlock() }
        return try readItem()
    }

    /// A short cross-process transaction; never held over a network request.
    @discardableResult
    static func update(_ transform: (Record?) throws -> Record) throws -> Record {
        mutex.lock(); defer { mutex.unlock() }
        let file = try LockFile(name: "session-write")
        guard flock(file.descriptor, LOCK_EX) == 0 else { throw Failure.unavailable }
        defer { flock(file.descriptor, LOCK_UN) }
        let record = try transform(readItem())
        let data = try JSONEncoder().encode(record)
        let itemQuery = try query
        let attributes: [String: Any] = [kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        var status = SecItemUpdate(itemQuery as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(itemQuery.merging(attributes) { _, new in new } as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw Failure.unavailable }
        return record
    }

    private static func readItem() throws -> Record? {
        var request = try query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw Failure.unavailable }
        return try JSONDecoder().decode(Record.self, from: data)
    }

    /// The app and extension serialize token rotation using a separate file
    /// lease. Logout can still invalidate the record while the network waits.
    static func refresh(id: UUID, failedAccess: String?, base: String, http: URLSession) async throws {
        let file = try LockFile(name: "session-refresh")
        let deadline = Date().addingTimeInterval(35)
        while flock(file.descriptor, LOCK_EX | LOCK_NB) != 0 {
            try Task.checkCancellation()
            guard Date() < deadline else { throw Failure.busy }
            try await Task.sleep(for: .milliseconds(50))
        }
        defer { flock(file.descriptor, LOCK_UN) }
        guard let current = try read(), current.id == id,
              let refresh = current.refreshToken, current.accessToken != nil else { throw Failure.changed }
        // A sibling request/process already rotated the token rejected by our request.
        if current.accessToken != failedAccess { return }
        guard let url = URL(string: base + "/auth/refresh") else { throw Failure.unavailable }
        var request = URLRequest(url: url)
        request.timeoutInterval = 25
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["refreshToken": refresh])
        let (data, raw) = try await http.data(for: request)
        guard let response = raw as? HTTPURLResponse else { throw Failure.unavailable }
        if response.statusCode == 401 || response.statusCode == 403 { throw Failure.rejected }
        guard (200..<300).contains(response.statusCode) else { throw Failure.unavailable }
        struct Tokens: Decodable { let accessToken: String; let refreshToken: String }
        let tokens = try JSONDecoder().decode(Tokens.self, from: data)
        try update { latest in
            guard let latest, latest.id == id, latest.accessToken == current.accessToken else { throw Failure.changed }
            return Record(id: id, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken)
        }
    }

    private final class LockFile {
        let descriptor: Int32
        init(name: String) throws {
            guard let container = AppGroup.container else { throw Failure.unavailable }
            let path = container.appendingPathComponent(name + ".lock").path
            descriptor = open(path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
            guard descriptor >= 0 else { throw Failure.unavailable }
        }
        deinit { close(descriptor) }
    }
}
