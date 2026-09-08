package gg.yappy.app.data

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.StateFlow

/** The session can be exercised without an Android audio device or an SFU. */
internal interface VoiceMedia {
    val media: StateFlow<CallMedia>
    suspend fun connect(scope: CoroutineScope, url: String, token: String, publishAudio: Boolean = true, owner: String? = null)
    suspend fun setMicEnabled(enabled: Boolean)
    fun setSpeakerphone(on: Boolean)
    fun close(owner: String? = null)
}
