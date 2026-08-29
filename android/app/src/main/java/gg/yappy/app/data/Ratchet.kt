package gg.yappy.app.data

import kotlinx.serialization.Serializable
import org.bouncycastle.crypto.digests.SHA256Digest
import org.bouncycastle.crypto.generators.HKDFBytesGenerator
import org.bouncycastle.crypto.macs.HMac
import org.bouncycastle.crypto.params.HKDFParameters
import org.bouncycastle.crypto.params.KeyParameter
import org.bouncycastle.crypto.params.X25519PrivateKeyParameters
import org.bouncycastle.crypto.params.X25519PublicKeyParameters
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

/**
 * The Double Ratchet, byte-for-byte the same as the web client's.
 *
 * See apps/webapp/src/lib/ratchet.ts for what it is and why: a symmetric chain
 * that steps once per message, so a used key is destroyed and the past cannot
 * be reopened; and a DH ratchet that steps once per reply, so a compromise
 * heals instead of lasting forever.
 *
 * Everything here is pure — a session goes in, a new session comes out, nothing
 * touches disk or the network. That is deliberate: this is the part where a
 * mistake is silent and permanent, so it is the part that has to be testable
 * off a device. Storage is in [E2EStore], the envelope in [Cipher].
 */
object Ratchet {

    private const val DOMAIN = "yappy.ratchet.v2"

    /** Beyond this many missing messages in one chain, assume something is wrong. */
    private const val MAX_SKIP = 1000

    /** And beyond this many stored keys, stop remembering — the map is unbounded otherwise. */
    private const val MAX_SKIPPED_KEPT = 2000

    private val random = SecureRandom()

    // ── shapes ───────────────────────────────────────────────────────────────

    /**
     * A session, as it is stored: base64 and numbers, nothing else, so it
     * survives a round trip through a file without a custom serialiser.
     */
    @Serializable
    data class Session(
        /** The device at the other end. One session per device, never per person. */
        val deviceId: String,
        val rootKey: String,
        val myRatchetPrivate: String,
        val myRatchetPublic: String,
        /** Null until the first message from them arrives. */
        val theirRatchet: String? = null,
        val sendChain: String? = null,
        val recvChain: String? = null,
        val sendCount: Int = 0,
        val recvCount: Int = 0,
        val previousSendCount: Int = 0,
        /**
         * Keys for messages that have not arrived yet, by `${theirRatchet}|${n}`.
         *
         * A message that overtakes another must still open, and the key that
         * opens it only exists on the way past. Kept here, deleted the moment it
         * is used — this map is the one place a ratchet holds a usable key for
         * longer than an instant, and it is bounded for that reason.
         */
        val skipped: Map<String, String> = emptyMap(),
        /**
         * The X3DH preamble, repeated on every message until they answer.
         *
         * A conversation begins with one side talking to a prekey bundle. Until
         * a reply proves the other end built the same session, every message has
         * to carry enough to build it — otherwise losing the first message
         * strands the conversation permanently.
         */
        val pending: PreKeyHeader? = null,
    )

    /** What the first messages carry so the other end can derive the same root. */
    @Serializable
    data class PreKeyHeader(
        /** The sender's ephemeral public key, this session only. */
        val ek: String,
        /** Which of the recipient's prekeys it was agreed against. */
        val spkId: Int,
        val otkId: Int? = null,
    )

    /** What every message carries so the ratchet can be followed. */
    data class Header(
        /** The sender's current ratchet public key. */
        val dh: String,
        /** How long the previous sending chain was, so gaps in it can be closed. */
        val pn: Int,
        /** Position in the current chain. */
        val n: Int,
        val pre: PreKeyHeader?,
    )

    // ── key derivation ───────────────────────────────────────────────────────

    /**
     * The root step: mix a fresh Diffie-Hellman into the root key and get a new
     * root key and a new chain key out.
     *
     * The old root key is the salt rather than the input, which is what makes
     * this a ratchet rather than a chain of hashes: an attacker who learns the
     * DH output still needs the root, and one who learns the root still needs
     * the DH.
     */
    private fun rootStep(rootKey: ByteArray, dh: ByteArray): Pair<ByteArray, ByteArray> {
        val out = hkdf(dh, rootKey, "$DOMAIN.root".toByteArray(), 64)
        return out.copyOfRange(0, 32) to out.copyOfRange(32, 64)
    }

    /**
     * The chain step: one message key, and the chain key that replaces this one.
     *
     * Two different constants so the message key can never be walked forward
     * into the chain — knowing a message key must say nothing about the next.
     */
    private fun chainStep(chainKey: ByteArray): Pair<ByteArray, ByteArray> =
        hmac(chainKey, byteArrayOf(1)) to hmac(chainKey, byteArrayOf(2))

    /** A message key is a key and a nonce; neither is ever reused, so neither travels. */
    private fun messageCipher(messageKey: ByteArray): Pair<ByteArray, ByteArray> {
        val out = hkdf(messageKey, null, "$DOMAIN.message".toByteArray(), 44)
        return out.copyOfRange(0, 32) to out.copyOfRange(32, 44)
    }

