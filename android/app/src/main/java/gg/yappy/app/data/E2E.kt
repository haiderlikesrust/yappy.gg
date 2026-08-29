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
 * The session layer: who a message gets sealed to, what this device can open,
 * and where the answer is kept.
 *
 * The envelope is in [Cipher] and the ratchet under it in [Ratchet]. What lives
 * here is everything that has to touch the network or the disk: claiming the
 * prekeys that start a session, fetching the identity key a signature is
 * checked against, and writing down what a message said — because with a
 * ratchet, that is the only copy that survives.
 */
class E2E(
    private val context: Context,
    private val repo: YappyRepository,
    private val session: SessionStore,
    private val keys: DeviceKeys,
    private val store: E2EStore,
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

    // ── the devices of everybody else ────────────────────────────────────────

    private class DirectoryEntry(val fetchedAt: Long, val byDevice: Map<String, String>)

    private val directory = mutableMapOf<String, DirectoryEntry>()
    private val directoryLock = Mutex()

    /**
     * Everything the directory says about one person's devices.
     *
     * Refetched when a message names a device the cache has never seen — that is
     * exactly what somebody adding a phone looks like from here, and the
     * alternative is that their first message from it is permanently unreadable.
     */
    private suspend fun devicesOf(userId: String, wanted: String? = null): Map<String, String> =
        directoryLock.withLock {
            val hit = directory[userId]
            val fresh = hit != null && System.currentTimeMillis() - hit.fetchedAt < DIRECTORY_TTL
            if (hit != null && fresh && (wanted == null || hit.byDevice.containsKey(wanted))) {
                return@withLock hit.byDevice
            }
            try {
                val devices = repo.userKeys(userId).devices.associate { it.deviceId to it.identityKey }
                directory[userId] = DirectoryEntry(System.currentTimeMillis(), devices)
                devices
            } catch (_: Exception) {
                hit?.byDevice ?: emptyMap()
            }
        }

    /** The identity key a device publishes, which is what its signatures are checked against. */
    private suspend fun identityKeyOf(userId: String, deviceId: String): String? =
        devicesOf(userId, deviceId)[deviceId]

    // ── sealing ──────────────────────────────────────────────────────────────

    /**
     * What a private send puts on the wire: one ciphertext per recipient device,
     * each under its own ratchet.
     *
     * Own devices included — a message sent from a phone has to be readable on
     * the tablet — but not the device doing the sending, which cannot hold a
     * ratchet session with itself and writes down what it said instead.
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

            val targets = memberIds
                .flatMap { devicesOf(it).keys }
                .filter { it != deviceId }
            if (targets.isEmpty()) return null

            // A claim spends a one-time prekey from every device it returns, so
            // it asks only about the ones with no session yet. A conversation
            // that has been running a while claims nothing at all.
            val strangers = targets.filter { store.loadSession(it) == null }
            val bundles = if (strangers.isEmpty()) {
                emptyMap()
            } else {
                repo.claimKeys(memberIds, strangers).bundles.associateBy { it.deviceId }
            }

            val envelopes = mutableListOf<Pair<String, String>>()
            for (target in targets) {
                val envelope = store.withSession(target) { existing ->
                    val start = existing ?: bundles[target]?.let {
                        runCatching { Cipher.beginSession(it) }.getOrNull()
                    }
                    if (start == null) {
                        null to null
                    } else {
                        val sealed = Cipher.sealWith(start, plaintext, me)
                        sealed?.session to sealed?.envelope
                    }
                }
                if (envelope != null) envelopes += target to envelope
            }

            envelopes.ifEmpty { null }
        } catch (_: Exception) {
            null
        }
    }

    // ── opening ──────────────────────────────────────────────────────────────

    /**
     * What this device can read of an encrypted message.
     *
     * Asked of the local store first, and that is not an optimisation: a ratchet
     * destroys a message key as it uses it, so a ciphertext opens exactly once
     * on this device, ever. What was written down the first time is the only
     * copy that survives a restart.
     *
     * [authorId] is the server's word for who wrote it, and the signature has to
     * agree — a sealed body lifted from one message and hung under another name
     * fails here rather than being shown under the wrong face.
     */
    suspend fun open(messageId: String, ciphertext: String?, authorId: String?): String? {
        store.recall(messageId)?.let { return it }
        if (ciphertext == null || authorId == null) return null

        val claim = Cipher.sealedSender(ciphertext) ?: return null
        val (senderUser, senderDevice) = claim
        if (senderUser != authorId) return null

        return try {
            val deviceId = session.currentDeviceId() ?: return null
            val me = keys.privates(deviceId) ?: return null
            val senderKey = identityKeyOf(senderUser, senderDevice) ?: return null

            val read = store.withSession(senderDevice) { existing ->
                val result = Cipher.openSealed(ciphertext, existing, me, senderKey, authorId)
                result?.session to result
            } ?: return null

            // Written down before anything else. A message that displays once
            // and is blank after a restart is worse than one that never showed.
            store.remember(messageId, read.plaintext)

            // And only then is the prekey that started this session spent. In
            // the other order, a crash between the two would leave a message
            // nobody can ever read.
            read.consumedPreKeyId?.let { keys.consumePreKey(it) }
            read.plaintext
        } catch (_: Exception) {
            null
        }
    }

    /** A sender knows what it said; it should not have to open its own copy to prove it. */
    suspend fun rememberOwn(messageId: String, plaintext: String) = store.remember(messageId, plaintext)

    /** A deleted message leaves nothing readable behind on this device either. */
    suspend fun forget(messageId: String) = store.forget(messageId)

    private companion object {
        /** Long enough that reading a screenful is one request per person. */
        const val DIRECTORY_TTL = 5 * 60 * 1000L
    }
}
