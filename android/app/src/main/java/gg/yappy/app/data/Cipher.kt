package gg.yappy.app.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.bouncycastle.crypto.modes.ChaCha20Poly1305
import org.bouncycastle.crypto.params.AEADParameters
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
import org.bouncycastle.crypto.params.KeyParameter
import org.bouncycastle.crypto.params.X25519PublicKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import java.util.Base64

/**
 * The envelope: what goes on the wire around a ratcheted message.
 *
 * Byte-for-byte the same as apps/webapp/src/lib/cipher.ts, which is where the
 * reasoning lives. [Ratchet] decides what the key is and destroys it
 * afterwards; this decides what travels beside the ciphertext, what is
 * authenticated, and who is allowed to have written it — the header as
 * associated data, and an Ed25519 signature over the header and the ciphertext
 * by the identity key the safety number is computed from.
 *
 * The three platforms have to agree on every byte that is hashed, signed, or
 * authenticated, which is why the field list, the separator and the domain
 * string are spelled out here rather than derived.
 * `packages/shared/vectors/e2e.json` is what keeps them honest.
 *
 * Nothing here touches the Android framework — `java.util.Base64` rather than
 * `android.util.Base64`, both present at API 26 — so the format can be tested
 * on a plain JVM. BouncyCastle rather than `javax.crypto` for the same reason
 * DeviceKeys uses it: minSdk is 26 and ChaCha20-Poly1305 arrived at 28.
 */
object Cipher {

    const val PREFIX = "yr.v2."
    private const val DOMAIN = "yappy.e2e.v2"

    /**
     * Separates header fields: a unit separator, which cannot occur in base64, a
     * uuid or a decimal number, so the joined string parses back exactly one
     * way. Without it `pn=1, n=23` and `pn=12, n=3` would authenticate the same
     * bytes.
     */
    private const val SEP = "\u001F"

    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    /** The header, before it is signed and after it is parsed. */
    @Serializable
    private data class Header(
        val v: Int,
        /** Sending device, and the account it belongs to. Both are claims until checked. */
        val s: String,
        val u: String,
        /** The one device this copy is for. */
        val r: String,
        /** The sender's current ratchet public key. */
        val d: String,
        /** The previous chain's length, and the position in this one. */
        val pn: Int,
        val n: Int,
        /** The X3DH preamble, until the other end has answered. */
        val k: Ratchet.PreKeyHeader? = null,
        val c: String,
        /** Ed25519 over everything above. */
        val g: String,
    )

    /**
     * Everything about a message except its body, in a fixed order — the AEAD's
     * associated data, and, with the ciphertext appended, what the identity key
     * signs. One field list, because a field in one and not the other is a hole.
     */
    private fun fields(
        s: String,
        u: String,
        r: String,
        d: String,
        pn: Int,
        n: Int,
        k: Ratchet.PreKeyHeader?,
    ): String = listOf(
        DOMAIN,
        "2",
        s,
        u,
        r,
        d,
        pn.toString(),
        n.toString(),
        k?.ek ?: "-",
        k?.spkId?.toString() ?: "-",
        k?.otkId?.toString() ?: "-",
    ).joinToString(SEP)

    // ── sealing ──────────────────────────────────────────────────────────────

    /**
     * Start a session with a device that has never been spoken to.
     *
     * Throws when the bundle's signed prekey is not signed by the identity key
     * it claims to come from. That signature is the only thing between a sender
     * and a prekey the server invented, so a bad one is refused rather than
     * encrypted to.
     */
    fun beginSession(bundle: KeyBundle): Ratchet.Session {
        val identityKey = unb64(bundle.identityKey)
        val spk = unb64(bundle.signedPreKey.key)
        require(verify(unb64(bundle.signedPreKey.signature), spk, identityKey)) {
            "signed prekey for device ${bundle.deviceId} does not verify"
        }
        // Rejects a low-order or malformed key before it reaches the ratchet.
        X25519PublicKeyParameters(spk, 0)
        return Ratchet.initiate(bundle)
    }

    data class Sealed(val envelope: String, val session: Ratchet.Session)

    /**
     * One sealed copy, for one device, and the session that replaces this one.
     *
     * The session is returned rather than written here: the caller holds the
     * lock on it (see [E2EStore]) and is the only thing that knows whether the
     * send survived.
     */
    fun sealWith(session: Ratchet.Session, plaintext: String, sender: Ratchet.Privates): Sealed? {
        // Where the next message will sit in the ratchet, without stepping it:
        // the header has to exist before the associated data can bind it, and
        // the associated data has to exist before the message can be encrypted.
        val aadText = fields(
            sender.deviceId,
            sender.userId,
            session.deviceId,
            session.myRatchetPublic,
            session.previousSendCount,
            session.sendCount,
            session.pending,
        )
        val sealed = Ratchet.encrypt(session, plaintext, aadText.toByteArray()) ?: return null

        val signature = b64(
            sign(unb64(sender.identityPrivate), (aadText + SEP + sealed.ciphertext).toByteArray()),
        )
        val header = Header(
            v = 2,
            s = sender.deviceId,
            u = sender.userId,
            r = session.deviceId,
            d = sealed.header.dh,
            pn = sealed.header.pn,
            n = sealed.header.n,
            k = sealed.header.pre,
            c = sealed.ciphertext,
            g = signature,
        )
        return Sealed(PREFIX + b64(json.encodeToString(header).toByteArray()), sealed.session)
    }

