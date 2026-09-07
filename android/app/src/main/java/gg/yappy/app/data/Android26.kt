package gg.yappy.app.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

@Serializable data class ChatFolder(val id: String, val name: String, val conversationIds: List<String> = emptyList())
@Serializable data class FolderList(val folders: List<ChatFolder> = emptyList())
@Serializable data class PhotoWall(val id: String, val title: String, val creatorId: String, val count: Int = 0)
@Serializable data class WallList(val walls: List<PhotoWall> = emptyList())
@Serializable data class GalleryPage(val messages: List<Message> = emptyList(), val hasMore: Boolean = false, val title: String = "")
@Serializable data class Transcript(val text: String)

class Android26Api(private val api: ApiClient) {
    suspend fun folders(): FolderList = api.get("/extras/folders")
    suspend fun saveFolder(folder: ChatFolder): Ok = api.put("/extras/folders/${folder.id}", buildJsonObject {
        put("name",folder.name); putJsonArray("conversationIds") { folder.conversationIds.forEach { add(it) } }
    })
    suspend fun deleteFolder(id: String): Ok = api.delete("/extras/folders/$id")
    suspend fun gallery(id: String, kind: String, before: Long? = null): GalleryPage = api.get("/extras/conversations/$id/gallery",mapOf("kind" to kind,"before" to before?.toString()))
    suspend fun walls(id: String): WallList = api.get("/extras/conversations/$id/walls")
    suspend fun saveWall(conversationId: String, id: String, title: String): Ok = api.put("/extras/conversations/$conversationId/walls/$id",buildJsonObject { put("title",title) })
    suspend fun wall(id: String, before: Long? = null): GalleryPage = api.get("/extras/walls/$id",mapOf("before" to before?.toString()))
    suspend fun addToWall(id: String,messageId: String): Ok = api.put("/extras/walls/$id/items/$messageId")
    suspend fun removeFromWall(id: String,messageId: String): Ok = api.delete("/extras/walls/$id/items/$messageId")
    suspend fun deleteWall(id: String): Ok = api.delete("/extras/walls/$id")
    suspend fun transcribe(id: String): Transcript = api.post("/extras/messages/$id/transcript",buildJsonObject { put("consent",true) })
    suspend fun createStickerPack(name: String, slug: String): JsonObject = api.post("/stickers/packs",buildJsonObject { put("name",name);put("slug",slug) })
    suspend fun addSticker(pack: String,mediaId: String,name: String): JsonObject = api.post("/stickers/packs/$pack/stickers",buildJsonObject { put("mediaId",mediaId);put("name",name);put("emoji","✨") })
}
