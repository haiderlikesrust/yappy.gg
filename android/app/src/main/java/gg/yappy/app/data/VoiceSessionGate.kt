package gg.yappy.app.data

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** Serialize server seats, but invalidate a pending join immediately on leave. */
internal class VoiceSessionGate {
    private val mutex = Mutex()
    private var revision = 0L

    fun invalidate(): Long = ++revision
    fun isCurrent(ticket: Long): Boolean = revision == ticket

    suspend fun <T> serialized(block: suspend () -> T): T = mutex.withLock { block() }
}
