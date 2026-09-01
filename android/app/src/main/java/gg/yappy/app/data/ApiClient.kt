package gg.yappy.app.data

import gg.yappy.app.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.logging.HttpLoggingInterceptor
import java.io.IOException
import java.util.concurrent.TimeUnit

/** Typed failure the UI can branch on, mirroring the backend's error codes. */
class ApiException(
    val status: Int,
    val code: String,
    override val message: String,
    val retryAfter: Int? = null,
) : Exception(message) {
    val isAuthFailure: Boolean get() = status == 401
    val isRateLimited: Boolean get() = status == 429
}

val AppJson = Json {
    ignoreUnknownKeys = true
    isLenient = true
    encodeDefaults = true
    explicitNulls = false
    coerceInputValues = true
}

/** What a refresh attempt actually established. */
enum class RefreshOutcome {
    /** New tokens are saved. */
    Rotated,

    /** The server refused the refresh token. The session is over. */
    Rejected,

    /**
     * Nothing was learned — the network or the server was unavailable. Keep the
     * tokens and try again on the next request.
     */
    Transient,
}

/**
 * HTTP client.
 *
 * Three things it does that are worth calling out:
 *
 *  1. **Single-flight refresh.** A 401 triggers a token refresh behind a mutex.
 *     Without it, an app resuming from background fires six requests at once,
 *     all 401, all refresh — and rotation means five of them present a token
 *     that has already been superseded. The backend tolerates one retry inside
 *     its grace window; it should not have to.
 *
 *  2. **Domain failover.** A *connection* failure (DNS, refused, timed out)
 *     advances to the backup domain and retries. An HTTP 500 does not: the
 *     domain is reachable, the server is just unhappy, and switching domains
 *     would not help.
 *
 *  3. **No token in the URL, ever.** The gateway ticket is the only short-lived
 *     credential and it goes in the WebSocket handshake payload, not the query
 *     string.
 */
