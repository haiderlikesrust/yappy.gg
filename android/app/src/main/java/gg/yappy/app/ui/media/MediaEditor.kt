package gg.yappy.app.ui.media

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.drawable.BitmapDrawable
import android.media.MediaMetadataRetriever
import android.net.Uri
import androidx.core.content.FileProvider
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.effect.Presentation
import androidx.media3.transformer.*
import coil.imageLoader
import coil.request.ImageRequest
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import java.io.File
import java.util.UUID
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

data class MediaEdit(val turns:Int=0,val cropRatio:Float=0f,val cropX:Float=0.5f,val cropY:Float=0.5f,val text:String="",val hd:Boolean=false,val startMs:Long=0,val endMs:Long=0,val mute:Boolean=false,val sticker:Boolean=false)

object MediaEditor {
    fun video(context:Context,uri:Uri)=context.contentResolver.getType(uri)?.startsWith("video/")==true||uri.toString().endsWith(".mp4")
    suspend fun duration(context:Context,uri:Uri):Long=withContext(Dispatchers.IO){MediaMetadataRetriever().use{it.setDataSource(context,uri);it.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull()?:0}}
    private fun output(context:Context,extension:String)=File(context.cacheDir,"shared/${UUID.randomUUID()}.$extension").also{it.parentFile?.mkdirs()}
    private fun uri(context:Context,file:File)=FileProvider.getUriForFile(context,"${context.packageName}.files",file)
    suspend fun render(context:Context,source:Uri,edit:MediaEdit):Uri {
        if(video(context,source))return renderVideo(context,source,edit)
        return withContext(Dispatchers.IO){
            val loaded=context.imageLoader.execute(ImageRequest.Builder(context).data(source).size(if(edit.hd)4096 else 2048).allowHardware(false).build())
            val bitmap=(loaded.drawable as? BitmapDrawable)?.bitmap?:error("Couldn’t open this photo")
            val rotated=Bitmap.createBitmap(bitmap,0,0,bitmap.width,bitmap.height,Matrix().apply{postRotate(edit.turns*90f)},true)
            val ratio=if(edit.sticker)1f else edit.cropRatio
            val width=if(ratio>0)minOf(rotated.width,(rotated.height*ratio).toInt())else rotated.width
            val height=if(ratio>0)minOf(rotated.height,(width/ratio).toInt())else rotated.height
            val left=((rotated.width-width)*edit.cropX).toInt();val top=((rotated.height-height)*edit.cropY).toInt()
            val cropped=Bitmap.createBitmap(rotated,left,top,width.coerceAtLeast(1),height.coerceAtLeast(1))
            val target=if(edit.sticker)Bitmap.createScaledBitmap(cropped,512,512,true)else cropped
            val writable=target.copy(Bitmap.Config.ARGB_8888,true)
            if(edit.text.isNotBlank()){
                val paint=Paint(Paint.ANTI_ALIAS_FLAG).apply{color=android.graphics.Color.WHITE;textAlign=Paint.Align.CENTER;isFakeBoldText=true;textSize=writable.width*0.075f;setShadowLayer(5f,0f,2f,android.graphics.Color.BLACK)}
                while(paint.measureText(edit.text)>writable.width*0.9f)paint.textSize*=0.9f
                Canvas(writable).drawText(edit.text,writable.width/2f,writable.height*0.91f,paint)
            }
            val file=output(context,if(edit.sticker)"png"else "jpg")
            file.outputStream().use{check(writable.compress(if(edit.sticker)Bitmap.CompressFormat.PNG else Bitmap.CompressFormat.JPEG,if(edit.hd)95 else 82,it))}
            writable.recycle();uri(context,file)
        }
    }
    @androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
    private suspend fun renderVideo(context:Context,source:Uri,edit:MediaEdit):Uri=withContext(Dispatchers.Main){
        val file=output(context,"mp4")
        suspendCancellableCoroutine { continuation ->
            val clip=MediaItem.ClippingConfiguration.Builder().setStartPositionMs(edit.startMs).apply{if(edit.endMs>edit.startMs)setEndPositionMs(edit.endMs)}.build()
            val item=EditedMediaItem.Builder(MediaItem.Builder().setUri(source).setClippingConfiguration(clip).build())
                .setRemoveAudio(edit.mute).setEffects(Effects(emptyList(),listOf(Presentation.createForHeight(if(edit.hd)1080 else 720)))).build()
            val transformer=Transformer.Builder(context).setVideoMimeType(MimeTypes.VIDEO_H264).setAudioMimeType(MimeTypes.AUDIO_AAC)
                .addListener(object:Transformer.Listener{
                    override fun onCompleted(composition:Composition,result:ExportResult){if(continuation.isActive)continuation.resume(uri(context,file))}
                    override fun onError(composition:Composition,result:ExportResult,error:ExportException){file.delete();if(continuation.isActive)continuation.resumeWithException(error)}
                }).build()
            continuation.invokeOnCancellation{android.os.Handler(android.os.Looper.getMainLooper()).post{transformer.cancel();file.delete()}}
            try{transformer.start(item,file.path)}catch(e:Exception){file.delete();if(continuation.isActive)continuation.resumeWithException(e)}
        }
    }
}
