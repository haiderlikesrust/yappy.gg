import CryptoKit
import Foundation

/// The cipher, byte-for-byte the same as the web and Android clients'.
///
/// See apps/webapp/src/lib/cipher.ts for why it is built this way: an ephemeral
/// X25519 keypair per recipient device per message, agreed against that device's
/// signed prekey and — when it still has one — a one-time prekey, both fed to
/// HKDF for a message key used exactly once, ChaCha20-Poly1305 over the message
/// with the header as associated data, and an Ed25519 signature over the header
/// and the ciphertext so authorship is a cryptographic claim rather than a
/// database column.
///
/// The three files have to agree on every byte that is hashed, signed, or
/// authenticated, which is why the field list, the separator and the salt are
/// spelled out here rather than derived. A message sealed on a laptop has to
/// open on a phone; there is no version of this where each platform has its own
/// idea of the format. `packages/shared/vectors/e2e.json` is what keeps them
/// honest — each client seals one message with the fixed keys in that file, and
/// every client opens all of them.
///
/// CryptoKit does all of it and has since iOS 13, so there is no dependency
/// here and the private halves stay in the keychain where `DeviceKeys` put them.
enum Cipher {
    static let prefix = "yx3dh.v1."
    private static let domain = "yappy.e2e.v1"

    /// Separates header fields: a unit separator, which cannot occur in base64,
    /// a uuid or a decimal number, so the joined string parses back exactly one
    /// way. Without it `p=1, o=23` and `p=12, o=3` would authenticate the same
    /// bytes.
    private static let sep = "\u{001F}"

    /// A constant, so both sides derive the same thing without exchanging it.
    private static let salt = Data(SHA256.hash(data: Data("\(domain).salt".utf8)))

    /// This device's private halves, as `DeviceKeys` holds them.
    struct Privates {
        var deviceId: String
        var userId: String
        var identityPrivate: String
        var signedPreKeyId: Int
        var signedPreKeyPrivate: String
        /// id → private key, for the one-time prekeys still held.
        var preKeys: [Int: String]
    }

    /// The header, before it is signed and after it is parsed.
    ///
    /// The envelope JSON itself is not covered by the signature — only the
    /// fields joined by `sep` are — so the platforms are free to disagree about
    /// key order, whitespace, and how they spell a null.
    private struct Header: Codable {
        var v: Int
        var s: String
        var u: String
        var r: String
        var e: String
        var p: Int
        var o: Int?
        var n: String
        var c: String
        var g: String

        /// `o` is written even when it is nil.
        ///
        /// The synthesised encoder would leave the key out entirely, and the
        /// other two clients read a missing `o` as a parse failure rather than
        /// as "this message used no one-time prekey". An explicit null is the
        /// only spelling all three agree on.
        func encode(to encoder: Encoder) throws {
            var out = encoder.container(keyedBy: CodingKeys.self)
            try out.encode(v, forKey: .v)
            try out.encode(s, forKey: .s)
            try out.encode(u, forKey: .u)
            try out.encode(r, forKey: .r)
            try out.encode(e, forKey: .e)
            try out.encode(p, forKey: .p)
            try out.encode(o, forKey: .o)
            try out.encode(n, forKey: .n)
            try out.encode(c, forKey: .c)
            try out.encode(g, forKey: .g)
        }
    }

    // ── the bytes that get signed and authenticated ──────────────────────────

    /// Everything about a message except its body, in a fixed order — the AEAD's
    /// associated data, and, with the ciphertext appended, what gets signed. One
    /// field list, because a field in one and not the other is a hole.
    private static func fields(
        _ s: String, _ u: String, _ r: String, _ e: String, _ p: Int, _ o: Int?
    ) -> String {
        [domain, "1", s, u, r, e, String(p), o.map(String.init) ?? "-"].joined(separator: sep)
    }