class ApiClient(
    private val session: SessionStore,
    private val endpoints: Endpoints = Endpoints(
        apiUrls = listOf(BuildConfig.API_URL, BuildConfig.API_URL_ALT),
        gatewayUrls = listOf(BuildConfig.GATEWAY_URL, BuildConfig.GATEWAY_URL_ALT),
    ),
    private val onSignedOut: suspend () -> Unit = {},
) {
    /** The domain the client is currently using; switches on failover. */
    private val baseUrl: String get() = endpoints.apiBase
    private val jsonMedia = "application/json; charset=utf-8".toMediaType()
    private val refreshMutex = Mutex()

    val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .apply {
            if (BuildConfig.DEBUG) {
                addInterceptor(
                    HttpLoggingInterceptor().apply { level = HttpLoggingInterceptor.Level.BASIC },
                )
            }
        }
        .build()

    // ── Core request ─────────────────────────────────────────────────────────

    /**
     * Request bodies are `JsonElement`, built with `buildJsonObject { }` at the
     * call site, rather than arbitrary objects encoded reflectively. It costs a
     * few lines per endpoint and buys a compile-time-visible payload with no
     * runtime serializer lookup — and no chance of R8 stripping a serializer
     * that only reflection knew about.
     */
    /**
     * @param cacheTo name of a [DiskCache] slot to keep this response's raw
     *   bytes in for next launch's first paint. Only the screens' primary list
     *   fetches pass it; everything else stays uncached.
     */
    suspend inline fun <reified T> get(
        path: String,
        query: Map<String, String?> = emptyMap(),
        cacheTo: String? = null,
    ): T = request("GET", path, null, query, cacheTo)

    suspend inline fun <reified T> post(path: String, body: JsonElement? = null): T =
        request("POST", path, body)

    suspend inline fun <reified T> patch(path: String, body: JsonElement? = null): T =
        request("PATCH", path, body)

    suspend inline fun <reified T> put(path: String, body: JsonElement? = null): T =
        request("PUT", path, body)

    suspend inline fun <reified T> delete(path: String, query: Map<String, String?> = emptyMap()): T =
        request("DELETE", path, null, query)

    suspend inline fun <reified T> request(
        method: String,
        path: String,
        body: JsonElement? = null,
        query: Map<String, String?> = emptyMap(),
        cacheTo: String? = null,
    ): T {
        val raw = execute(method, path, body?.let { AppJson.encodeToString(JsonElement.serializer(), it) }, query)
        // Decoded and cached off the main thread. Callers launch from
        // viewModelScope, which is Main.immediate — so a 50-message page's
        // JSON parse, and the synchronous disk write that follows it, were
        // both landing on the UI thread, right when a screen was opening.
        return withContext(Dispatchers.IO) {
            val decoded = AppJson.decodeFromString<T>(raw)
            // Written only after the decode succeeds: a slot must never hold
            // bytes this build has already proven it cannot read.
            if (cacheTo != null && raw.length > 2) DiskCache.write(raw, cacheTo)
            decoded
        }
    }

    suspend fun execute(
        method: String,
        path: String,
        jsonBody: String?,
        query: Map<String, String?> = emptyMap(),
        retryOn401: Boolean = true,
    ): String = withContext(Dispatchers.IO) {
        val payload = jsonBody?.toRequestBody(jsonMedia)
        // Fetched once: the token is constant across a failover retry, and
        // reading it inside the loop would call a suspend function from a plain
        // local function. A 401 refresh happens later, on its own retry path.
        val accessToken = session.currentAccess()

        fun requestFor(base: String): Request {
            val url = (base + path).toHttpUrl().newBuilder().apply {
                query.forEach { (k, v) -> if (v != null) addQueryParameter(k, v) }
            }.build()
            val builder = Request.Builder().url(url)
            when (method) {
                "GET" -> builder.get()
                "DELETE" -> if (payload != null) builder.delete(payload) else builder.delete()
                else -> builder.method(method, payload ?: "".toRequestBody(jsonMedia))
            }
            accessToken?.let { builder.header("Authorization", "Bearer $it") }
            builder.header("Accept", "application/json")
            return builder.build()
        }

        // Try the current domain; on a *connection* failure (DNS, refused,
        // timeout — an IOException, not an HTTP error), fail over to the backup
        // domain and try again. An HTTP 500 does not trigger this: the domain is
        // reachable, the server is just unhappy, and switching domains would not
        // help. The chosen domain sticks for later requests via Endpoints.
        val response = run {
            var currentBase = baseUrl
            while (true) {
                try {
                    return@run http.newCall(requestFor(currentBase)).execute()
                } catch (e: IOException) {
                    val next = endpoints.failOver(currentBase)
                    if (next == null || next == currentBase) {
                        throw ApiException(0, "network_error", e.message ?: "Network unavailable")
                    }
                    currentBase = next
                }
            }
            @Suppress("UNREACHABLE_CODE")
            error("unreachable")
        }

        response.use {
            val text = it.body?.string().orEmpty()

            if (it.isSuccessful) return@withContext text.ifBlank { "{}" }

            if (it.code == 401 && retryOn401) {
                when (refreshTokens()) {
                    RefreshOutcome.Rotated ->
                        return@withContext execute(method, path, jsonBody, query, retryOn401 = false)

                    RefreshOutcome.Rejected -> onSignedOut()

                    // A 502 from a restarting API, a 429, a stalled connection
                    // on a train. None of those mean the session was revoked,
                    // and signing out *erases the refresh token* — an
                    // unrecoverable response to a temporary condition. Surface
                    // the 401 and let the next request try again.
                    RefreshOutcome.Transient -> Unit
                }
            }

            val detail = runCatching { AppJson.decodeFromString<ApiErrorBody>(text).error }.getOrNull()
            throw ApiException(
                status = it.code,
                code = detail?.code ?: "http_${it.code}",
                message = detail?.message ?: "Request failed (${it.code})",
                retryAfter = detail?.retryAfter,
            )
        }
    }

    /**
     * Refresh, single-flight.
     *
     * The token is re-read *inside* the lock: whoever waited on the mutex may
     * find the refresh already done by the holder, in which case there is
     * nothing to do and rotating again would invalidate a perfectly good token.
     *
     * Three-valued on purpose. Collapsing "the server revoked your session" and
     * "the request did not get through" into one `false` meant a timeout or a
     * 502 during a deploy tore down the session and erased the refresh token —
     * the user was dumped on the sign-in screen with nothing on the device left
     * to recover from.
     */
    private suspend fun refreshTokens(): RefreshOutcome = refreshMutex.withLock {
        val before = session.currentAccess()
        val refresh = session.currentRefresh() ?: return@withLock RefreshOutcome.Rejected

        // Someone else refreshed while we queued.
        if (before != session.currentAccess()) return@withLock RefreshOutcome.Rotated

        return@withLock try {
            val bodyJson = AppJson.encodeToString(
                JsonElement.serializer(),
                JsonObject(mapOf("refreshToken" to JsonPrimitive(refresh))),
            )
            val request = Request.Builder()
                .url("$baseUrl/auth/refresh")
                .post(bodyJson.toRequestBody(jsonMedia))
                .build()

            withContext(Dispatchers.IO) {
                http.newCall(request).execute().use { res ->
                    // Only the server saying no counts as no.
                    if (res.code == 401 || res.code == 403) return@use RefreshOutcome.Rejected
                    if (!res.isSuccessful) return@use RefreshOutcome.Transient
                    val parsed = AppJson.decodeFromString<RefreshResponse>(res.body?.string().orEmpty())
                    session.saveTokens(parsed.accessToken, parsed.refreshToken)
                    RefreshOutcome.Rotated
                }
            }
        } catch (_: Exception) {
            RefreshOutcome.Transient
        }
    }
}
