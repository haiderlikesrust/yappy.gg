package gg.yappy.app.data

import android.content.Context
import android.util.Base64
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.first
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.params.X25519PrivateKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import org.json.JSONObject
import java.security.SecureRandom

private val Context.keyStore: DataStore<Preferences> by preferencesDataStore(name = "yappy_keys")

/**
 * This device's cryptographic identity, published so other devices can find it.
 *
 * Nothing here encrypts a message. It is the part of end-to-end encryption that
 * cannot be added afterwards: key distribution. A device that has never
 * published an identity key cannot be handed one retroactively, so the day
 * encryption is switched on, every account older than that day would find its
 * other devices unreachable and its history unreadable. Publishing from now on
 * makes that switch a feature flag rather than a migration people experience as
 * loss.
 *
 * What a device holds:
 *
 *   • an **Ed25519 identity key**, generated once and never rotated silently —
 *     rotating it is the alarming, visible event ("safety number changed") that
 *     the verification mechanism exists to surface;
 *   • an **X25519 signed prekey**, carrying a signature from that identity, so
 *     a sender can check the prekey really came from this device;
 *   • a pool of **one-time prekeys**, each handed out exactly once. The server
 *     consumes one as it claims it; reusing one would defeat the forward
 *     secrecy they exist to provide.
 *
 * BouncyCastle rather than the platform: `java.security` gained Ed25519 and XDH
 * at API 33 and this app supports 26.
 *
 * The private halves sit in DataStore beside the tokens, which is the same
 * protection the refresh token already has — app-sandbox isolation, excluded
 * from cloud backup and device transfer. Keystore-wrapping them is the next
 * step, and it is the same next step SessionStore already documents for tokens.
 */
class DeviceKeys(private val context: Context, private val repo: YappyRepository) {

    private object Keys {
        val deviceId = stringPreferencesKey("device_id")
        val userId = stringPreferencesKey("user_id")
        val identityPrivate = stringPreferencesKey("identity_private")
        val identityPublic = stringPreferencesKey("identity_public")
        val signedPreKeyPrivate = stringPreferencesKey("spk_private")
        val signedPreKeyPublic = stringPreferencesKey("spk_public")
        val signedPreKeyId = intPreferencesKey("spk_id")
        val lastPreKeyId = intPreferencesKey("last_prekey_id")
        /** id → private key, as one JSON object. A map of sixty short strings is
         *  not worth sixty preference keys. */
        val preKeys = stringPreferencesKey("prekeys")

        /**
         * The message formats last published for this device.
         *
         * Kept so a build that has learned a new one notices and says so,
         * rather than waiting for the prekey pool to run down before anybody
         * finds out what it can read.
         */
        val advertised = stringPreferencesKey("advertised_formats")
    }

    private val random = SecureRandom()

    /**
     * Make sure this device has an identity on the server, and enough prekeys.
     *
     * Safe to call on every launch: it publishes once per device, and afterwards
     * only tops the pool up when the server says it is running low. Every
     * failure is swallowed — this is groundwork for a feature that does not
     * exist yet, and it must never be the reason somebody cannot open a chat.
     */
    suspend fun ensurePublished(deviceId: String, userId: String) {
        if (deviceId.isEmpty() || userId.isEmpty()) return
        try {
            val prefs = context.keyStore.data.first()
            val known = prefs[Keys.deviceId]

            // A different device id means a different device: the stored private
            // keys belong to a session that is gone.
            if (known != deviceId || prefs[Keys.identityPrivate] == null) {
                mintAndPublish(deviceId, userId)
                return
            }

            // An identity minted before this record carried an account id.
            // Filled in, never re-minted: /keys/publish deliberately refuses to
            // overwrite an identity key that is already out there, so a device
            // that threw its private half away would be left signing with a key
            // nobody can check.
            if (prefs[Keys.userId] != userId) {
                context.keyStore.edit { it[Keys.userId] = userId }
            }

            /**
             * A build that has learned a new message format has to say so, and
             * it cannot wait for the prekey pool to run down to do it: until
             * the directory knows, every sender assumes the oldest format in
             * circulation and this device is talked to as though it were a year
             * old.
             */
            val stale = prefs[Keys.advertised] != MessageFormats.SUPPORTED.joinToString(",")

            val available = repo.preKeyCount().availablePreKeys
            if (available >= LOW_WATER && !stale) return
            topUp(deviceId, if (available >= LOW_WATER) 0 else POOL - available)
        } catch (_: Exception) {
            // Next launch tries again.
        }
    }

    /** The safety number for this device, or null before one exists. */
    suspend fun fingerprint(): String? {
        val identity = context.keyStore.data.first()[Keys.identityPublic] ?: return null
        val digest = java.security.MessageDigest.getInstance("SHA-256")
            .digest(identity.toByteArray())
        val hex = digest.joinToString("") { "%02x".format(it) }
        // Grouped the way the server groups it, so the two can be compared.
        return hex.chunked(5).take(12).joinToString(" ")
    }

    /**
     * The private halves, for the cipher.
     *
     * Nothing else should call this. It hands out key material, and the only
     * place key material belongs is [Cipher], which is where every use of it
     * is auditable in one file. Null before this device has an identity, or
     * when the stored one belongs to a session that has since been replaced.
     */
    suspend fun privates(deviceId: String): Ratchet.Privates? {
        val prefs = context.keyStore.data.first()
        if (prefs[Keys.deviceId] != deviceId) return null
        val identity = prefs[Keys.identityPrivate] ?: return null
        val userId = prefs[Keys.userId] ?: return null
        val spk = prefs[Keys.signedPreKeyPrivate] ?: return null
        val stored = JSONObject(prefs[Keys.preKeys] ?: "{}")
        val preKeys = buildMap {
            for (key in stored.keys()) put(key.toInt(), stored.getString(key))
        }
        return Ratchet.Privates(
            deviceId = deviceId,
            userId = userId,
            identityPrivate = identity,
            signedPreKeyId = prefs[Keys.signedPreKeyId] ?: 1,
            signedPreKeyPrivate = spk,
            preKeys = preKeys,
        )
    }

