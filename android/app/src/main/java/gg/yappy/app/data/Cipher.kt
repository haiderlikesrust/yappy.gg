package gg.yappy.app.data

import kotlinx.serialization.Serializable
import org.bouncycastle.crypto.digests.SHA256Digest
import org.bouncycastle.crypto.generators.HKDFBytesGenerator
import org.bouncycastle.crypto.modes.ChaCha20Poly1305
import org.bouncycastle.crypto.params.AEADParameters
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
import org.bouncycastle.crypto.params.HKDFParameters
import org.bouncycastle.crypto.params.KeyParameter
import org.bouncycastle.crypto.params.X25519PrivateKeyParameters
import org.bouncycastle.crypto.params.X25519PublicKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import kotlinx.serialization.json.Json
import kotlinx.serialization.encodeToString
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

/**
 * The cipher, byte-for-byte the same as the web client's.
 *
 * See apps/webapp/src/lib/cipher.ts for why it is built this way: an ephemeral
 * X25519 keypair per recipient device per message, agreed against that device's
 * signed prekey and — when it still has one — a one-time prekey, both fed to
 * HKDF for a message key used exactly once, ChaCha20-Poly1305 over the message
 * with the header as associated data, and an Ed25519 signature over the header
 * and the ciphertext so authorship is a cryptographic claim rather than a
 * database column.
 *
 * The two files have to agree on every byte that is hashed, signed, or
 * authenticated, which is why the field list, the separator and the salt are
 * spelled out here rather than derived. A message sealed on a laptop has to
 * open on a phone; there is no version of this where the platforms each have
 * their own idea of the format.
 *
 * BouncyCastle rather than the platform, for the same reason DeviceKeys uses
 * it: minSdk is 26 and `javax.crypto` gained ChaCha20-Poly1305 at API 28.
 *
 * Nothing here touches the Android framework — `java.util.Base64` rather than
 * `android.util.Base64`, both of which exist at API 26 — so that the format
 * can be tested on a plain JVM against vectors the web client produced. A
 * cipher that agrees with itself is not the property that matters.
 */
object Cipher {

    const val PREFIX = "yx3dh.v1."
    private const val DOMAIN = "yappy.e2e.v1"

    /**
     * Separates header fields: a unit separator, which cannot occur in base64, a
     * uuid or a decimal number, so the joined string parses back exactly one
     * way. Without it `p=1, o=23` and `p=12, o=3` would authenticate the same
     * bytes.
     */
    private const val SEP = "\u001F"

    /** A constant, so both sides derive the same thing without exchanging it. */
    private val SALT: ByteArray =
        MessageDigest.getInstance("SHA-256").digest("$DOMAIN.salt".toByteArray())

    private val random = SecureRandom()

    /** This device's private halves, as [DeviceKeys] holds them. */
    data class Privates(
        val deviceId: String,
        val userId: String,
        val identityPrivate: String,
        val signedPreKeyId: Int,
        val signedPreKeyPrivate: String,
        /** id → private key, for the one-time prekeys still held. */
        val preKeys: Map<Int, String>,
    )

    /**
     * The header, before it is signed and after it is parsed.
     *
     * The envelope JSON itself is not covered by the signature — only the
     * fields joined by [SEP] are — so the platforms are free to disagree about
     * key order, whitespace, and how they spell a null.
     */
    @Serializable
    private data class Header(
        val v: Int,
        val s: String,
        val u: String,
        val r: String,
        val e: String,
        val p: Int,
        /** Defaulted so a client that omits the key rather than writing null
         *  still parses — the two spellings mean the same thing. */
        val o: Int? = null,
        val n: String,
        val c: String,
        val g: String,
    )

    private val json = Json { ignoreUnknownKeys = true }

    /**
     * Everything about a message except its body, in a fixed order — the AEAD's
     * associated data, and, with the ciphertext appended, what gets signed. One
     * field list, because a field in one and not the other is a hole.
     */
    private fun fields(s: String, u: String, r: String, e: String, p: Int, o: Int?): String =
        listOf(DOMAIN, "1", s, u, r, e, p.toString(), o?.toString() ?: "-").joinToString(SEP)

    /**
     * The message key. Two agreements when the recipient had a one-time prekey
     * to spare, one when it did not — X3DH's documented degraded mode.
     */
    private fun messageKey(dhSpk: ByteArray, dhOtk: ByteArray?, info: ByteArray): ByteArray {
        val ikm = if (dhOtk == null) dhSpk else dhSpk + dhOtk
        val out = ByteArray(32)
        HKDFBytesGenerator(SHA256Digest()).apply {
            init(HKDFParameters(ikm, SALT, info))
            generateBytes(out, 0, out.size)
        }
        return out
    }

