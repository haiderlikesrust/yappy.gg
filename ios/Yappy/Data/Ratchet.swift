import CryptoKit
import Foundation

/// The Double Ratchet, byte-for-byte the same as the web and Android clients'.
///
/// See apps/webapp/src/lib/ratchet.ts for what it is and why: a symmetric chain
/// that steps once per message, so a used key is destroyed and the past cannot
/// be reopened; and a DH ratchet that steps once per reply, so a compromise
/// heals instead of lasting forever.
///
/// Everything here is pure — a session goes in, a new session comes out,
/// nothing touches disk or the network. That is deliberate: this is the part
/// where a mistake is silent and permanent. Storage is in `E2EStore`, the
/// envelope in `Cipher`.
enum Ratchet {
    private static let domain = "yappy.ratchet.v2"

    /// Beyond this many missing messages in one chain, assume something is wrong.
    private static let maxSkip = 1000
    /// And beyond this many stored keys, stop remembering — the map is unbounded otherwise.
    private static let maxSkippedKept = 2000

    // ── shapes ───────────────────────────────────────────────────────────────

    /// A session, as it is stored: base64 and numbers, nothing else, so it
    /// survives a round trip through a file without a custom serialiser.
    struct Session: Codable {
        /// The device at the other end. One session per device, never per person.
        var deviceId: String
        var rootKey: String
        var myRatchetPrivate: String
        var myRatchetPublic: String
        /// Nil until the first message from them arrives.
        var theirRatchet: String?
        var sendChain: String?
        var recvChain: String?
        var sendCount: Int = 0
        var recvCount: Int = 0
        var previousSendCount: Int = 0
        /// Keys for messages that have not arrived yet, by `theirRatchet|n`.
        ///
        /// A message that overtakes another must still open, and the key that
        /// opens it only exists on the way past. Kept here, deleted the moment
        /// it is used — this is the one place a ratchet holds a usable key for
        /// longer than an instant, and it is bounded for that reason.
        var skipped: [String: String] = [:]
        /// The X3DH preamble, repeated on every message until they answer.
        var pending: PreKeyHeader?

        enum CodingKeys: String, CodingKey {
            case deviceId, rootKey, myRatchetPrivate, myRatchetPublic, theirRatchet
            case sendChain, recvChain, sendCount, recvCount, previousSendCount, skipped, pending
        }

        init(
            deviceId: String,
            rootKey: String,
            myRatchetPrivate: String,
            myRatchetPublic: String,
            theirRatchet: String? = nil,
            sendChain: String? = nil,
            recvChain: String? = nil,
            sendCount: Int = 0,
            recvCount: Int = 0,
            previousSendCount: Int = 0,
            skipped: [String: String] = [:],
            pending: PreKeyHeader? = nil
        ) {
            self.deviceId = deviceId
            self.rootKey = rootKey
            self.myRatchetPrivate = myRatchetPrivate
            self.myRatchetPublic = myRatchetPublic
            self.theirRatchet = theirRatchet
            self.sendChain = sendChain
            self.recvChain = recvChain
            self.sendCount = sendCount
            self.recvCount = recvCount
            self.previousSendCount = previousSendCount
            self.skipped = skipped
            self.pending = pending
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            deviceId = c.get(.deviceId, "")
            rootKey = c.get(.rootKey, "")
            myRatchetPrivate = c.get(.myRatchetPrivate, "")
            myRatchetPublic = c.get(.myRatchetPublic, "")
            theirRatchet = c.opt(.theirRatchet)
            sendChain = c.opt(.sendChain)
            recvChain = c.opt(.recvChain)
            sendCount = c.get(.sendCount, 0)
            recvCount = c.get(.recvCount, 0)
            previousSendCount = c.get(.previousSendCount, 0)
            skipped = c.get(.skipped, [:])
            pending = c.opt(.pending)
        }
    }

    /// What the first messages carry so the other end can derive the same root.
    struct PreKeyHeader: Codable {
        /// The sender's ephemeral public key, this session only.
        var ek: String
        /// Which of the recipient's prekeys it was agreed against.
        var spkId: Int
        var otkId: Int?

        enum CodingKeys: String, CodingKey { case ek, spkId, otkId }

        init(ek: String, spkId: Int, otkId: Int?) {
            self.ek = ek
            self.spkId = spkId
            self.otkId = otkId
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            ek = c.get(.ek, "")
            spkId = c.get(.spkId, 1)
            otkId = c.opt(.otkId)
        }