    /**
     * Forget a one-time prekey, now that it has started the session it existed
     * for.
     *
     * This is what makes it one-time. While the private half is still here,
     * the first message of a session can be replayed into a brand new session
     * — which re-opens a message whose key was supposed to be spent, and
     * discards the real session as it goes.
     */
    suspend fun consumePreKey(id: Int) {
        try {
            val prefs = context.keyStore.data.first()
            val stored = JSONObject(prefs[Keys.preKeys] ?: "{}")
            if (!stored.has(id.toString())) return
            stored.remove(id.toString())
            context.keyStore.edit { it[Keys.preKeys] = stored.toString() }
        } catch (_: Exception) {
            // Next launch still has it. Worth a retry, not worth a failed message.
        }
    }

    // ── minting ──────────────────────────────────────────────────────────────

    private suspend fun mintAndPublish(deviceId: String, userId: String) {
        val identity = Ed25519PrivateKeyParameters(random)
        val signedPre = X25519PrivateKeyParameters(random)
        val identityPublic = b64(identity.generatePublicKey().encoded)
        val signedPrePublic = signedPre.generatePublicKey().encoded

        val preKeys = mutableMapOf<Int, String>()
        val published = mutableListOf<Pair<Int, String>>()
        for (id in 1..POOL) {
            val key = X25519PrivateKeyParameters(random)
            preKeys[id] = b64(key.encoded)
            published += id to b64(key.generatePublicKey().encoded)
        }

        context.keyStore.edit {
            it[Keys.deviceId] = deviceId
            it[Keys.userId] = userId
            it[Keys.identityPrivate] = b64(identity.encoded)
            it[Keys.identityPublic] = identityPublic
            it[Keys.signedPreKeyPrivate] = b64(signedPre.encoded)
            it[Keys.signedPreKeyPublic] = b64(signedPrePublic)
            it[Keys.signedPreKeyId] = 1
            it[Keys.lastPreKeyId] = POOL
            it[Keys.preKeys] = JSONObject(preKeys as Map<*, *>).toString()
            it[Keys.advertised] = MessageFormats.SUPPORTED.joinToString(",")
        }

        repo.publishKeys(
            deviceId = deviceId,
            identityKey = identityPublic,
            signedPreKeyId = 1,
            signedPreKey = b64(signedPrePublic),
            signature = b64(sign(identity, signedPrePublic)),
            oneTimePreKeys = published,
            formats = MessageFormats.SUPPORTED,
            formatsSignature = advertisement(identity),
        )
    }

    private suspend fun topUp(deviceId: String, count: Int) {
        val prefs = context.keyStore.data.first()
        val identity = Ed25519PrivateKeyParameters(unb64(prefs[Keys.identityPrivate]!!), 0)
        val signedPrePublic = unb64(prefs[Keys.signedPreKeyPublic]!!)
        val existing = JSONObject(prefs[Keys.preKeys] ?: "{}")
        val from = prefs[Keys.lastPreKeyId] ?: 0

        val published = mutableListOf<Pair<Int, String>>()
        for (i in 1..count.coerceAtLeast(0)) {
            val id = from + i
            val key = X25519PrivateKeyParameters(random)
            existing.put(id.toString(), b64(key.encoded))
            published += id to b64(key.generatePublicKey().encoded)
        }

        context.keyStore.edit {
            it[Keys.lastPreKeyId] = from + count.coerceAtLeast(0)
            it[Keys.preKeys] = existing.toString()
            it[Keys.advertised] = MessageFormats.SUPPORTED.joinToString(",")
        }

        repo.publishKeys(
            deviceId = deviceId,
            identityKey = prefs[Keys.identityPublic]!!,
            signedPreKeyId = prefs[Keys.signedPreKeyId] ?: 1,
            signedPreKey = prefs[Keys.signedPreKeyPublic]!!,
            signature = b64(sign(identity, signedPrePublic)),
            oneTimePreKeys = published,
            formats = MessageFormats.SUPPORTED,
            formatsSignature = advertisement(identity),
        )
    }

    /**
     * What this device can read, signed so the server cannot shrink the list.
     *
     * A server that wanted every sender to use the weakest format available
     * would only have to say that is all anybody speaks. This signature makes
     * that a forgery rather than a policy — see [MessageFormats].
     */
    private fun advertisement(identity: Ed25519PrivateKeyParameters): String =
        b64(sign(identity, MessageFormats.advertisement(MessageFormats.SUPPORTED).toByteArray()))

    private fun sign(identity: Ed25519PrivateKeyParameters, message: ByteArray): ByteArray {
        val signer = Ed25519Signer()
        signer.init(true, identity)
        signer.update(message, 0, message.size)
        return signer.generateSignature()
    }

    private fun b64(bytes: ByteArray): String = Base64.encodeToString(bytes, Base64.NO_WRAP)
    private fun unb64(text: String): ByteArray = Base64.decode(text, Base64.NO_WRAP)

    private companion object {
        /** Below this many unclaimed prekeys, top the pool back up. */
        const val LOW_WATER = 20
        const val POOL = 60
    }
}
