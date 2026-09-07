package gg.yappy.app.data

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.work.*
import gg.yappy.app.YappyApplication
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import java.io.File
import java.util.UUID

@Serializable data class QueuedMedia(val path:String,val mime:String,val caption:String="",val mediaId:String?=null)
@Serializable data class MediaUploadDraft(val id:String,val userId:String,val conversationId:String,val caption:String,val spoiler:Boolean,val files:List<QueuedMedia>)

object MediaUploadQueue {
    private fun folder(context:Context,id:String):File {
        UUID.fromString(id)
        return File(context.noBackupFilesDir,"uploads/$id")
    }
    fun read(context:Context,id:String):MediaUploadDraft = AppJson.decodeFromString(File(folder(context,id),"draft.json").readText())
    fun save(context:Context,draft:MediaUploadDraft){
        val dir=folder(context,draft.id).also { it.mkdirs() }
        val temp=File(dir,"draft.tmp");temp.writeText(AppJson.encodeToString(draft))
        check(temp.renameTo(File(dir,"draft.json"))) { "Could not save upload" }
    }
    suspend fun enqueue(context:Context,user:String,conversation:String,uris:List<Uri>,captions:List<String>,caption:String,spoiler:Boolean):String=withContext(Dispatchers.IO){
        require(uris.size in 1..10)
        val id=UUID.randomUUID().toString();val dir=folder(context,id).also{it.mkdirs()}
        try {
            val files=uris.mapIndexed { index,uri ->
                val mime=context.contentResolver.getType(uri)?:if(uri.toString().endsWith(".mp4"))"video/mp4" else "image/jpeg"
                val ext=android.webkit.MimeTypeMap.getSingleton().getExtensionFromMimeType(mime)?:"bin"
                val file=File(dir,"media-$index.$ext")
                context.contentResolver.openInputStream(uri)?.use { input -> file.outputStream().use { out ->
                    val buffer=ByteArray(64*1024);var bytes=0L
                    while(true){coroutineContext.ensureActive();val n=input.read(buffer);if(n<0)break;bytes+=n;require(bytes<=200_000_000){"Each file must be under 200 MB"};out.write(buffer,0,n)}
                }} ?: error("Could not read selected media")
                require(file.length()>0){"Selected file is empty"}
                QueuedMedia(file.path,mime,captions.getOrElse(index){""})
            }
            save(context,MediaUploadDraft(id,user,conversation,caption,spoiler,files));start(context,id,user,conversation);id
        }catch(e:Exception){dir.deleteRecursively();throw e}
    }
    fun start(context:Context,id:String,user:String,conversation:String){
        WorkManager.getInstance(context).enqueueUniqueWork("media-$id",ExistingWorkPolicy.KEEP,
            OneTimeWorkRequestBuilder<MediaUploadWorker>().setInputData(workDataOf("id" to id,"conversationId" to conversation))
                .addTag("draft-$id").addTag("uploads-$user").addTag("uploads-$conversation").setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()).build())
    }
    suspend fun retry(context:Context,id:String)=withContext(Dispatchers.IO){val d=read(context,id);start(context,id,d.userId,d.conversationId)}
    suspend fun cancel(context:Context,id:String)=withContext(Dispatchers.IO){
        WorkManager.getInstance(context).cancelUniqueWork("media-$id").result.get()
        // Preserve the local files so an explicit retry can reuse completed uploads.
    }
    suspend fun discard(context:Context,id:String)=withContext(Dispatchers.IO){
        val work=WorkManager.getInstance(context).getWorkInfosForUniqueWork("media-$id").get()
        check(work.all{it.state.isFinished}){"Cancel the upload before removing it."}
        val dir=folder(context,id)
        check(dir.canonicalFile.parentFile==File(context.noBackupFilesDir,"uploads").canonicalFile)
        check(!dir.exists()||dir.deleteRecursively()){"Couldn’t remove the upload files."}
    }
}

