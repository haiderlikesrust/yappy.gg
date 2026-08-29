package gg.yappy.app.data

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import java.io.File

/**
 * Where ratchet sessions and opened messages live on this device.
 *
 * Two things, one file each, under `filesDir` rather than `cacheDir` — the
 * system empties the cache whenever it likes, and either of these disappearing
 * means a conversation that can no longer be read. That is also why this is not
 * DataStore: a preferences file is loaded whole into memory on every access,
 * and the message store grows for as long as the account exists.
 *
 * **Sessions** are a position in two chains. Two sends that both read one and
 * both write it back leave one of them stepped over: the same message number
 * used twice, and every message after it unreadable at the other end. Nothing
 * about that failure is loud — it looks like the network, until the whole
 * conversation is broken. So every read-modify-write of one device's session
 * goes through [withSession], which serialises them per device while leaving
 * different devices free to run at once.
 *
 * **Opened messages** are not a cache. A ratchet destroys a message key as it
 * uses it, so a ciphertext opens exactly once on this device, ever. What is
 * written here is the only copy that survives a restart — kept in the clear on
 * purpose, because encrypting it would need a key stored beside it, in the same
 * sandbox, readable by the same process.
 */
class E2EStore(context: Context) {

    private val root = File(context.applicationContext.filesDir, "yappy-e2e")
    private val sessionDir = File(root, "sessions")
    private val plaintextDir = File(root, "plaintext")

    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    /** One lock per device, so its session is only ever held by one caller. */
    private val locks = mutableMapOf<String, Mutex>()
    private val locksGuard = Mutex()

    private suspend fun lockFor(deviceId: String): Mutex = locksGuard.withLock {
        locks.getOrPut(deviceId) { Mutex() }
    }

    /** Ids arrive as uuids, but nothing may ever aim a path at a parent directory. */
    private fun safe(name: String): String =
        name.map { if (it.isLetterOrDigit() || it == '-' || it == '_') it else '_' }.joinToString("")

    // ── sessions ─────────────────────────────────────────────────────────────

    suspend fun loadSession(deviceId: String): Ratchet.Session? = withContext(Dispatchers.IO) {
        try {
            val file = File(sessionDir, "${safe(deviceId)}.json")
            if (!file.exists()) null else json.decodeFromString<Ratchet.Session>(file.readText())
        } catch (_: Exception) {
            null
        }
    }

    private suspend fun saveSession(session: Ratchet.Session) = withContext(Dispatchers.IO) {
        try {
            sessionDir.mkdirs()
            File(sessionDir, "${safe(session.deviceId)}.json").writeText(json.encodeToString(Ratchet.Session.serializer(), session))
        } catch (_: Exception) {
            // The message still went. The next one starts a new session, which
            // the other end handles: that is what the preamble is for.
        }
    }

    /**
     * Hold one device's session for the length of an operation.
     *
     * The block is handed whatever is stored — null when this device has never
     * been spoken to — and returns the session to store along with whatever the
     * caller wanted. Returning a null session leaves what was there alone, which
     * is what a failed decrypt must do: a ratchet that advances on a message
     * nobody could read has lost its place.
     */
    suspend fun <T> withSession(
        deviceId: String,
        block: suspend (Ratchet.Session?) -> Pair<Ratchet.Session?, T>,
    ): T = lockFor(deviceId).withLock {
        val (session, result) = block(loadSession(deviceId))
        if (session != null) saveSession(session)
        result
    }

    // ── what messages said ───────────────────────────────────────────────────

    suspend fun remember(messageId: String, plaintext: String) = withContext(Dispatchers.IO) {
        try {
            plaintextDir.mkdirs()
            File(plaintextDir, "${safe(messageId)}.txt").writeText(plaintext)
        } catch (_: Exception) {
            // It displays this time and is unreadable after a restart, which is
            // bad — but losing it now would be worse.
        }
    }

    suspend fun recall(messageId: String): String? = withContext(Dispatchers.IO) {
        try {
            val file = File(plaintextDir, "${safe(messageId)}.txt")
            if (file.exists()) file.readText() else null
        } catch (_: Exception) {
            null
        }
    }

    /** A deleted message leaves nothing behind here either. */
    suspend fun forget(messageId: String) = withContext(Dispatchers.IO) {
        try {
            File(plaintextDir, "${safe(messageId)}.txt").delete()
        } catch (_: Exception) {
            // Nothing to be done.
        }
        Unit
    }
}
