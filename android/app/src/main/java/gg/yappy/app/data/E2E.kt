package gg.yappy.app.data

import android.content.Context
import android.util.Base64
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringSetPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import gg.yappy.app.BuildConfig
import kotlinx.coroutines.flow.first

private val Context.e2eStore: DataStore<Preferences> by preferencesDataStore(name = "yappy_e2e")

/**
 * The session layer, with a placeholder where the cipher goes.
 *
 * **Nothing here encrypts anything.** [seal] is reversible by anybody who reads
 * this file, and it is gated on a debug build so it cannot reach a release. It
 * exists because the ratchet is the small part of shipping encrypted messages:
 * the rest is one ciphertext per recipient device, what a device that was not a
 * recipient shows, what happens when somebody adds a phone mid-conversation.
 * All of that is product behaviour that has to be settled anyway, and settling
 * it against a fake cipher is far cheaper than settling it against a real one.
 *
 * The format matches the web client's exactly — prefix, then base64 of
 * `deviceId|text` — because the whole point of the exercise is that a message
 * sealed on one platform is opened on another.
 */
class E2E(private val context: Context, private val repo: YappyRepository, private val session: SessionStore) {

    private object Keys {
        val conversations = stringSetPreferencesKey("private_conversations")
    }

    /** Two locks: the build, and the per-conversation flag. */
    fun available(): Boolean = BuildConfig.DEBUG

    suspend fun isPrivate(conversationId: String): Boolean =
        available() && context.e2eStore.data.first()[Keys.conversations]?.contains(conversationId) == true

    suspend fun setPrivate(conversationId: String, on: Boolean) {
        context.e2eStore.edit {
            val current = it[Keys.conversations] ?: emptySet()
            it[Keys.conversations] = if (on) current + conversationId else current - conversationId
        }
    }

    /**
     * What a private send puts on the wire: one ciphertext per recipient device.
     *
     * Own devices included, the sending device excluded — a message sent from a
     * phone has to be readable on the tablet, and an envelope addressed to the
     * device that already holds the plaintext proves nothing.
     *
     * Null means there was nobody to encrypt to, which is not an error: the
     * caller should send in the clear rather than post something nobody can
     * read.
     */
    suspend fun sealFor(memberIds: List<String>, plaintext: String): List<Pair<String, String>>? {
        if (!available() || memberIds.isEmpty()) return null
        return try {
            val self = session.currentDeviceId()
            val bundles = repo.claimKeys(memberIds).bundles.filter { it.deviceId != self }
            if (bundles.isEmpty()) null
            else bundles.map { it.deviceId to seal(plaintext, it.deviceId) }
        } catch (_: Exception) {
            null
        }
    }

    /** NOT ENCRYPTION. Tagged with its recipient so a mis-routed copy is obvious. */
    private fun seal(plaintext: String, deviceId: String): String =
        PREFIX + Base64.encodeToString("$deviceId|$plaintext".toByteArray(), Base64.NO_WRAP)

    /**
     * The other half. Returns null when this is not ours to read — a message
     * addressed to another device, or a real ciphertext this build cannot open.
     */
    suspend fun open(ciphertext: String?): String? {
        if (ciphertext == null || !ciphertext.startsWith(PREFIX)) return null
        return try {
            val decoded = String(Base64.decode(ciphertext.removePrefix(PREFIX), Base64.NO_WRAP))
            val bar = decoded.indexOf('|')
            if (bar == -1) return null
            if (decoded.substring(0, bar) != session.currentDeviceId()) null
            else decoded.substring(bar + 1)
        } catch (_: Exception) {
            null
        }
    }

    private companion object {
        const val PREFIX = "stub.v0."
    }
}