    /// The message key. Two agreements when the recipient had a one-time prekey
    /// to spare, one when it did not — X3DH's documented degraded mode.
    private static func messageKey(_ dhSpk: Data, _ dhOtk: Data?, _ info: Data) -> SymmetricKey {
        let ikm = dhOtk.map { dhSpk + $0 } ?? dhSpk
        return HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: ikm),
            salt: salt,
            info: info,
            outputByteCount: 32
        )
    }

    private static func agree(_ privateKey: Data, _ publicKey: Data) throws -> Data {
        let mine = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: privateKey)
        let theirs = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: publicKey)
        return try mine.sharedSecretFromKeyAgreement(with: theirs).withUnsafeBytes { Data($0) }
    }

    // ── sealing ──────────────────────────────────────────────────────────────

    enum CipherError: Error {
        /// The bundle's signed prekey is not signed by the identity it claims.
        case unverifiedPreKey(deviceId: String)
        case malformed
    }

    /// One sealed copy, for one device.
    ///
    /// Throws when the bundle's signed prekey is not signed by the identity key
    /// it claims to come from. That signature is the only thing between a sender
    /// and a prekey the server invented, so a bad one is refused rather than
    /// encrypted to — the caller drops that device, and if that leaves nobody,
    /// sends in the clear rather than into a hole.
    static func sealTo(_ plaintext: String, bundle: KeyBundle, sender: Privates) throws -> String {
        guard let identityKey = Data(base64Encoded: bundle.identityKey),
              let spk = Data(base64Encoded: bundle.signedPreKey.key),
              let signature = Data(base64Encoded: bundle.signedPreKey.signature),
              let identity = try? Curve25519.Signing.PublicKey(rawRepresentation: identityKey),
              identity.isValidSignature(signature, for: spk)
        else { throw CipherError.unverifiedPreKey(deviceId: bundle.deviceId) }

        let ephemeral = Curve25519.KeyAgreement.PrivateKey()
        let dhSpk = try agree(ephemeral.rawRepresentation, spk)
        let dhOtk = try bundle.oneTimePreKey
            .flatMap { Data(base64Encoded: $0.key) }
            .map { try agree(ephemeral.rawRepresentation, $0) }

        let e = ephemeral.publicKey.rawRepresentation.base64EncodedString()
        let p = bundle.signedPreKey.id
        let o = bundle.oneTimePreKey?.id
        let nonce = ChaChaPoly.Nonce()
        let nonceBytes = nonce.withUnsafeBytes { Data($0) }
        let n = nonceBytes.base64EncodedString()

        let aadText = fields(sender.deviceId, sender.userId, bundle.deviceId, e, p, o)
        let aad = Data(aadText.utf8)
        let box = try ChaChaPoly.seal(
            Data(plaintext.utf8),
            using: messageKey(dhSpk, dhOtk, aad),
            nonce: nonce,
            authenticating: aad
        )
        // On the wire the nonce travels in its own field, so this is the
        // ciphertext with its tag appended — what every other platform's AEAD
        // hands back, and not CryptoKit's `combined`, which prefixes the nonce.
        let c = (box.ciphertext + box.tag).base64EncodedString()

        guard let identityPrivate = Data(base64Encoded: sender.identityPrivate) else {
            throw CipherError.malformed
        }
        let signing = try Curve25519.Signing.PrivateKey(rawRepresentation: identityPrivate)
        let g = try signing.signature(for: Data((aadText + sep + c).utf8)).base64EncodedString()

        let header = Header(v: 1, s: sender.deviceId, u: sender.userId, r: bundle.deviceId,
                            e: e, p: p, o: o, n: n, c: c, g: g)
        let json = try JSONEncoder().encode(header)
        return prefix + json.base64EncodedString()
    }

    // ── opening ──────────────────────────────────────────────────────────────

    private static func parse(_ envelope: String?) -> Header? {
        guard let envelope, envelope.hasPrefix(prefix),
              let json = Data(base64Encoded: String(envelope.dropFirst(prefix.count))),
              let header = try? JSONDecoder().decode(Header.self, from: json),
              header.v == 1
        else { return nil }
        return header
    }

    /// Who a sealed message claims to be from, so the reader knows whose
    /// identity key to fetch. A claim, and treated as one: `openSealed` believes
    /// it only after the signature checks out against that key.
    static func sealedSender(_ envelope: String?) -> (userId: String, deviceId: String)? {
        parse(envelope).map { ($0.u, $0.s) }
    }

    /// The message, or nil — and nil is a real answer, not only an error.
    ///
    /// Every refusal ends the same way on purpose: a copy addressed to another
    /// device, a prekey this device no longer holds, a signature from somebody
    /// other than the person the server says wrote it, a tag that does not
    /// check. The caller says "this device cannot read this", which is true of
    /// all of them, and none of them tell an attacker which one they hit.
    static func openSealed(
        _ envelope: String?,
        me: Privates,
        senderIdentityKey: String?,
        expectedAuthorId: String
    ) -> String? {
        guard let h = parse(envelope), let senderIdentityKey else { return nil }

        // Addressed to this device, and from the person the server says wrote
        // it. The second check stops a sealed body being lifted off one message
        // and hung under somebody else's name.
        guard h.r == me.deviceId, h.u == expectedAuthorId else { return nil }

        do {
            let aadText = fields(h.s, h.u, h.r, h.e, h.p, h.o)
            let aad = Data(aadText.utf8)

            guard let identityKey = Data(base64Encoded: senderIdentityKey),
                  let signature = Data(base64Encoded: h.g),
                  let body = Data(base64Encoded: h.c),
                  let nonceBytes = Data(base64Encoded: h.n),
                  let ephemeral = Data(base64Encoded: h.e),
                  let verifier = try? Curve25519.Signing.PublicKey(rawRepresentation: identityKey),
                  verifier.isValidSignature(signature, for: Data((aadText + sep + h.c).utf8)),
                  body.count > 16
            else { return nil }

            guard h.p == me.signedPreKeyId else { return nil }
            let otkPrivate = h.o.flatMap { me.preKeys[$0] }
            if h.o != nil, otkPrivate == nil { return nil }

            guard let spkPrivate = Data(base64Encoded: me.signedPreKeyPrivate) else { return nil }
            let dhSpk = try agree(spkPrivate, ephemeral)
            let dhOtk = try otkPrivate
                .flatMap { Data(base64Encoded: $0) }
                .map { try agree($0, ephemeral) }

            let box = try ChaChaPoly.SealedBox(
                nonce: ChaChaPoly.Nonce(data: nonceBytes),
                ciphertext: body.prefix(body.count - 16),
                tag: body.suffix(16)
            )
            let opened = try ChaChaPoly.open(
                box,
                using: messageKey(dhSpk, dhOtk, aad),
                authenticating: aad
            )
            return String(data: opened, encoding: .utf8)
        } catch {
            return nil
        }
    }
}
