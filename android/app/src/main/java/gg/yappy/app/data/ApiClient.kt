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

/**
 * HTTP client.
 *
 * Two things it does that are worth calling out:
 *
 *  1. **Single-flight refresh.** A 401 triggers a token refresh behind a mutex.
 *     Without it, an app resuming from background fires six requests at once,
 *     all 401, all refresh — and rotation means five of them present a token
 *     that has already been superseded. The backend tolerates one retry inside
 *     its grace window; it should not have to.
 *
 *  2. **No token in the URL, ever.** The gateway ticket is the only short-lived
 *     credential and it goes in the WebSocket handshake payload, not the query
 *     string.
 */
class ApiClient(
    private val session: SessionStore,
    private val baseUrl: String = BuildConfig.API_URL,
    private val onSignedOut: suspend () -> Unit = {},
) {
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
    suspend inline fun <reified T> get(path: String, query: Map<String, String?> = emptyMap()): T =
        request("GET", path, null, query)

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
    ): T {
        val raw = execute(method, path, body?.let { AppJson.encodeToString(JsonElement.serializer(), it) }, query)
        return AppJson.decodeFromString(raw)
    }

    suspend fun execute(
        method: String,
        path: String,
        jsonBody: String?,
        query: Map<String, String?> = emptyMap(),
        retryOn401: Boolean = true,
    ): String = withContext(Dispatchers.IO) {
        val url = (baseUrl + path).toHttpUrl().newBuilder().apply {
            query.forEach { (k, v) -> if (v != null) addQueryParameter(k, v) }
        }.build()

        val builder = Request.Builder().url(url)
        val payload = jsonBody?.toRequestBody(jsonMedia)

        when (method) {
            "GET" -> builder.get()
            "DELETE" -> if (payload != null) builder.delete(payload) else builder.delete()
            else -> builder.method(method, payload ?: "".toRequestBody(jsonMedia))
        }

        session.currentAccess()?.let { builder.header("Authorization", "Bearer $it") }
        builder.header("Accept", "application/json")

        val response = try {
            http.newCall(builder.build()).execute()
        } catch (e: IOException) {
            throw ApiException(0, "network_error", e.message ?: "Network unavailable")
        }

        response.use {
            val text = it.body?.string().orEmpty()

            if (it.isSuccessful) return@withContext text.ifBlank { "{}" }

            if (it.code == 401 && retryOn401) {
                val refreshed = refreshTokens()
                if (refreshed) {
                    return@withContext execute(method, path, jsonBody, query, retryOn401 = false)
                }
                onSignedOut()
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
     */
    private suspend fun refreshTokens(): Boolean = refreshMutex.withLock {
        val before = session.currentAccess()
        val refresh = session.currentRefresh() ?: return@withLock false

        // Someone else refreshed while we queued.
        if (before != session.currentAccess()) return@withLock true

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
                    if (!res.isSuccessful) return@use false
                    val parsed = AppJson.decodeFromString<RefreshResponse>(res.body?.string().orEmpty())
                    session.saveTokens(parsed.accessToken, parsed.refreshToken)
                    true
                }
            }
        } catch (_: Exception) {
            false
        }
    }
}
