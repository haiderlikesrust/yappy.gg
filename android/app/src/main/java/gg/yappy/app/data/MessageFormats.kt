package gg.yappy.app.data

/**
 * Which message format two devices use to talk to each other.
 *
 * A mirror of packages/shared/src/e2eFormats.ts, which is where the reasoning
 * lives and which is the file to change first. Every byte that gets signed has
 * to be identical on all three platforms, so [advertisement] is spelled out
 * here rather than assembled from whatever is convenient in Kotlin.
 *
 * The short version: a sealed message is written in a format, and a device that
 * does not know that format cannot read it. Guessing wrong is not a retryable
 * error — the ratchet destroys keys as it uses them — so each device advertises
 * what it speaks and a sender picks the newest both ends know. The
 * advertisement is signed by the identity key because otherwise a server could
 * simply claim everybody speaks the weakest thing available and watch every
 * sender downgrade.
 */
object MessageFormats {

    /** Every format this build can read and write, oldest first. */
    val SUPPORTED = listOf(2)

    /** The newest this build knows, which is what it advertises as its ceiling. */
    val NEWEST = SUPPORTED.last()

    /**
     * What to assume about a device that has published no advertisement.
     *
     * Every device in the directory today published from a build that speaks
     * exactly this, so the assumption is currently the truth rather than a
     * guess. It stays correct as long as this is the oldest format still in
     * circulation — the thing to check before retiring one.
     */
    val OLDEST = SUPPORTED.first()

    /**
     * The bytes a device signs to prove which formats it speaks.
     *
     * Sorted and comma-joined, so the same set is the same string everywhere.
     * Only digits and commas follow the prefix, so nothing needs escaping.
     */
    fun advertisement(versions: List<Int>): String =
        "yappy.formats.v1:" + versions.distinct().sorted().joinToString(",")

    /**
     * The newest format both ends can read, or null when there is no overlap.
     *
     * Null is a real answer: a device too old to understand anything this one
     * can write gets no copy of the message, which is better than a copy that
     * arrives as an unreadable blob.
     */
    fun choose(mine: List<Int>, theirs: List<Int>): Int? =
        mine.filter { it in theirs }.maxOrNull()

    /** Parse an advertisement as stored: "2" or "2,3". Junk reads as nothing. */
    fun parse(stored: String?): List<Int> =
        stored?.split(',')?.mapNotNull { it.trim().toIntOrNull() }?.filter { it in 1..999 } ?: emptyList()
}
