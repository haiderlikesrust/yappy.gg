package gg.yappy.app.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

private val Context.dataStore: DataStore<Preferences> by preferencesDataStore(name = "yappy_session")

/**
 * Token and preference storage.
 *
 * DataStore rather than SharedPreferences because token reads happen on the
 * network path and `SharedPreferences.getString` does blocking disk I/O the
 * first time it is touched.
 *
 * These values are excluded from cloud backup and device transfer (see
 * res/xml/backup_rules.xml) — a refresh token restored onto a second device is
 * a session the user never authorised. Encrypting at rest with the Keystore
 * would be the next step; DataStore alone relies on app-sandbox isolation.
 */
class SessionStore(private val context: Context) {

    private object Keys {
        val access = stringPreferencesKey("access_token")
        val refresh = stringPreferencesKey("refresh_token")
        val userId = stringPreferencesKey("user_id")
        val deviceId = stringPreferencesKey("device_id")
        val theme = stringPreferencesKey("theme")
        /** Per-conversation `seq` cursors, so a cold start can ask for a delta. */
        val cursors = stringPreferencesKey("cursors")
        /** Biometric lock in front of the app. Device preference, not account. */
        val appLock = booleanPreferencesKey("app_lock")
        /** Id of the newest release note already shown. */
        val seenRelease = stringPreferencesKey("seen_release")
    }

    /**
     * Whether a session already existed when the process started.
     *
     * Read once in [bootstrap] and never updated, because What's New needs to
     * tell an upgrader apart from a fresh install: "no release marker" is what
     * *both* look like on the first run of the build that introduced the
     * marker, and treating an upgrader as new swallows the notes written for
     * exactly that audience.
     */
    @Volatile
    var hadSessionAtLaunch: Boolean = false
        private set

    val accessToken: Flow<String?> = context.dataStore.data.map { it[Keys.access] }
    val userId: Flow<String?> = context.dataStore.data.map { it[Keys.userId] }

    /**
     * Read synchronously by the lock gate, which has to decide whether to cover
     * the first frame — an `await` there shows the conversation list for a
     * frame, which is exactly the thing the lock exists to prevent. Kept in
     * sync by [setAppLock] and seeded by [bootstrap].
     */
    @Volatile
    var appLock: Boolean = false
        private set

    /**
     * The access token, readable without suspending.
     *
     * ExoPlayer resolves a data spec on its own loader thread, with no
     * coroutine to suspend in, and a private attachment needs the bearer header
     * on that exact request. `runBlocking` on DataStore there is a deadlock
     * waiting for a bad day, so the token is mirrored here on every write.
     */
    @Volatile
    var cachedAccess: String? = null
        private set

    val appLockFlow: Flow<Boolean> = context.dataStore.data.map { it[Keys.appLock] ?: false }
    /**
     * Light unless the person says otherwise.
     *
     * Not "system": yappy's light theme is the designed one — the violet-grey
     * sheet the whole neumorphic language is built on — and following the
     * handset means most people meet the app in the variant that is a
     * translation of it. "System" is still offered in Settings for anyone who
     * wants it.
     */
    val theme: Flow<String> = context.dataStore.data.map { it[Keys.theme] ?: "light" }

    suspend fun currentAccess(): String? = context.dataStore.data.first()[Keys.access]
    suspend fun currentRefresh(): String? = context.dataStore.data.first()[Keys.refresh]
    suspend fun currentUserId(): String? = context.dataStore.data.first()[Keys.userId]
    suspend fun currentDeviceId(): String? = context.dataStore.data.first()[Keys.deviceId]

    /**
     * One read at startup that seeds every synchronously-read flag, so nothing
     * later has to block on disk to answer a question the first frame asks.
     */
    suspend fun bootstrap() {
        val prefs = context.dataStore.data.first()
        hadSessionAtLaunch = prefs[Keys.access] != null
        appLock = prefs[Keys.appLock] ?: false
        cachedAccess = prefs[Keys.access]
    }

    suspend fun setAppLock(on: Boolean) {
        appLock = on
        context.dataStore.edit { it[Keys.appLock] = on }
    }

    suspend fun seenRelease(): String? = context.dataStore.data.first()[Keys.seenRelease]

    suspend fun setSeenRelease(id: String) {
        context.dataStore.edit { it[Keys.seenRelease] = id }
    }

    suspend fun saveTokens(access: String, refresh: String) {
        cachedAccess = access
        context.dataStore.edit {
            it[Keys.access] = access
            it[Keys.refresh] = refresh
        }
    }

    suspend fun saveIdentity(userId: String, deviceId: String?) {
        context.dataStore.edit {
            it[Keys.userId] = userId
            if (deviceId != null) it[Keys.deviceId] = deviceId
        }
    }

    suspend fun setTheme(value: String) {
        context.dataStore.edit { it[Keys.theme] = value }
    }

    /** Serialised as `id:seq,id:seq` — small, and avoids a second serializer. */
    suspend fun saveCursors(cursors: Map<String, Long>) {
        context.dataStore.edit {
            it[Keys.cursors] = cursors.entries.joinToString(",") { (k, v) -> "$k:$v" }
        }
    }

    suspend fun loadCursors(): Map<String, Long> {
        val raw = context.dataStore.data.first()[Keys.cursors].orEmpty()
        if (raw.isBlank()) return emptyMap()
        return raw.split(',').mapNotNull { entry ->
            val parts = entry.split(':')
            val id = parts.getOrNull(0) ?: return@mapNotNull null
            val seq = parts.getOrNull(1)?.toLongOrNull() ?: return@mapNotNull null
            id to seq
        }.toMap()
    }

    suspend fun clear() {
        // Theme survives sign-out: it is a device preference, not account state.
        val keptTheme = context.dataStore.data.first()[Keys.theme]
        appLock = false
        cachedAccess = null
        context.dataStore.edit { prefs ->
            prefs.clear()
            if (keptTheme != null) prefs[Keys.theme] = keptTheme
        }
    }
}
