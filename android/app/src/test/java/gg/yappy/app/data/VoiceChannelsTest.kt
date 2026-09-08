package gg.yappy.app.data

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.Assert.*
import org.junit.Test

class VoiceChannelsTest {
    private class FakeMedia : VoiceMedia {
        override val media = MutableStateFlow(CallMedia())
        var connectWait: CompletableDeferred<Unit>? = null
        var fail = false
        var connects = 0
        var speaker = true
        override suspend fun connect(scope: CoroutineScope, url: String, token: String, publishAudio: Boolean, owner: String?) {
            connects++
            media.value = CallMedia(state = MediaState.Connecting, owner = owner)
            connectWait?.await()
            media.value = CallMedia(state = if (fail) MediaState.Failed else MediaState.Connected, micEnabled = publishAudio, owner = owner)
            speaker = true
        }
        override suspend fun setMicEnabled(enabled: Boolean) { media.value = media.value.copy(micEnabled = enabled) }
        override fun setSpeakerphone(on: Boolean) { speaker = on }
        override fun close(owner: String?) {
            if (owner == null || media.value.owner == null || media.value.owner == owner) media.value = CallMedia(state = MediaState.Disconnected)
        }
    }

    private class Fixture {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val media = FakeMedia()
        val requests = mutableListOf<String>()
        var joinWait: CompletableDeferred<Unit>? = null
        var allowed = true
        var service = false
        val roster = mutableListOf<Pair<String, Boolean>>()
        val voice = VoiceChannels(
            joinRoom = { id, _ -> requests.add("join:$id"); joinWait?.await(); VoiceJoinEnvelope("token", "wss://voice.test") },
            leaveRoom = { id -> requests.add("leave:$id") },
            updateRoom = { id, muted -> roster.add(id to muted) },
            engine = media, scope = scope,
            startService = { service = true }, stopService = { service = false }, micAllowed = { allowed },
        )
        fun close() { scope.cancel() }
    }

    @Test fun `failed media join removes seat and notification and can retry`() = runBlocking {
        val f = Fixture()
        try {
            f.media.fail = true
            f.voice.join("a", "space", "Room A")
            assertNull(f.voice.session.value)
            assertFalse(f.service)
            assertNotNull(f.voice.failure.value)
            assertEquals(listOf("join:a", "leave:a"), f.requests)
            f.media.fail = false
            f.voice.retry()
            assertTrue(f.voice.session.value!!.connected)
            assertTrue(f.service)
            assertNull(f.voice.failure.value)
        } finally { f.close() }
    }

    @Test fun `leave while credentials are pending never connects later`() = runBlocking {
        val f = Fixture()
        try {
            f.joinWait = CompletableDeferred()
            val join = launch(start = CoroutineStart.UNDISPATCHED) { f.voice.join("a", "space", "A") }
            f.voice.leave()
            f.joinWait!!.complete(Unit)
            join.join()
            assertNull(f.voice.session.value)
            assertEquals(0, f.media.connects)
            assertFalse(f.service)
            assertEquals(listOf("join:a", "leave:a"), f.requests)
        } finally { f.close() }
    }

    @Test fun `switching a pending join leaves old server seat before joining new`() = runBlocking {
        val f = Fixture()
        try {
            f.joinWait = CompletableDeferred()
            val first = launch(start = CoroutineStart.UNDISPATCHED) { f.voice.join("a", "space", "A") }
            f.joinWait = null
            f.voice.join("b", "space", "B")
            first.join()
            assertEquals(listOf("join:a", "leave:a", "join:b"), f.requests)
            assertEquals("b", f.voice.session.value!!.channelId)
            assertTrue(f.service)
        } finally { f.close() }
    }

    @Test fun `mute and speaker choices during connect survive media setup`() = runBlocking {
        val f = Fixture()
        try {
            f.media.connectWait = CompletableDeferred()
            val join = launch(start = CoroutineStart.UNDISPATCHED) { f.voice.join("a", "space", "A") }
            f.voice.setMuted(true)
            f.voice.setSpeaker(false)
            f.media.connectWait!!.complete(Unit)
            join.join()
            assertTrue(f.voice.session.value!!.muted)
            assertFalse(f.media.media.value.micEnabled)
            assertFalse(f.media.speaker)
            assertEquals("a" to true, f.roster.last())
        } finally { f.close() }
    }

    @Test fun `listen only works without permission and cannot falsely unmute`() = runBlocking {
        val f = Fixture()
        try {
            f.allowed = false
            f.voice.join("a", "space", "A")
            assertTrue(f.voice.session.value!!.muted)
            assertFalse(f.media.media.value.micEnabled)
            assertTrue(f.service)
            f.voice.setMuted(false)
            assertTrue(f.voice.session.value!!.muted)
            assertNotNull(f.voice.failure.value)
            f.allowed = true
            f.voice.setMuted(false)
            assertFalse(f.voice.session.value!!.muted)
        } finally { f.close() }
    }

    @Test fun `a lost connection clears the session and offers retry`() = runBlocking {
        val f = Fixture()
        try {
            f.voice.join("a", "space", "A")
            f.media.media.value = f.media.media.value.copy(state = MediaState.Disconnected)
            yield()
            assertNull(f.voice.session.value)
            assertFalse(f.service)
            assertNotNull(f.voice.failure.value)
            assertTrue(f.requests.contains("leave:a"))
        } finally { f.close() }
    }

    @Test fun `voice cannot take over an active call`() = runBlocking {
        val f = Fixture()
        try {
            f.media.media.value = CallMedia(state = MediaState.Connected, owner = "call")
            f.voice.join("a", "space", "A")
            assertTrue(f.requests.isEmpty())
            assertEquals("call", f.media.media.value.owner)
            assertNotNull(f.voice.failure.value)
        } finally { f.close() }
    }

    @Test fun `leaving during media connection cancels it and closes the seat`() = runBlocking {
        val f = Fixture()
        try {
            f.media.connectWait = CompletableDeferred()
            val join = launch(start = CoroutineStart.UNDISPATCHED) { f.voice.join("a", "space", "A") }
            f.voice.leave()
            join.join()
            assertNull(f.voice.session.value)
            assertFalse(f.service)
            assertFalse(f.media.media.value.state == MediaState.Connected)
            assertNull(f.voice.failure.value)
        } finally { f.close() }
    }
}
