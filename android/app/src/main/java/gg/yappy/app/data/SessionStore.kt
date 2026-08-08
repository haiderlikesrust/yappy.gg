package gg.yappy.app.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
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
    }

    val accessToken: Flow<String?> = context.dataStore.data.map { it[Keys.access] }
    val userId: Flow<String?> = context.dataStore.data.map { it[Keys.userId] }
    val theme: Flow<String> = context.dataStore.data.map { it[Keys.theme] ?: "system" }

    suspend fun currentAccess(): String? = context.dataStore.data.first()[Keys.access]
    suspend fun currentRefresh(): String? = context.dataStore.data.first()[Keys.refresh]
    suspend fun currentUserId(): String? = context.dataStore.data.first()[Keys.userId]
    suspend fun currentDeviceId(): String? = context.dataStore.data.first()[Keys.deviceId]

    suspend fun saveTokens(access: String, refresh: String) {
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
        context.dataStore.edit { prefs ->
            prefs.clear()
            if (keptTheme != null) prefs[Keys.theme] = keptTheme
        }
    }
}