        /// `otkId` is written even when it is nil: the other two clients read a
        /// missing key as a parse failure rather than as "no one-time prekey".
        func encode(to encoder: Encoder) throws {
            var out = encoder.container(keyedBy: CodingKeys.self)
            try out.encode(ek, forKey: .ek)
            try out.encode(spkId, forKey: .spkId)
            try out.encode(otkId, forKey: .otkId)
        }
    }

    /// What every message carries so the ratchet can be followed.
    struct Header {
        /// The sender's current ratchet public key.
        var dh: String
        /// How long the previous sending chain was, so gaps in it can be closed.
        var pn: Int
        /// Position in the current chain.
        var n: Int
        var pre: PreKeyHeader?
    }

    /// This device's private halves, as `DeviceKeys` holds them.
    struct Privates {
        var deviceId: String
        var userId: String
        var identityPrivate: String
        var signedPreKeyId: Int
        var signedPreKeyPrivate: String
        var preKeys: [Int: String]
    }

    // ── key derivation ───────────────────────────────────────────────────────

    /// The root step: mix a fresh Diffie-Hellman into the root key and get a new
    /// root key and a new chain key out.
    ///
    /// The old root key is the salt rather than the input, which is what makes
    /// this a ratchet rather than a chain of hashes.
    private static func rootStep(_ rootKey: Data, _ dh: Data) -> (Data, Data) {
        let out = hkdf(ikm: dh, salt: rootKey, info: Data("\(domain).root".utf8), count: 64)
        return (out.prefix(32), out.suffix(32))
    }

    /// The chain step: one message key, and the chain key that replaces this one.
    ///
    /// Two different constants so the message key can never be walked forward
    /// into the chain.
    private static func chainStep(_ chainKey: Data) -> (Data, Data) {
        let key = SymmetricKey(data: chainKey)
        let messageKey = Data(HMAC<SHA256>.authenticationCode(for: Data([1]), using: key))
        let nextChain = Data(HMAC<SHA256>.authenticationCode(for: Data([2]), using: key))
        return (messageKey, nextChain)
    }

    /// A message key is a key and a nonce; neither is ever reused, so neither travels.
    private static func messageCipher(_ messageKey: Data) -> (SymmetricKey, Data) {
        // No salt, which RFC 5869 defines as HashLen zero bytes — the other two
        // clients pass nothing and get exactly this.
        let out = hkdf(
            ikm: messageKey,
            salt: Data(repeating: 0, count: 32),
            info: Data("\(domain).message".utf8),
            count: 44
        )
        return (SymmetricKey(data: out.prefix(32)), out.suffix(12))
    }

    /// The X3DH agreement, from either side. Two DHs, or one when no prekey was free.
    private static func initialRoot(_ dhSpk: Data, _ dhOtk: Data?) -> Data {
        let ikm = dhOtk.map { dhSpk + $0 } ?? dhSpk
        let salt = Data(SHA256.hash(data: Data("\(domain).salt".utf8)))
        return hkdf(ikm: ikm, salt: salt, info: Data("\(domain).x3dh".utf8), count: 32)
    }

