package gg.yappy.app.data

import gg.yappy.app.BuildConfig
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import kotlin.math.min
import kotlin.random.Random

/**
 * Realtime gateway client.
 *
 * Implements the protocol in docs/REALTIME_PROTOCOL.md: HELLO → IDENTIFY →
 * READY, heartbeats, RESUME on reconnect, and a command channel with acks.
 *
 * The three things that make this survive real mobile networks:
 *
 *  1. **RESUME before IDENTIFY.** A dropped socket that comes back inside the
 *     server's 120s window replays only the missed events.
 *  2. **Backoff with jitter.** Without jitter, every client knocked off by a
 *     deploy reconnects on the same schedule and does it again on the next tick.
 *  3. **The socket is never the source of truth.** `Connected` triggers a
 *     reconcile through the REST sync path; events are a latency optimisation.
 */
object GatewayOp {
    const val HELLO = 0
    const val IDENTIFY = 1
    const val READY = 2
    const val HEARTBEAT = 3
    const val HEARTBEAT_ACK = 4
    const val DISPATCH = 5
    const val RESUME = 6
    const val RESUMED = 7
    const val INVALID_SESSION = 8
    const val RECONNECT = 9
    const val COMMAND = 10
    const val COMMAND_ACK = 11
    const val ERROR = 12
}

sealed interface GatewayState {
    data object Disconnected : GatewayState
    data object Connecting : GatewayState
    data class Connected(val resumed: Boolean) : GatewayState
    /** Fatal: bad token, revoked session, forced upgrade. Do not auto-retry. */
    data class Fatal(val reason: String) : GatewayState
}

data class GatewayEvent(val type: String, val data: JsonElement)

