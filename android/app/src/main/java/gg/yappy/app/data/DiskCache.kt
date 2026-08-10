package gg.yappy.app.data

import android.content.Context
import java.io.File

/**
 * Last-known-good responses, on disk, for first paint.
 *
 * This is not a general HTTP cache and is deliberately much dumber than one: a
 * handful of named slots, each holding the raw bytes of the most recent
 * successful response for one screen's primary fetch. On launch a screen
 * decodes its slot and has something to draw in the first frame; the network
 * fetch it was already going to do then replaces both the screen and the slot.
 *
 * Raw text rather than re-encoded models, because the server's own JSON is
 * already the wire format every model knows how to read — and keeping it
 * verbatim means a cached blob survives model fields being added, exactly as a
 * live response would.
 *
 * Everything is best-effort. A failed write costs the next launch a spinner; a
 * failed read costs nothing at all. Nothing here may ever make a feature worse
 * than having no cache.
 */
object DiskCache {

    /**
     * Set once from [gg.yappy.app.AppContainer]. Null until then, which makes
     * every read a miss and every write a no-op rather than a crash — the
     * cache must never be the reason something fails.
     */
    @Volatile
    private var directory: File? = null

    fun attach(context: Context) {
        directory = File(context.applicationContext.cacheDir, "yappy-snapshots").also {
            runCatching { it.mkdirs() }
        }
    }

    /**
     * Slot names arrive as "history_<uuid>" and the like — safe already, but
     * sanitised anyway so no caller can ever aim a path at a parent directory.
     */
    private fun file(key: String): File? {
        val dir = directory ?: return null
        val safe = key.map { if (it.isLetterOrDigit() || it == '_' || it == '-') it else '_' }
            .joinToString("")
        return File(dir, "$safe.json")
    }

    fun write(text: String, key: String) {
        val target = file(key) ?: return
        runCatching {
            target.parentFile?.mkdirs()
            // Written via a temp file and renamed: a process killed mid-write
            // must not leave a slot holding half a response.
            val temp = File(target.parentFile, "${target.name}.tmp")
            temp.writeText(text)
            if (!temp.renameTo(target)) {
                temp.delete()
            }
        }
        // A cache that cannot write is just a cache that misses.
    }

    fun read(key: String): String? =
        runCatching { file(key)?.takeIf { it.exists() }?.readText() }.getOrNull()

    /**
     * Decode a slot as the envelope type its endpoint returns. A blob from an
     * older build that no longer decodes reads as a miss, not an error.
     */
    inline fun <reified T> decode(key: String): T? {
        val raw = read(key) ?: return null
        return runCatching { AppJson.decodeFromString<T>(raw) }.getOrNull()
    }

    /**
     * Sign-out. The next account on this device must not paint the previous
     * account's chats, even for one frame.
     */
    fun clear() {
        runCatching { directory?.deleteRecursively() }
        runCatching { directory?.mkdirs() }
    }

    /** Bytes currently held, for the Storage row in Settings. */
    fun sizeBytes(): Long =
        runCatching {
            directory?.walkBottomUp()?.filter { it.isFile }?.sumOf { it.length() } ?: 0L
        }.getOrDefault(0L)
}