    /** The X3DH agreement, from either side. Two DHs, or one when no prekey was free. */
    private fun initialRoot(dhSpk: ByteArray, dhOtk: ByteArray?): ByteArray {
        val ikm = if (dhOtk == null) dhSpk else dhSpk + dhOtk
        val salt = MessageDigest.getInstance("SHA-256").digest("$DOMAIN.salt".toByteArray())
        return hkdf(ikm, salt, "$DOMAIN.x3dh".toByteArray(), 32)
    }

    // ── starting a session ───────────────────────────────────────────────────

    /**
     * Begin talking to a device that has never talked back.
     *
     * The recipient's signed prekey stands in as its first ratchet key. That is
     * the whole trick behind an encrypted message to somebody whose phone is
     * off: their half of the first DH is something they published in advance
     * and still hold.
     */
    fun initiate(bundle: KeyBundle): Session {
        val ephemeral = X25519PrivateKeyParameters(random)
        val spk = unb64(bundle.signedPreKey.key)

        val root = initialRoot(
            agree(ephemeral.encoded, spk),
            bundle.oneTimePreKey?.let { agree(ephemeral.encoded, unb64(it.key)) },
        )

        // The first DH ratchet step happens immediately, so the very first
        // message is already under a key neither the prekey nor the ephemeral
        // can reproduce.
        val myRatchet = X25519PrivateKeyParameters(random)
        val (rootKey, sendChain) = rootStep(root, agree(myRatchet.encoded, spk))

        return Session(
            deviceId = bundle.deviceId,
            rootKey = b64(rootKey),
            myRatchetPrivate = b64(myRatchet.encoded),
            myRatchetPublic = b64(myRatchet.generatePublicKey().encoded),
            theirRatchet = bundle.signedPreKey.key,
            sendChain = b64(sendChain),
            pending = PreKeyHeader(
                ek = b64(ephemeral.generatePublicKey().encoded),
                spkId = bundle.signedPreKey.id,
                otkId = bundle.oneTimePreKey?.id,
            ),
        )
    }

    /** The receiving device's private halves, as [DeviceKeys] holds them. */
    data class Privates(
        val deviceId: String,
        val userId: String,
        val identityPrivate: String,
        val signedPreKeyId: Int,
        val signedPreKeyPrivate: String,
        val preKeys: Map<Int, String>,
    )

    /**
     * Build the other side of a session from the preamble on an incoming message.
     *
     * Null when this device does not hold the prekeys the sender used: a pool
     * that has been rotated, or a message for somebody else. The caller shows
     * the unreadable state, which is the honest answer.
     */
    fun accept(pre: PreKeyHeader, me: Privates, theirDeviceId: String): Session? {
        if (pre.spkId != me.signedPreKeyId) return null
        val otkPrivate = pre.otkId?.let { me.preKeys[it] }
        if (pre.otkId != null && otkPrivate == null) return null

        return try {
            val ephemeral = unb64(pre.ek)
            val root = initialRoot(
                agree(unb64(me.signedPreKeyPrivate), ephemeral),
                otkPrivate?.let { agree(unb64(it), ephemeral) },
            )

            // The signed prekey is this end's first ratchet key, matching what
            // the sender assumed. The first DH step happens when their message
            // is read.
            val spkPrivate = X25519PrivateKeyParameters(unb64(me.signedPreKeyPrivate), 0)
            Session(
                deviceId = theirDeviceId,
                rootKey = b64(root),
                myRatchetPrivate = me.signedPreKeyPrivate,
                myRatchetPublic = b64(spkPrivate.generatePublicKey().encoded),
            )
        } catch (_: Exception) {
            null
        }
    }

    // ── sending ──────────────────────────────────────────────────────────────

    /** One message, and the session that replaces this one. */
    data class Sealed(val session: Session, val header: Header, val ciphertext: String)

    /**
     * The session is returned rather than mutated so a failed send cannot
     * advance the ratchet: a chain that has stepped past a message nobody
     * received is a conversation that never recovers.
     */
    fun encrypt(session: Session, plaintext: String, aad: ByteArray): Sealed? {
        val chain = session.sendChain ?: return null
        val (messageKey, nextChain) = chainStep(unb64(chain))
        val header = Header(
            dh = session.myRatchetPublic,
            pn = session.previousSendCount,
            n = session.sendCount,
            pre = session.pending,
        )
        val (key, nonce) = messageCipher(messageKey)
        val ciphertext = b64(Cipher.aead(key, nonce, aad, plaintext.toByteArray(), encrypt = true))

        return Sealed(
            session = session.copy(sendChain = b64(nextChain), sendCount = session.sendCount + 1),
            header = header,
            ciphertext = ciphertext,
        )
    }

    // ── receiving ────────────────────────────────────────────────────────────

