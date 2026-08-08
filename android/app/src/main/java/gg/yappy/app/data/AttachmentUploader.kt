package gg.yappy.app.data

import android.content.Context
import android.graphics.BitmapFactory
import android.net.Uri
import android.provider.OpenableColumns
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.security.MessageDigest

/**
 * The three-step upload, client side.
 *
 *   POST /media/uploads   → a pending row and a presigned PUT
 *   PUT  <presigned url>  → bytes go straight to the bucket, never through us
 *   POST /media/:id/confirm → the server HEADs the object and marks it ready
 *
 * The bytes bypass the API entirely, which is the whole point: a 20 MB photo
 * routed through Node would hold a request open for the duration and pay for
 * the transfer twice.
 *
 * Two details that are easy to get wrong and fail only at the bucket:
 *  - the PUT's `Content-Type` must match the type that was signed, so it is set
 *    from the same string we sent to the presign call, not re-sniffed;
 *  - `Content-Length` is signed too, but OkHttp derives it from the body, so
 *    echoing the server's header back would duplicate it.
 */
class AttachmentUploader(
    private val context: Context,
    private val repo: YappyRepository,
    private val http: OkHttpClient,
) {

    data class Picked(
        val bytes: ByteArray,
        val filename: String,
        val mimeType: String,
        val width: Int?,
        val height: Int?,
    )

    /** Result of a completed upload — the id is what a message references. */
    data class Uploaded(val mediaId: String, val media: Attachment)

    suspend fun upload(uri: Uri, purpose: String = "attachment"): Uploaded = withContext(Dispatchers.IO) {
        val picked = read(uri)

        val checksum = MessageDigest.getInstance("SHA-256")
            .digest(picked.bytes)
            .joinToString("") { "%02x".format(it) }

        val created = repo.createUpload(
            filename = picked.filename,
            mimeType = picked.mimeType,
            size = picked.bytes.size,
            purpose = purpose,
            width = picked.width,
            height = picked.height,
            checksum = checksum,
        )

        // The server recognised the checksum and reused the stored object.
        // Nothing to upload, nothing to confirm.
        val target = created.upload ?: return@withContext Uploaded(created.media.id, created.media)

        val request = Request.Builder()
            .url(target.url)
            .put(picked.bytes.toRequestBody(picked.mimeType.toMediaTypeOrNull()))
            .apply {
                target.headers.forEach { (name, value) ->
                    val key = name.lowercase()
                    if (key != "content-length" && key != "content-type") header(name, value)
                }
            }
            .build()

        http.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                error("Upload failed (${response.code}) ${response.body?.string()?.take(200).orEmpty()}")
            }
        }

        val confirmed = repo.confirmUpload(created.media.id)
        Uploaded(confirmed.media.id, confirmed.media)
    }

    private fun read(uri: Uri): Picked {
        val resolver = context.contentResolver
        val mimeType = resolver.getType(uri) ?: "application/octet-stream"

        var filename = "upload"
        runCatching {
            resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst() && !cursor.isNull(0)) filename = cursor.getString(0)
            }
        }

        val bytes = resolver.openInputStream(uri)?.use { it.readBytes() }
            ?: error("Could not read the selected file")
        if (bytes.isEmpty()) error("That file is empty")

        // Dimensions come from the header only — decoding a 12 MP photo into a
        // bitmap just to learn its size is how a picker OOMs on a cheap phone.
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)

        return Picked(
            bytes = bytes,
            filename = filename,
            mimeType = mimeType,
            width = bounds.outWidth.takeIf { it > 0 },
            height = bounds.outHeight.takeIf { it > 0 },
        )
    }
}
