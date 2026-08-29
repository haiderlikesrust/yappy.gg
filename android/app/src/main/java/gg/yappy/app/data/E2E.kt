package gg.yappy.app.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringSetPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import gg.yappy.app.BuildConfig
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

private val Context.e2eStore: DataStore<Preferences> by preferencesDataStore(name = "yappy_e2e")

/**
 * The session layer: who a message gets sealed to, and what this device can
 * open. The cipher itself is in [Cipher], and it is real — there is no
 * placeholder left anywhere in this path.
 *
 * What is still deliberately narrow: one message key per message, with no
 * ratchet chaining them, and a per-conversation switch that only exists in a
 * debug build. Everything around it was built against a fake cipher precisely
 * so that swapping in a real one would touch two functions.
 */
class E2E(
    private val context: Context,
    private val repo: YappyRepository,
    private val session: SessionStore,
    private val keys: DeviceKeys,
) {

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

    // ── the identity keys of everybody else ──────────────────────────────────

    private class DirectoryEntry(val fetchedAt: Long, val byDevice: Map<String, String>)

    private val directory = mutableMapOf<String, DirectoryEntry>()
    private val directoryLock = Mutex()

    /**
     * The identity key a device publishes, which is what its signatures are
     * checked against.
     *
     * Cached per person, and refetched when a message names a device the cache
     * has never seen — which is exactly what somebody adding a phone looks like
     * from here, and the alternative is that their first message from it is
     * permanently unreadable.
     */
    private suspend fun identityKeyOf(userId: String, deviceId: String): String? = directoryLock.withLock {
        val hit = directory[userId]
        if (hit != null && (hit.byDevice.containsKey(deviceId) ||
                System.currentTimeMillis() - hit.fetchedAt < DIRECTORY_TTL)
        ) {
            return@withLock hit.byDevice[deviceId]
        }
        try {
            val fresh = repo.userKeys(userId).devices.associate { it.deviceId to it.identityKey }
            directory[userId] = DirectoryEntry(System.currentTimeMillis(), fresh)
            fresh[deviceId]
        } catch (_: Exception) {
            null
        }
    }

    // ── sealing ──────────────────────────────────────────────────────────────

    /**
     * What a private send puts on the wire: one ciphertext per recipient device.
     *
     * Own devices included, and that now includes the device doing the sending.
     * It has the plaintext in front of it today and none of it tomorrow: there
     * is no local message store, so on the next launch the only copy of what you
     * said is the one on the server, and if nothing there is addressed to you,
     * your own messages come back unreadable.
     *
     * Null means there was nobody to encrypt to, which is not an error: the
     * caller sends in the clear rather than posting something nobody can read. A
     * device whose signed prekey does not verify is dropped on its own — that is
     * one bad device, and everybody else is still owed their copy.
     */
    suspend fun sealFor(memberIds: List<String>, plaintext: String): List<Pair<String, String>>? {
        if (!available() || memberIds.isEmpty()) return null
        return try {
            val deviceId = session.currentDeviceId() ?: return null
            val me = keys.privates(deviceId) ?: return null
            val sealed = repo.claimKeys(memberIds).bundles.mapNotNull { bundle ->
                try {
                    bundle.deviceId to Cipher.sealTo(plaintext, bundle, me)
                } catch (_: Exception) {
                    null
                }
            }
            sealed.ifEmpty { null }
        } catch (_: Exception) {
            null
        }
    }

    // ── opening ──────────────────────────────────────────────────────────────

    /**
     * What this device can read of an encrypted message.
     *
     * [authorId] is the server's word for who wrote it, and the signature has to
     * agree — a sealed body lifted from one message and hung under another name
     * fails here rather than being shown under the wrong face.
     *
     * Null covers every refusal: no keys on this device, a copy for a different
     * device, an unknown sender, a tag that does not check.
     */
    suspend fun open(ciphertext: String?, authorId: String?): String? {
        if (ciphertext == null || authorId == null) return null
        val (senderUser, senderDevice) = Cipher.sealedSender(ciphertext) ?: return null
        return try {
            val deviceId = session.currentDeviceId() ?: return null
            val me = keys.privates(deviceId) ?: return null
            Cipher.openSealed(ciphertext, me, identityKeyOf(senderUser, senderDevice), authorId)
        } catch (_: Exception) {
            null
        }
    }

    private companion object {
        /** Long enough that reading a screenful is one request per person. */
        const val DIRECTORY_TTL = 5 * 60 * 1000L
    }
}