    /**
     * Walk a chain forward, keeping the keys for messages that have not arrived.
     *
     * Messages overtake each other — a phone that was asleep, two sockets, a
     * retry. Every key stepped over is one that opens a message still in flight,
     * so it is kept until it is used. The cap guards against a header claiming a
     * message number far in the future, which would otherwise be an invitation
     * to derive keys until the process dies.
     */
    private fun skipTo(session: Session, until: Int): Session? {
        val chainKey = session.recvChain ?: return session
        val theirs = session.theirRatchet ?: return session
        if (until - session.recvCount > MAX_SKIP) return null

        val skipped = session.skipped.toMutableMap()
        var chain = unb64(chainKey)
        var n = session.recvCount

        while (n < until) {
            val (messageKey, nextChain) = chainStep(chain)
            skipped["$theirs|$n"] = b64(messageKey)
            chain = nextChain
            n += 1
        }

        // Oldest first, so what falls off the end is least likely to arrive.
        val overflow = skipped.size - MAX_SKIPPED_KEPT
        if (overflow > 0) skipped.keys.take(overflow).forEach { skipped.remove(it) }

        return session.copy(skipped = skipped, recvChain = b64(chain), recvCount = n)
    }

    /** A DH ratchet step: their new key arrived, so both chains start again. */
    private fun turn(session: Session, theirRatchet: String): Session {
        val theirKey = unb64(theirRatchet)
        val (rootAfterReceive, recvChain) =
            rootStep(unb64(session.rootKey), agree(unb64(session.myRatchetPrivate), theirKey))

        // A new keypair of our own, so the reply travels under a secret they
        // cannot derive from anything they have seen. This is the step that
        // heals.
        val myRatchet = X25519PrivateKeyParameters(random)
        val (rootKey, sendChain) = rootStep(rootAfterReceive, agree(myRatchet.encoded, theirKey))

        return session.copy(
            previousSendCount = session.sendCount,
            sendCount = 0,
            recvCount = 0,
            theirRatchet = theirRatchet,
            rootKey = b64(rootKey),
            myRatchetPrivate = b64(myRatchet.encoded),
            myRatchetPublic = b64(myRatchet.generatePublicKey().encoded),
            recvChain = b64(recvChain),
            sendChain = b64(sendChain),
        )
    }

    data class Opened(val session: Session, val plaintext: String)

    /**
     * The message, and the session that replaces this one — or null.
     *
     * Null is every failure: a header from a chain this session cannot reach, a
     * key that was already used, a tag that does not check. None of them are
     * distinguished, and none of them advance the ratchet, so a message that
     * cannot be opened costs nothing but itself.
     */
    fun decrypt(session: Session, header: Header, ciphertext: String, aad: ByteArray): Opened? {
        fun open(messageKey: ByteArray): String? = try {
            val (key, nonce) = messageCipher(messageKey)
            String(Cipher.aead(key, nonce, aad, unb64(ciphertext), encrypt = false))
        } catch (_: Exception) {
            null
        }

        // A message that arrived late, whose key was kept on the way past.
        val skippedKey = "${header.dh}|${header.n}"
        session.skipped[skippedKey]?.let { stored ->
            val plaintext = open(unb64(stored)) ?: return null
            return Opened(session.copy(skipped = session.skipped - skippedKey), plaintext)
        }

        return try {
            var next = session

            // Their ratchet moved on. Close out the chain we were reading
            // first: the messages we never saw from it may still turn up.
            if (header.dh != session.theirRatchet) {
                val closed = skipTo(next, header.pn) ?: return null
                next = turn(closed, header.dh)
            }

            val caughtUp = skipTo(next, header.n) ?: return null
            val chain = caughtUp.recvChain ?: return null

            val (messageKey, nextChain) = chainStep(unb64(chain))
            val plaintext = open(messageKey) ?: return null

            Opened(
                caughtUp.copy(
                    recvChain = b64(nextChain),
                    recvCount = caughtUp.recvCount + 1,
                    // They have answered, so the X3DH preamble has done its job.
                    pending = null,
                ),
                plaintext,
            )
        } catch (_: Exception) {
            null
        }
    }

    // ── primitives ───────────────────────────────────────────────────────────

    private fun hkdf(ikm: ByteArray, salt: ByteArray?, info: ByteArray, length: Int): ByteArray {
        val out = ByteArray(length)
        HKDFBytesGenerator(SHA256Digest()).apply {
            init(HKDFParameters(ikm, salt, info))
            generateBytes(out, 0, length)
        }
        return out
    }

    private fun hmac(key: ByteArray, message: ByteArray): ByteArray {
        val mac = HMac(SHA256Digest())
        mac.init(KeyParameter(key))
        mac.update(message, 0, message.size)
        return ByteArray(mac.macSize).also { mac.doFinal(it, 0) }
    }

    private fun agree(privateKey: ByteArray, publicKey: ByteArray): ByteArray {
        val out = ByteArray(32)
        X25519PrivateKeyParameters(privateKey, 0)
            .generateSecret(X25519PublicKeyParameters(publicKey, 0), out, 0)
        return out
    }

    private fun b64(bytes: ByteArray): String = Base64.getEncoder().encodeToString(bytes)
    private fun unb64(text: String): ByteArray = Base64.getDecoder().decode(text)
}