class MediaUploadWorker(context:Context,params:WorkerParameters):CoroutineWorker(context,params){
    override suspend fun doWork():Result {
        val id=inputData.getString("id")?:return Result.failure()
        val container=(applicationContext as YappyApplication).container
        try{
            var draft=withContext(Dispatchers.IO){MediaUploadQueue.read(applicationContext,id)}
            if(container.session.currentUserId()!=draft.userId)return Result.failure(workDataOf("error" to "Sign in to the account that started this upload."))
            val manager=applicationContext.getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(NotificationChannel("media_uploads","Media uploads",NotificationManager.IMPORTANCE_LOW))
            val notification=NotificationCompat.Builder(applicationContext,"media_uploads").setSmallIcon(android.R.drawable.stat_sys_upload)
                .setContentTitle("Sending media").setContentText("${draft.files.size} attachment(s)").setOngoing(true)
                .addAction(android.R.drawable.ic_delete,"Cancel",WorkManager.getInstance(applicationContext).createCancelPendingIntent(this.id)).build()
            setForeground(if(Build.VERSION.SDK_INT>=29) ForegroundInfo(id.hashCode(),notification,ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC) else ForegroundInfo(id.hashCode(),notification))
            for(index in draft.files.indices){
                kotlinx.coroutines.currentCoroutineContext().ensureActive()
                if(container.session.currentUserId()!=draft.userId)error("Your account changed. Upload stopped.")
                val item=draft.files[index]
                if(item.mediaId==null){
                    val uploaded=container.uploader.uploadFile(File(item.path),item.mime,onStage={phase->
                        setProgressAsync(workDataOf("phase" to phase,"item" to (index+1),"total" to draft.files.size))
                    }){percent->
                        setProgressAsync(workDataOf("phase" to "uploading","percent" to ((index*100+percent)/draft.files.size),"item" to (index+1),"total" to draft.files.size))
                    }
                    draft=draft.copy(files=draft.files.mapIndexed { i,f->if(i==index)f.copy(mediaId=uploaded.mediaId)else f })
                    withContext(Dispatchers.IO){MediaUploadQueue.save(applicationContext,draft)}
                }
            }
            kotlinx.coroutines.currentCoroutineContext().ensureActive()
            if(container.session.currentUserId()!=draft.userId)error("Your account changed. Upload stopped.")
            setProgress(workDataOf("phase" to "sending"))
            container.repo.sendAttachment(draft.conversationId,draft.files.map{it.mediaId!!},draft.caption,
                type=if(draft.files.all{it.mime.startsWith("video/")})"video" else "image",nonce=draft.id,isSpoiler=draft.spoiler,attachmentCaptions=draft.files.map{it.caption})
            withContext(Dispatchers.IO){File(applicationContext.noBackupFilesDir,"uploads/$id").deleteRecursively()}
            return Result.success()
        }catch(e:kotlinx.coroutines.CancellationException){throw e}
        catch(e:Exception){return Result.failure(workDataOf("error" to uploadFailureMessage(e)))}
    }
}

internal fun uploadFailureMessage(error:Exception):String = when(error){
    is java.net.ConnectException, is java.net.UnknownHostException -> "Couldn’t reach the upload server. Your media is saved; tap Retry when it’s available."
    is java.net.SocketTimeoutException -> "The upload connection timed out. Your media is saved; tap Retry."
    is java.io.IOException -> "The upload was interrupted. Your media is saved; tap Retry."
    is ApiException -> when(error.status){
        401 -> "Sign in again to finish this upload."
        403 -> "You no longer have permission to send here."
        413 -> "This attachment is too large. Choose a smaller file."
        429 -> "Too many uploads. Wait a moment, then tap Retry."
        else -> "The server couldn’t finish this upload. Your media is saved; tap Retry."
    }
    else -> "Couldn’t finish this upload. Your media is saved; tap Retry."
}