class GatewayClient(
    private val scope: CoroutineScope,
    private val repo: YappyRepository,
    private val session: SessionStore,
    /** Shared with ApiClient so the socket follows the API onto the backup
     *  domain: read fresh on every connect, so a reconnect after failover
     *  lands on the domain the API is already using. */
    private val endpoints: Endpoints,
    private val httpFactory: () -> okhttp3.OkHttpClient,
) {
    private val _state = MutableStateFlow<GatewayState>(GatewayState.Disconnected)
    val state: StateFlow<GatewayState> = _state.asStateFlow()

    private val _events = MutableSharedFlow<GatewayEvent>(extraBufferCapacity = 256)
    val events: SharedFlow<GatewayEvent> = _events.asSharedFlow()

    private var socket: WebSocket? = null
    private var heartbeatJob: Job? = null
    private var reconnectJob: Job? = null

    private var sessionId: String? = null
    private var lastSeq: Int = 0
    private var attempt = 0

    /**
     * True until the first [connect]: "closed on purpose" is also the right
     * reading of a socket nobody has asked for yet, so a network coming up
     * before anyone is signed in does not start a ticket loop from
     * [networkAvailable].
     */
    private var intentionalClose = true

    /**
     * Which [connect] the in-flight ticket fetch belongs to. A disconnect and
     * a fresh connect while a ticket is still on its way used to end with two
     * sockets — the stale fetch came back and opened one behind the new one,
     * and only the new one was ever closed. Each connect stamps its own
     * number; a fetch that returns to find a different one stands down.
     */
    private var generation = 0

    fun connect() {
        if (_state.value is GatewayState.Connecting || socket != null) return
        intentionalClose = false
        _state.value = GatewayState.Connecting
        val mine = ++generation

        scope.launch {
            val ticket = runCatching { repo.gatewayTicket() }.getOrNull()
            // Backgrounded, or superseded by a newer connect, while the ticket
            // was in flight. Opening the socket now would leave one alive
            // behind a Disconnected state (or beside the newer one), and the
            // next connect() would see it and do nothing.
            if (intentionalClose || mine != generation) return@launch
            if (ticket == null) {
                // Back to Disconnected *before* the retry is scheduled: the
                // guard above treats Connecting as "already on it", so a
                // failed ticket that left the state there made every scheduled
                // retry a no-op and the socket never came back after a network
                // drop until the next foreground.
                _state.value = GatewayState.Disconnected
                scheduleReconnect()
                return@launch
            }

            val request = Request.Builder().url(endpoints.gatewayUrl).build()
            socket = httpFactory().newWebSocket(request, Listener(ticket.ticket))
        }
    }

    /**
     * The device just got a network. Called from the connectivity callback.
     *
     * A drop schedules a retry on a backoff that reaches 30 s, which is right
     * for a server that keeps refusing us and wrong for a phone that just
     * walked back onto Wi-Fi: the network is the thing that changed, so the
     * backoff is abandoned and the next attempt made now. The counter resets
     * too, so a failure on the new network starts the ladder from the bottom
     * rather than from wherever the old one left it. Nothing happens while a
     * socket is up, while nobody asked for one, or after a fatal close.
     */
    fun networkAvailable() {
        if (intentionalClose || socket != null) return
        if (_state.value is GatewayState.Fatal) return
        reconnectJob?.cancel()
        attempt = 0
        connect()
    }

    fun disconnect() {
        intentionalClose = true
        generation++
        reconnectJob?.cancel()
        heartbeatJob?.cancel()
        socket?.close(1000, "client disconnect")
        socket = null
        sessionId = null
        lastSeq = 0
        _state.value = GatewayState.Disconnected
    }

    // ── Commands ─────────────────────────────────────────────────────────────

    private fun command(payload: JsonObject) {
        val frame = buildJsonObject {
            put("op", GatewayOp.COMMAND)
            put("d", payload)
        }
        socket?.send(frame.toString())
    }

    fun typing(conversationId: String, started: Boolean) = command(
        buildJsonObject {
            put("c", if (started) "typing.start" else "typing.stop")
            put("conversationId", conversationId)
        },
    )

    /**
     * Read acks go over the socket rather than REST: they fire on every scroll,
     * and a round-tripped HTTP request each time is wasteful for something the
     * user never waits on.
     */
    fun markRead(conversationId: String, seq: Long) = command(
        buildJsonObject {
            put("c", "read.ack")
            put("conversationId", conversationId)
            put("seq", seq)
        },
    )

    /**
     * "This device has the message" — the sender's second tick.
     *
     * Sent as message events arrive, whether or not that chat is open. An open
     * chat's read ack already implies delivery server-side, so this only earns
     * its keep for conversations being received in the background of some other
     * screen — which is most of them, and is exactly where a single tick
     * lingering forever was wrong.
     *
     * Dropping this on a dead socket is safe: the watermark is monotonic and
     * the next read ack re-establishes it.
     */
    fun deliveryAck(conversationId: String, seq: Long) = command(
        buildJsonObject {
            put("c", "delivery.ack")
            put("conversationId", conversationId)
            put("seq", seq)
        },
    )

    fun setPresence(status: String, customStatus: String? = null) = command(
        buildJsonObject {
            put("c", "presence.update")
            put("status", status)
            if (customStatus != null) put("customStatus", customStatus)
        },
    )

    /**
     * "I am looking at this conversation right now" — ambient co-presence.
     *
     * Distinct from [subscribe], which covers every conversation the account
     * belongs to and says nothing about attention. Null on leaving the screen.
     */
    fun setViewing(conversationId: String?) = command(
        buildJsonObject {
            put("c", "conversation.viewing")
            if (conversationId != null) put("conversationId", conversationId) else put("conversationId", JsonNull)
        },
    )

    fun subscribe(conversationId: String) = command(
        buildJsonObject {
            put("c", "conversation.subscribe")
            put("conversationId", conversationId)
        },
    )

    // ── Socket callbacks ─────────────────────────────────────────────────────

    private inner class Listener(private val ticket: String) : WebSocketListener() {

        override fun onMessage(webSocket: WebSocket, text: String) {
            val frame = runCatching { AppJson.parseToJsonElement(text).jsonObjectOrNull() }.getOrNull() ?: return
            val op = frame["op"]?.jsonPrimitive?.int ?: return

            when (op) {
                GatewayOp.HELLO -> {
                    val interval = frame["d"]?.jsonObjectOrNull()?.get("heartbeatIntervalMs")
                        ?.jsonPrimitive?.int ?: 41_250

                    val resumable = sessionId != null
                    if (resumable) {
                        webSocket.send(
                            buildJsonObject {
                                put("op", GatewayOp.RESUME)
                                putJsonObject("d") {
                                    put("token", ticket)
                                    put("sessionId", sessionId!!)
                                    put("seq", lastSeq)
                                }
                            }.toString(),
                        )
                    } else {
                        scope.launch { sendIdentify(webSocket, ticket) }
                    }
                    startHeartbeat(webSocket, interval)
                }

                GatewayOp.READY -> {
                    val d = frame["d"]?.jsonObjectOrNull()
                    sessionId = d?.get("sessionId")?.jsonPrimitive?.contentOrNull()
                    lastSeq = 0
                    attempt = 0
                    _state.value = GatewayState.Connected(resumed = false)
                    d?.let { emit("ready", it) }
                }

                GatewayOp.RESUMED -> {
                    attempt = 0
                    _state.value = GatewayState.Connected(resumed = true)
                }

                GatewayOp.DISPATCH -> {
                    frame["s"]?.jsonPrimitive?.int?.let { lastSeq = it }
                    val type = frame["t"]?.jsonPrimitive?.contentOrNull() ?: return
                    val data = frame["d"] ?: JsonObject(emptyMap())
                    emit(type, data)
                }

                GatewayOp.HEARTBEAT_ACK -> Unit

                GatewayOp.INVALID_SESSION -> {
                    // Cannot resume — drop the session id so the next HELLO
                    // performs a full IDENTIFY, then let the sync path reconcile.
                    sessionId = null
                    lastSeq = 0
                }

                GatewayOp.RECONNECT -> {
                    // A rolling deploy, not a failure. Reconnect immediately.
                    webSocket.close(1000, "server asked to reconnect")
                }

                GatewayOp.COMMAND_ACK, GatewayOp.ERROR -> Unit
            }
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = handleClose(code, reason)
        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(1000, null)
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) =
            handleClose(response?.code ?: 0, t.message ?: "failure")
    }

    private suspend fun sendIdentify(webSocket: WebSocket, ticket: String) {
        val cursors = session.loadCursors()
        val frame = buildJsonObject {
            put("op", GatewayOp.IDENTIFY)
            putJsonObject("d") {
                put("token", ticket)
                put("protocolVersion", 1)
                putJsonObject("client") {
                    put("platform", "android")
                    put("version", BuildConfig.VERSION_NAME)
                }
                put("presence", "online")
                // Sending cursors turns READY into a delta. On an account with
                // hundreds of chats this is the difference between megabytes and
                // kilobytes on every reconnect.
                put(
                    "cursors",
                    buildJsonArray {
                        cursors.entries.take(500).forEach { (id, seq) ->
                            add(
                                buildJsonObject {
                                    put("conversationId", id)
                                    put("seq", seq)
                                },
                            )
                        }
                    },
                )
            }
        }
        webSocket.send(frame.toString())
    }

    private fun startHeartbeat(webSocket: WebSocket, intervalMs: Int) {
        heartbeatJob?.cancel()
        heartbeatJob = scope.launch {
            // Jitter the first beat so a fleet reconnecting after a deploy does
            // not then heartbeat in lockstep forever.
            delay(Random.nextLong(0, 5_000))
            while (true) {
                webSocket.send(buildJsonObject { put("op", GatewayOp.HEARTBEAT) }.toString())
                delay(intervalMs.toLong())
            }
        }
    }

    private fun handleClose(code: Int, reason: String) {
        heartbeatJob?.cancel()
        socket = null

        if (intentionalClose) {
            _state.value = GatewayState.Disconnected
            return
        }

        // 4010+ is fatal per the protocol: a bad token or a revoked session will
        // not fix itself, and retrying just burns battery.
        if (code >= 4010) {
            _state.value = GatewayState.Fatal(reason)
            return
        }

        _state.value = GatewayState.Disconnected
        scheduleReconnect()
    }

    private fun scheduleReconnect() {
        reconnectJob?.cancel()
        reconnectJob = scope.launch {
            attempt += 1
            val base = min(30_000L, 1_000L * (1L shl min(attempt - 1, 5)))
            val jitter = Random.nextLong(0, base / 2)
            delay(base + jitter)
            connect()
        }
    }

    private fun emit(type: String, data: JsonElement) {
        _events.tryEmit(GatewayEvent(type, data))
    }
}

// ── Small JSON helpers ───────────────────────────────────────────────────────

internal fun JsonElement.jsonObjectOrNull(): JsonObject? = this as? JsonObject
internal fun JsonPrimitive.contentOrNull(): String? = if (isString || content != "null") content else null
