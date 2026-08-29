import CryptoKit
import Foundation

/// The envelope: what goes on the wire around a ratcheted message.
///
/// Byte-for-byte the same as apps/webapp/src/lib/cipher.ts, which is where the
/// reasoning lives. `Ratchet` decides what the key is and destroys it
/// afterwards; this decides what travels beside the ciphertext, what is
/// authenticated, and who is allowed to have written it — the header as
/// associated data, and an Ed25519 signature over the header and the ciphertext
/// by the identity key the safety number is computed from.
///
/// The three platforms have to agree on every byte that is hashed, signed, or
/// authenticated, which is why the field list, the separator and the domain
/// string are spelled out here rather than derived.
/// `packages/shared/vectors/e2e.json` is what keeps them honest — and this
/// platform has no entry in it yet, because that needs a Mac.
enum Cipher {
    static let prefix = "yr.v2."
    private static let domain = "yappy.e2e.v2"

    /// Separates header fields: a unit separator, which cannot occur in base64,
    /// a uuid or a decimal number, so the joined string parses back exactly one
    /// way. Without it `pn=1, n=23` and `pn=12, n=3` would authenticate the same
    /// bytes.
    private static let sep = "\u{001F}"

    enum CipherError: Error {
        /// The bundle's signed prekey is not signed by the identity it claims.
        case unverifiedPreKey(deviceId: String)
        case malformed
    }

    /// The header, before it is signed and after it is parsed.
    private struct Header: Codable {
        var v: Int
        /// Sending device, and the account it belongs to. Both are claims until checked.
        var s: String
        var u: String
        /// The one device this copy is for.
        var r: String
        /// The sender's current ratchet public key.
        var d: String
        /// The previous chain's length, and the position in this one.
        var pn: Int
        var n: Int
        /// The X3DH preamble, until the other end has answered.
        var k: Ratchet.PreKeyHeader?
        var c: String
        /// Ed25519 over everything above.
        var g: String

        /// `k` is written even when it is nil, for the same reason `otkId` is:
        /// the other two clients read a missing key as a parse failure.
        func encode(to encoder: Encoder) throws {
            var out = encoder.container(keyedBy: CodingKeys.self)
            try out.encode(v, forKey: .v)
            try out.encode(s, forKey: .s)
            try out.encode(u, forKey: .u)
            try out.encode(r, forKey: .r)
            try out.encode(d, forKey: .d)
            try out.encode(pn, forKey: .pn)
            try out.encode(n, forKey: .n)
            try out.encode(k, forKey: .k)
            try out.encode(c, forKey: .c)
            try out.encode(g, forKey: .g)
        }
    }

    /// Everything about a message except its body, in a fixed order — the AEAD's
    /// associated data, and, with the ciphertext appended, what the identity key
    /// signs. One field list, because a field in one and not the other is a hole.
    private static func fields(
        _ s: String, _ u: String, _ r: String, _ d: String, _ pn: Int, _ n: Int,
        _ k: Ratchet.PreKeyHeader?
    ) -> String {
        [
            domain,
            "2",
            s,
            u,
            r,
            d,
            String(pn),
            String(n),
            k?.ek ?? "-",
            k.map { String($0.spkId) } ?? "-",
            k?.otkId.map(String.init) ?? "-",
        ].joined(separator: sep)
    }

    // ── sealing ──────────────────────────────────────────────────────────────

    /// Start a session with a device that has never been spoken to.
    ///
    /// Throws when the bundle's signed prekey is not signed by the identity key
    /// it claims to come from. That signature is the only thing between a sender
    /// and a prekey the server invented, so a bad one is refused rather than
    /// encrypted to.
    static func beginSession(bundle: KeyBundle) throws -> Ratchet.Session {
        guard let identityKey = Data(base64Encoded: bundle.identityKey),
              let spk = Data(base64Encoded: bundle.signedPreKey.key),
              let signature = Data(base64Encoded: bundle.signedPreKey.signature),
              let identity = try? Curve25519.Signing.PublicKey(rawRepresentation: identityKey),
              identity.isValidSignature(signature, for: spk)
        else { throw CipherError.unverifiedPreKey(deviceId: bundle.deviceId) }

        return try Ratchet.initiate(bundle: bundle)
    }

    struct Sealed {
        var envelope: String
        var session: Ratchet.Session
    }

