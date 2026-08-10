package gg.yappy.app.data

import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Turns gateway call events into rings and hang-ups.
 *
 * The socket is the ring path whenever the app is alive: it beats FCM by
 * seconds, and it is the *only* path on a build with no Firebase configuration.
 * FCM covers the case this cannot — a process that is not running.
 * [CallCoordinator.ring] is idempotent per call id, so whichever arrives second
 * is silently dropped rather than producing a second ring.
 */
class CallWatcher(
    private val context: Context,
    private val container: gg.yappy.app.AppContainer,
) {

    fun start(scope: CoroutineScope) {
        scope.launch {
            container.gateway.events.collect { event ->
                val data = runCatching { event.data.jsonObject }.getOrNull() ?: return@collect
                fun str(key: String) = data[key]?.jsonPrimitive?.contentOrNull()

                when (event.type) {
                    "call.ring" -> {
                        val call = runCatching {
                            AppJson.decodeFromJsonElement(Call.serializer(), event.data)
                        }.getOrNull() ?: return@collect
                        if (call.id.isBlank()) return@collect

                        // Never ring the person who started it: their own
                        // devices are not invitees today, but a payload bug
                        // must not make a phone ring itself.
                        if (call.initiatorId == container.session.currentUserId()) return@collect

                        val caller = call.participants.firstOrNull { it.user.id == call.initiatorId }
                        CallCoordinator.ring(
                            context = context,
                            callId = call.id,
                            callerName = caller?.user?.label ?: "yappy",
                            video = call.mode == "video",
                            expiresAt = str("expiresAt") ?: call.ringExpiresAt,
                            conversationId = call.conversationId,
                        )
                    }

                    "call.end" -> str("id")?.let { CallCoordinator.ended(context, it) }

                    "call.update" -> {
                        val id = str("id") ?: return@collect
                        if (str("state") == "ended") CallCoordinator.ended(context, id)
                    }

                    // Another of this user's devices acted. This one stops
                    // ringing rather than sitting there after the call was
                    // already answered on a tablet.
                    "call.participant_update" -> {
                        val id = str("callId") ?: return@collect
                        if (str("userId") != container.session.currentUserId()) return@collect
                        if (str("answeredOn") == container.session.currentDeviceId()) return@collect
                        if (str("state") in setOf("joined", "declined")) {
                            CallCoordinator.ended(context, id)
                        }
                    }
                }
            }
        }
    }
}
