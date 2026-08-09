import Foundation

/// A JSON value, built explicitly at the call site.
///
/// Request bodies are assembled from these rather than encoded reflectively
/// from a Swift struct. It costs a few lines per endpoint and buys a payload
/// that is visible in the source: what the server receives is exactly what the
/// call site wrote, with no `CodingKeys` indirection to check and no chance of a
/// renamed property silently changing the wire format.
/// `Hashable` so the models that carry raw JSON — a user's privacy blob, a
/// message's entity spans — stay `Hashable` themselves, which is what lets
/// SwiftUI diff them in a list.
enum JSONValue: Codable, Hashable {
    case string(String)
    case int(Int)
    case int64(Int64)
    case double(Double)
    case bool(Bool)
    case array([JSONValue])
    case object([String: JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Int64.self) {
            self = .int64(value)
        } else if let value = try? container.decode(Double.self) {
            self = .double(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
        } else {
            self = .null
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .int(let value): try container.encode(value)
        case .int64(let value): try container.encode(value)
        case .double(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }

    // ── Reading ──────────────────────────────────────────────────────────────
    // Gateway payloads are read as loose JSON rather than decoded into a type:
    // most events carry three fields the client cares about, and a strict
    // decode would drop the whole event when a newer server adds a fourth.

    subscript(key: String) -> JSONValue? {
        guard case .object(let fields) = self else { return nil }
        let value = fields[key]
        // An explicit null is the same as absent to every reader here.
        if case .null = value { return nil }
        return value
    }

    /// True when the key is present at all, null included. `conversation.update`
    /// needs this: a null `avatarUrl` means "cleared", while an absent one means
    /// "unchanged", and collapsing the two wipes a group's picture on every
    /// rename.
    func has(_ key: String) -> Bool {
        guard case .object(let fields) = self else { return false }
        return fields[key] != nil
    }

    var stringValue: String? {
        switch self {
        case .string(let value): return value
        case .int(let value): return String(value)
        case .int64(let value): return String(value)
        case .bool(let value): return String(value)
        case .double(let value): return String(value)
        default: return nil
        }
    }

    /// Narrowing uses the failable initialisers on purpose.
    ///
    /// `Int(someDouble)` and `Int64(someDouble)` *trap* when the value does not
    /// fit — a crash, not an optional. These read numbers straight off the
    /// socket, so one out-of-range field in one frame would take the process
    /// down. Returning nil lets the caller's existing fallback do its job,
    /// which is what the rest of this type already assumes.
    var intValue: Int? {
        switch self {
        case .int(let value): return value
        case .int64(let value): return Int(exactly: value)
        case .double(let value): return Int(exactly: value.rounded(.towardZero))
        case .string(let value): return Int(value)
        default: return nil
        }
    }

    var int64Value: Int64? {
        switch self {
        case .int(let value): return Int64(value)
        case .int64(let value): return value
        case .double(let value): return Int64(exactly: value.rounded(.towardZero))
        case .string(let value): return Int64(value)
        default: return nil
        }
    }

    var boolValue: Bool? {
        switch self {
        case .bool(let value): return value
        case .string(let value): return value == "true" ? true : (value == "false" ? false : nil)
        default: return nil
        }
    }

    var isNull: Bool {
        if case .null = self { return true }
        return false
    }
}

/// Drops nil entries and keeps explicit `.null` ones.
///
/// This is the Kotlin `field?.let { put(key, it) }` / `put(key, JsonNull)`
/// distinction, which the API relies on: omitting a key leaves a value alone,
/// while sending null clears it. Writing both as `nil` in Swift would make
/// "don't touch my avatar" and "delete my avatar" the same request.
func jsonBody(_ pairs: [String: JSONValue?]) -> JSONValue {
    .object(pairs.compactMapValues { $0 })
}