    private static func hkdf(ikm: Data, salt: Data, info: Data, count: Int) -> Data {
        HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: ikm),
            salt: salt,
            info: info,
            outputByteCount: count
        ).withUnsafeBytes { Data($0) }
    }

    private static func agree(_ privateKey: Data, _ publicKey: Data) throws -> Data {
        let mine = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: privateKey)
        let theirs = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: publicKey)
        return try mine.sharedSecretFromKeyAgreement(with: theirs).withUnsafeBytes { Data($0) }
    }

    // ── starting a session ───────────────────────────────────────────────────

    /// Begin talking to a device that has never talked back.
    ///
    /// The recipient's signed prekey stands in as its first ratchet key. That is
    /// the whole trick behind an encrypted message to somebody whose phone is
    /// off: their half of the first DH is something they published in advance
    /// and still hold.
    static func initiate(bundle: KeyBundle) throws -> Session {
        guard let spk = Data(base64Encoded: bundle.signedPreKey.key) else {
            throw Cipher.CipherError.malformed
        }

        let ephemeral = Curve25519.KeyAgreement.PrivateKey()
        let root = try initialRoot(
            agree(ephemeral.rawRepresentation, spk),
            bundle.oneTimePreKey
                .flatMap { Data(base64Encoded: $0.key) }
                .map { try agree(ephemeral.rawRepresentation, $0) }
        )

        // The first DH ratchet step happens immediately, so the very first
        // message is already under a key neither the prekey nor the ephemeral
        // can reproduce.
        let myRatchet = Curve25519.KeyAgreement.PrivateKey()
        let (rootKey, sendChain) = try rootStep(root, agree(myRatchet.rawRepresentation, spk))

        return Session(
            deviceId: bundle.deviceId,
            rootKey: rootKey.base64EncodedString(),
            myRatchetPrivate: myRatchet.rawRepresentation.base64EncodedString(),
            myRatchetPublic: myRatchet.publicKey.rawRepresentation.base64EncodedString(),
            theirRatchet: bundle.signedPreKey.key,
            sendChain: sendChain.base64EncodedString(),
            pending: PreKeyHeader(
                ek: ephemeral.publicKey.rawRepresentation.base64EncodedString(),
                spkId: bundle.signedPreKey.id,
                otkId: bundle.oneTimePreKey?.id
            )
        )
    }

    /// Build the other side of a session from the preamble on an incoming
    /// message.
    ///
    /// Nil when this device does not hold the prekeys the sender used: a pool
    /// that has been rotated, or a message for somebody else.
    static func accept(_ pre: PreKeyHeader, me: Privates, theirDeviceId: String) -> Session? {
        guard pre.spkId == me.signedPreKeyId else { return nil }
        let otkPrivate = pre.otkId.flatMap { me.preKeys[$0] }
        if pre.otkId != nil, otkPrivate == nil { return nil }

        do {
            guard let ephemeral = Data(base64Encoded: pre.ek),
                  let spkPrivate = Data(base64Encoded: me.signedPreKeyPrivate)
            else { return nil }

            let root = try initialRoot(
                agree(spkPrivate, ephemeral),
                otkPrivate.flatMap { Data(base64Encoded: $0) }.map { try agree($0, ephemeral) }
            )

            // The signed prekey is this end's first ratchet key, matching what
            // the sender assumed. The first DH step happens when their message
            // is read.
            let key = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: spkPrivate)
            return Session(
                deviceId: theirDeviceId,
                rootKey: root.base64EncodedString(),
                myRatchetPrivate: me.signedPreKeyPrivate,
                myRatchetPublic: key.publicKey.rawRepresentation.base64EncodedString()
            )
        } catch {
            return nil
        }
    }

    // ── sending ──────────────────────────────────────────────────────────────

    struct Sealed {
        var session: Session
        var header: Header
        var ciphertext: String
    }

    /// One message, and the session that replaces this one.
    ///
    /// The session is returned rather than mutated so a failed send cannot
    /// advance the ratchet: a chain that has stepped past a message nobody
    /// received is a conversation that never recovers.
    static func encrypt(_ session: Session, _ plaintext: String, aad: Data) -> Sealed? {
        guard let chain = session.sendChain, let chainData = Data(base64Encoded: chain) else {
            return nil
        }

        let (messageKey, nextChain) = chainStep(chainData)
        let header = Header(
            dh: session.myRatchetPublic,
            pn: session.previousSendCount,
            n: session.sendCount,
            pre: session.pending
        )

        do {
            let (key, nonce) = messageCipher(messageKey)
            let box = try ChaChaPoly.seal(
                Data(plaintext.utf8),
                using: key,
                nonce: ChaChaPoly.Nonce(data: nonce),
                authenticating: aad
            )
            var next = session
            next.sendChain = nextChain.base64EncodedString()
            next.sendCount += 1
            return Sealed(
                session: next,
                header: header,
                ciphertext: (box.ciphertext + box.tag).base64EncodedString()
            )
        } catch {
            return nil
        }
    }

    // ── receiving ────────────────────────────────────────────────────────────

    /// Walk a chain forward, keeping the keys for messages that have not arrived.
    ///
    /// Messages overtake each other — a phone that was asleep, two sockets, a
    /// retry. Every key stepped over is one that opens a message still in
    /// flight, so it is kept until it is used. The cap guards against a header
    /// claiming a message number far in the future.
    private static func skipTo(_ session: Session, until: Int) -> Session? {
        guard let chain = session.recvChain, let theirs = session.theirRatchet,
              var chainData = Data(base64Encoded: chain)
        else { return session }
        if until - session.recvCount > maxSkip { return nil }

        var next = session
        var n = session.recvCount
        while n < until {
            let (messageKey, nextChain) = chainStep(chainData)
            next.skipped["\(theirs)|\(n)"] = messageKey.base64EncodedString()
            chainData = nextChain
            n += 1
        }

        // Oldest first, so what falls off the end is least likely to arrive.
        let overflow = next.skipped.count - maxSkippedKept
        if overflow > 0 {
            for key in next.skipped.keys.sorted().prefix(overflow) { next.skipped[key] = nil }
        }

        next.recvChain = chainData.base64EncodedString()
        next.recvCount = n
        return next
    }

    /// A DH ratchet step: their new key arrived, so both chains start again.
    private static func turn(_ session: Session, _ theirRatchet: String) throws -> Session {
        guard let theirKey = Data(base64Encoded: theirRatchet),
              let rootKeyData = Data(base64Encoded: session.rootKey),
              let myPrivate = Data(base64Encoded: session.myRatchetPrivate)
        else { throw Cipher.CipherError.malformed }

        let (rootAfterReceive, recvChain) = try rootStep(rootKeyData, agree(myPrivate, theirKey))

        // A new keypair of our own, so the reply travels under a secret they
        // cannot derive from anything they have seen. This is the step that
        // heals.
        let myRatchet = Curve25519.KeyAgreement.PrivateKey()
        let (rootKey, sendChain) = try rootStep(
            rootAfterReceive,
            agree(myRatchet.rawRepresentation, theirKey)
        )

        var next = session
        next.previousSendCount = session.sendCount
        next.sendCount = 0
        next.recvCount = 0
        next.theirRatchet = theirRatchet
        next.rootKey = rootKey.base64EncodedString()
        next.myRatchetPrivate = myRatchet.rawRepresentation.base64EncodedString()
        next.myRatchetPublic = myRatchet.publicKey.rawRepresentation.base64EncodedString()
        next.recvChain = recvChain.base64EncodedString()
        next.sendChain = sendChain.base64EncodedString()
        return next
    }

    struct Opened {
        var session: Session
        var plaintext: String
    }

    /// The message, and the session that replaces this one — or nil.
    ///
    /// Nil is every failure: a header from a chain this session cannot reach, a
    /// key that was already used, a tag that does not check. None of them are
    /// distinguished, and none of them advance the ratchet.
    static func decrypt(_ session: Session, _ header: Header, _ ciphertext: String, aad: Data) -> Opened? {
        guard let body = Data(base64Encoded: ciphertext), body.count > 16 else { return nil }

        func open(_ messageKey: Data) -> String? {
            do {
                let (key, nonce) = messageCipher(messageKey)
                let box = try ChaChaPoly.SealedBox(
                    nonce: ChaChaPoly.Nonce(data: nonce),
                    ciphertext: body.prefix(body.count - 16),
                    tag: body.suffix(16)
                )
                return String(data: try ChaChaPoly.open(box, using: key, authenticating: aad), encoding: .utf8)
            } catch {
                return nil
            }
        }

        // A message that arrived late, whose key was kept on the way past.
        let skippedKey = "\(header.dh)|\(header.n)"
        if let stored = session.skipped[skippedKey], let key = Data(base64Encoded: stored) {
            guard let plaintext = open(key) else { return nil }
            var next = session
            next.skipped[skippedKey] = nil
            return Opened(session: next, plaintext: plaintext)
        }

        do {
            var next = session

            // Their ratchet moved on. Close out the chain we were reading
            // first: the messages we never saw from it may still turn up.
            if header.dh != session.theirRatchet {
                guard let closed = skipTo(next, until: header.pn) else { return nil }
                next = try turn(closed, header.dh)
            }

            guard let caughtUp = skipTo(next, until: header.n),
                  let chain = caughtUp.recvChain,
                  let chainData = Data(base64Encoded: chain)
            else { return nil }

            let (messageKey, nextChain) = chainStep(chainData)
            guard let plaintext = open(messageKey) else { return nil }

            var after = caughtUp
            after.recvChain = nextChain.base64EncodedString()
            after.recvCount = caughtUp.recvCount + 1
            // They have answered, so the X3DH preamble has done its job.
            after.pending = nil
            return Opened(session: after, plaintext: plaintext)
        } catch {
            return nil
        }
    }
}