    /// One sealed copy, for one device, and the session that replaces this one.
    ///
    /// The session is returned rather than written here: the caller holds the
    /// lock on it (see `E2EStore`) and is the only thing that knows whether the
    /// send survived.
    static func sealWith(
        _ session: Ratchet.Session,
        _ plaintext: String,
        sender: Ratchet.Privates
    ) -> Sealed? {
        // Where the next message will sit in the ratchet, without stepping it:
        // the header has to exist before the associated data can bind it, and
        // the associated data has to exist before the message can be encrypted.
        let aadText = fields(
            sender.deviceId,
            sender.userId,
            session.deviceId,
            session.myRatchetPublic,
            session.previousSendCount,
            session.sendCount,
            session.pending
        )

        guard let sealed = Ratchet.encrypt(session, plaintext, aad: Data(aadText.utf8)),
              let identityPrivate = Data(base64Encoded: sender.identityPrivate),
              let signing = try? Curve25519.Signing.PrivateKey(rawRepresentation: identityPrivate),
              let signature = try? signing.signature(for: Data((aadText + sep + sealed.ciphertext).utf8))
        else { return nil }

        let header = Header(
            v: 2,
            s: sender.deviceId,
            u: sender.userId,
            r: session.deviceId,
            d: sealed.header.dh,
            pn: sealed.header.pn,
            n: sealed.header.n,
            k: sealed.header.pre,
            c: sealed.ciphertext,
            g: signature.base64EncodedString()
        )

        guard let json = try? JSONEncoder().encode(header) else { return nil }
        return Sealed(envelope: prefix + json.base64EncodedString(), session: sealed.session)
    }

    // ── opening ──────────────────────────────────────────────────────────────

    private static func parse(_ envelope: String?) -> Header? {
        guard let envelope, envelope.hasPrefix(prefix),
              let json = Data(base64Encoded: String(envelope.dropFirst(prefix.count))),
              let header = try? JSONDecoder().decode(Header.self, from: json),
              header.v == 2
        else { return nil }
        return header
    }

    /// Who a sealed message claims to be from, so the reader knows whose
    /// identity key to fetch. A claim, and treated as one: `openSealed` believes
    /// it only after the signature checks out against that key.
    static func sealedSender(_ envelope: String?) -> (userId: String, deviceId: String)? {
        parse(envelope).map { ($0.u, $0.s) }
    }

    struct Read {
        var plaintext: String
        var session: Ratchet.Session
        /// The prekey a new session consumed, if one was built here. It has now
        /// done the only job it has, and the caller must delete its private
        /// half: a one-time prekey that survives its one time lets the same
        /// first message be replayed into a fresh session, re-opening a message
        /// whose key was meant to be spent and discarding the real session.
        var consumedPreKeyId: Int?
    }

    /// The message and the session that replaces this one, or nil.
    ///
    /// `session` may be nil when this is the first message from a device: the
    /// preamble on it is what builds the session, and a message carrying none is
    /// one this device can no longer place.
    ///
    /// A nil result leaves the caller's stored session untouched on purpose —
    /// the ratchet must not step forward on a message that could not be read.
    static func openSealed(
        _ envelope: String?,
        session: Ratchet.Session?,
        me: Ratchet.Privates,
        senderIdentityKey: String?,
        expectedAuthorId: String
    ) -> Read? {
        guard let h = parse(envelope), let senderIdentityKey else { return nil }

        // Addressed to this device, and from the person the server says wrote it.
        guard h.r == me.deviceId, h.u == expectedAuthorId else { return nil }

        let aadText = fields(h.s, h.u, h.r, h.d, h.pn, h.n, h.k)
        let aad = Data(aadText.utf8)

        guard let identityKey = Data(base64Encoded: senderIdentityKey),
              let signature = Data(base64Encoded: h.g),
              let verifier = try? Curve25519.Signing.PublicKey(rawRepresentation: identityKey),
              verifier.isValidSignature(signature, for: Data((aadText + sep + h.c).utf8))
        else { return nil }

        let wire = Ratchet.Header(dh: h.d, pn: h.pn, n: h.n, pre: h.k)

        // A session this device does not have yet. The preamble builds it.
        let fresh = session == nil ? h.k.flatMap { Ratchet.accept($0, me: me, theirDeviceId: h.s) } : nil
        guard let known = session ?? fresh else { return nil }

        if let opened = Ratchet.decrypt(known, wire, h.c, aad: aad) {
            return Read(
                plaintext: opened.plaintext,
                session: opened.session,
                consumedPreKeyId: fresh != nil ? h.k?.otkId : nil
            )
        }

        // A stored session that cannot read a message still carrying a preamble
        // is a session built from a different one: the sender reinstalled, or
        // this device restored an older copy of itself. Rebuilding from the
        // preamble is the only way back, and it is exactly what a changed safety
        // number means.
        guard let preamble = h.k, session != nil,
              let restarted = Ratchet.accept(preamble, me: me, theirDeviceId: h.s),
              let retry = Ratchet.decrypt(restarted, wire, h.c, aad: aad)
        else { return nil }

        return Read(plaintext: retry.plaintext, session: retry.session, consumedPreKeyId: preamble.otkId)
    }
}
