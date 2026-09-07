package gg.yappy.app.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

@Serializable data class CommunityActivity(val id: String, val kind: String, val conversationId: String, val conversationTitle: String? = null, val messageId: String? = null, val seq: Long? = null, val title: String, val body: String, val createdAt: String)
@Serializable data class CatchUpRoom(val conversationId: String, val title: String, val unreadCount: Int)
@Serializable data class CatchUpEnvelope(val items: List<CommunityActivity> = emptyList(), val rooms: List<CatchUpRoom> = emptyList())
@Serializable data class CommunityEvent(val id: String, val conversationId: String, val conversationTitle: String = "", val title: String, val description: String = "", val location: String = "", val startsAt: String, val endsAt: String? = null, val cancelledAt: String? = null, val response: String? = null, val remind: Boolean = false, val going: Int = 0, val maybe: Int = 0, val canManage: Boolean = false)
@Serializable data class CommunityEvents(val events: List<CommunityEvent> = emptyList())
@Serializable data class CommunityReminder(val id: String, val conversationId: String, val messageId: String? = null, val seq: Long? = null, val eventId: String? = null, val dueAt: String, val title: String, val conversationTitle: String? = null)
@Serializable data class CommunityReminders(val reminders: List<CommunityReminder> = emptyList())
@Serializable data class CommunityScheduled(val id: String, val conversationId: String, val conversationTitle: String? = null, val content: String, val sendAt: String, val failedAt: String? = null, val failure: String? = null)
@Serializable data class CommunitySchedule(val messages: List<CommunityScheduled> = emptyList())
@Serializable data class SavedCollection(val id: String, val name: String, val count: Int = 0)
@Serializable data class SavedCollections(val collections: List<SavedCollection> = emptyList())
@Serializable data class CollectionItem(val messageId: String, val conversationId: String, val conversationTitle: String? = null, val seq: Long, val content: String, val sender: String, val savedAt: String, val collectionId: String? = null, val note: String = "")
@Serializable data class CollectionItems(val items: List<CollectionItem> = emptyList())
@Serializable data class SavedDetails(val collectionId: String? = null, val note: String = "")
@Serializable data class CommunityProfile(val tags: List<String> = emptyList(), val language: String = "", val welcome: String = "", val rules: String = "", val startChannelId: String? = null)
@Serializable data class WelcomeChannel(val id: String, val title: String? = null)
@Serializable data class CommunityWelcome(val profile: CommunityProfile = CommunityProfile(), val seen: Boolean = false, val canManage: Boolean = false, val channels: List<WelcomeChannel> = emptyList())

class CommunityApi(private val api: ApiClient) {
    suspend fun catchUp(): CatchUpEnvelope = api.get("/community/catch-up")
    suspend fun events(id: String? = null): CommunityEvents = api.get("/community/events", mapOf("conversationId" to id))
    suspend fun reminders(): CommunityReminders = api.get("/community/reminders")
    suspend fun scheduled(): CommunitySchedule = api.get("/community/scheduled")
    suspend fun collections(): SavedCollections = api.get("/community/collections")
    suspend fun savedDetails(id: String): SavedDetails = api.get("/community/saved/$id")
    suspend fun saved(query: String, collectionId: String?): CollectionItems = api.get("/community/saved", mapOf("q" to query, "collectionId" to collectionId))
    suspend fun welcome(id: String): CommunityWelcome = api.get("/community/groups/$id/welcome")
    suspend fun change(method: String, path: String, body: JsonElement? = null): JsonObject = api.request(method, "/community$path", body)
    suspend fun unsave(conversationId: String, messageId: String): JsonObject = api.delete("/conversations/$conversationId/messages/$messageId/save")
}