    private fun agree(privateKey: ByteArray, publicKey: ByteArray): ByteArray {
        val out = ByteArray(32)
        X25519PrivateKeyParameters(privateKey, 0)
            .generateSecret(X25519PublicKeyParameters(publicKey, 0), out, 0)
        return out
    }

    private fun aead(key: ByteArray, nonce: ByteArray, aad: ByteArray, input: ByteArray, encrypt: Boolean): ByteArray {
        val cipher = ChaCha20Poly1305()
        cipher.init(encrypt, AEADParameters(KeyParameter(key), 128, nonce, aad))
        val out = ByteArray(cipher.getOutputSize(input.size))
        val written = cipher.processBytes(input, 0, input.size, out, 0)
        cipher.doFinal(out, written)
        return out
    }

    // ── sealing ──────────────────────────────────────────────────────────────

    /**
     * One sealed copy, for one device.
     *
     * Throws when the bundle's signed prekey is not signed by the identity key
     * it claims to come from. That signature is the only thing between a sender
     * and a prekey the server invented, so a bad one is refused rather than
     * encrypted to.
     */
    fun sealTo(plaintext: String, bundle: KeyBundle, sender: Privates): String {
        val identityKey = unb64(bundle.identityKey)
        val spk = unb64(bundle.signedPreKey.key)
        require(verify(unb64(bundle.signedPreKey.signature), spk, identityKey)) {
            "signed prekey for device ${bundle.deviceId} does not verify"
        }

        val ephemeral = X25519PrivateKeyParameters(random)
        val dhSpk = agree(ephemeral.encoded, spk)
        val dhOtk = bundle.oneTimePreKey?.let { agree(ephemeral.encoded, unb64(it.key)) }

        val e = b64(ephemeral.generatePublicKey().encoded)
        val p = bundle.signedPreKey.id
        val o = bundle.oneTimePreKey?.id
        val nonce = ByteArray(12).also(random::nextBytes)
        val n = b64(nonce)

        val aad = fields(sender.deviceId, sender.userId, bundle.deviceId, e, p, o).toByteArray()
        val key = messageKey(dhSpk, dhOtk, aad)
        val c = b64(aead(key, nonce, aad, plaintext.toByteArray(), encrypt = true))
        val signed = (String(aad) + SEP + c).toByteArray()
        val g = b64(sign(unb64(sender.identityPrivate), signed))

        val header = Header(1, sender.deviceId, sender.userId, bundle.deviceId, e, p, o, n, c, g)
        return PREFIX + b64(json.encodeToString(header).toByteArray())
    }

    // ── opening ──────────────────────────────────────────────────────────────

    private fun parse(envelope: String?): Header? {
        if (envelope == null || !envelope.startsWith(PREFIX)) return null
        return try {
            val h = json.decodeFromString<Header>(String(unb64(envelope.removePrefix(PREFIX))))
            if (h.v == 1) h else null
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

    /**
     * The message, or null — and null is a real answer, not only an error.
     *
     * Every refusal ends the same way on purpose: a copy addressed to another
     * device, a prekey this device no longer holds, a signature from somebody
     * other than the person the server says wrote it, a tag that does not check.
     */
    fun openSealed(envelope: String?, me: Privates, senderIdentityKey: String?, expectedAuthorId: String): String? {
        val h = parse(envelope) ?: return null
        if (senderIdentityKey == null) return null

        // Addressed to this device, and from the person the server says wrote
        // it. The second check stops a sealed body being lifted off one message
        // and hung under somebody else's name.
        if (h.r != me.deviceId || h.u != expectedAuthorId) return null

        return try {
            val aad = fields(h.s, h.u, h.r, h.e, h.p, h.o).toByteArray()
            val signed = (String(aad) + SEP + h.c).toByteArray()
            if (!verify(unb64(h.g), signed, unb64(senderIdentityKey))) return null

            if (h.p != me.signedPreKeyId) return null
            val otkPrivate = h.o?.let { me.preKeys[it] }
            if (h.o != null && otkPrivate == null) return null

            val ephemeral = unb64(h.e)
            val dhSpk = agree(unb64(me.signedPreKeyPrivate), ephemeral)
            val dhOtk = otkPrivate?.let { agree(unb64(it), ephemeral) }
            val key = messageKey(dhSpk, dhOtk, aad)
            String(aead(key, unb64(h.n), aad, unb64(h.c), encrypt = false))
        } catch (_: Exception) {
            null
        }
    }

    // ── signatures ───────────────────────────────────────────────────────────

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