    // ── opening ──────────────────────────────────────────────────────────────

    private fun parse(envelope: String?): Header? {
        if (envelope == null || !envelope.startsWith(PREFIX)) return null
        return try {
            val h = json.decodeFromString<Header>(String(unb64(envelope.removePrefix(PREFIX))))
            if (h.v == 2) h else null
        } catch (_: Exception) {
            null
        }
    }

    /**
     * Who a sealed message claims to be from, so the reader knows whose identity
     * key to fetch. A claim, and treated as one: [openSealed] believes it only
     * after the signature checks out against that key.
     */
    fun sealedSender(envelope: String?): Pair<String, String>? =
        parse(envelope)?.let { it.u to it.s }

    data class Read(
        val plaintext: String,
        val session: Ratchet.Session,
        /**
         * The prekey a new session consumed, if one was built here. It has now
         * done the only job it has, and the caller must delete its private half:
         * a one-time prekey that survives its one time lets the same first
         * message be replayed into a fresh session, re-opening a message whose
         * key was meant to be spent and discarding the real session as it goes.
         */
        val consumedPreKeyId: Int?,
    )

    /**
     * The message and the session that replaces this one, or null.
     *
     * [session] may be null when this is the first message from a device: the
     * preamble on it is what builds the session, and a message carrying none is
     * one this device can no longer place.
     *
     * A null result leaves the caller's stored session untouched on purpose —
     * the ratchet must not step forward on a message that could not be read.
     */
    fun openSealed(
        envelope: String?,
        session: Ratchet.Session?,
        me: Ratchet.Privates,
        senderIdentityKey: String?,
        expectedAuthorId: String,
    ): Read? {
        val h = parse(envelope) ?: return null
        if (senderIdentityKey == null) return null

        // Addressed to this device, and from the person the server says wrote it.
        if (h.r != me.deviceId || h.u != expectedAuthorId) return null

        return try {
            val aadText = fields(h.s, h.u, h.r, h.d, h.pn, h.n, h.k)
            val aad = aadText.toByteArray()
            if (!verify(unb64(h.g), (aadText + SEP + h.c).toByteArray(), unb64(senderIdentityKey))) {
                return null
            }

            val wire = Ratchet.Header(dh = h.d, pn = h.pn, n = h.n, pre = h.k)

            // A session this device does not have yet. The preamble builds it.
            val fresh = if (session != null) null else h.k?.let { Ratchet.accept(it, me, h.s) }
            val known = session ?: fresh ?: return null

            Ratchet.decrypt(known, wire, h.c, aad)?.let {
                return Read(it.plaintext, it.session, if (fresh != null) h.k?.otkId else null)
            }

            // A stored session that cannot read a message still carrying a
            // preamble is a session built from a different one: the sender
            // reinstalled, or this device restored an older copy of itself.
            // Rebuilding from the preamble is the only way back, and it is
            // exactly what a changed safety number means.
            val preamble = h.k ?: return null
            if (session == null) return null
            val restarted = Ratchet.accept(preamble, me, h.s) ?: return null
            Ratchet.decrypt(restarted, wire, h.c, aad)
                ?.let { Read(it.plaintext, it.session, preamble.otkId) }
        } catch (_: Exception) {
            null
        }
    }

    // ── primitives ───────────────────────────────────────────────────────────

    /** Shared with [Ratchet], which owns the keys but not the cipher. */
    internal fun aead(
        key: ByteArray,
        nonce: ByteArray,
        aad: ByteArray,
        input: ByteArray,
        encrypt: Boolean,
    ): ByteArray {
        val cipher = ChaCha20Poly1305()
        cipher.init(encrypt, AEADParameters(KeyParameter(key), 128, nonce, aad))
        val out = ByteArray(cipher.getOutputSize(input.size))
        val written = cipher.processBytes(input, 0, input.size, out, 0)
        cipher.doFinal(out, written)
        return out
    }

    private fun sign(privateKey: ByteArray, message: ByteArray): ByteArray {
        val signer = Ed25519Signer()
        signer.init(true, Ed25519PrivateKeyParameters(privateKey, 0))
        signer.update(message, 0, message.size)
        return signer.generateSignature()
    }

    private fun verify(signature: ByteArray, message: ByteArray, publicKey: ByteArray): Boolean = try {
        val verifier = Ed25519Signer()
        verifier.init(false, Ed25519PublicKeyParameters(publicKey, 0))
        verifier.update(message, 0, message.size)
        verifier.verifySignature(signature)
    } catch (_: Exception) {
        false
    }

    fun b64(bytes: ByteArray): String = Base64.getEncoder().encodeToString(bytes)
    fun unb64(text: String): ByteArray = Base64.getDecoder().decode(text)
}
